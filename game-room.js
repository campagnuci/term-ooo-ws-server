import { DurableObject } from "cloudflare:workers";

/**
 * GameRoom - Durable Object para salas multiplayer do Termo.
 *
 * Cada sala é uma instância isolada (idFromName(`room:<CODE>`)).
 * O servidor é autoridade sobre: membros, host, modo, seed e roundId.
 * O HOST (navegador) é a fonte da verdade do estado do jogo: ele roda o
 * engine localmente e transmite o GameState a cada tentativa aceita. O
 * servidor apenas RETRANSMITE + PERSISTE esse snapshot (para late joiners /
 * reconexões). O servidor NUNCA conhece a palavra — apenas (mode, seed),
 * e os clientes derivam a palavra do dicionário embutido via getDailyWords.
 *
 * Estado canônico fica em DO storage (sobrevive à hibernação). Os Maps em
 * memória são reconstruídos vazios ao acordar, então NÃO são fonte da verdade.
 * A busca de sockets por usuário é feita iterando ctx.getWebSockets() e lendo
 * o attachment (que persiste na hibernação).
 */
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.MAX_MESSAGE_SIZE = 4096;

    // Modos válidos e tentativas máximas (espelha mode-config do frontend).
    this.VALID_MODES = new Set(["termo", "dueto", "quarteto"]);

    // Anti-spam (apenas para mensagens de chat; tentativas não são limitadas).
    this.SPAM_CONFIG = {
      WINDOW_MS: 10_000,
      MAX_MESSAGES: 10,
      MIN_INTERVAL_MS: 250,
      MAX_REPEATED: 3,
      BASE_MUTE_MS: 5_000,
      MAX_MUTE_MS: 60_000,
    };
    this.spamState = new Map();
  }

  // ---------------------------------------------------------------------------
  // Storage helpers (estado canônico)
  // ---------------------------------------------------------------------------

  async getRoom() {
    return (await this.ctx.storage.get("room")) || null;
  }

  async putRoom(room) {
    await this.ctx.storage.put("room", room);
  }

  async getGameState() {
    return (await this.ctx.storage.get("gameState")) || null;
  }

  async putGameState(gameState) {
    await this.ctx.storage.put("gameState", gameState);
  }

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  now() {
    return new Date().toISOString();
  }

  generateSeed() {
    // Inteiro positivo grande usado como "dayNumber" pelo getDailyWords.
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }

  extractCode(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ['room','CODE']
    const raw = parts[1] || "";
    return raw.toUpperCase();
  }

  memberCount(room) {
    return room && Array.isArray(room.members) ? room.members.length : 0;
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify({ timestamp: this.now(), ...obj }));
    } catch (error) {
      console.error("[GameRoom] erro ao enviar:", error);
    }
  }

  broadcast(obj, exclude = null) {
    const payload = JSON.stringify({ timestamp: this.now(), ...obj });
    for (const ws of this.ctx.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      const data = ws.deserializeAttachment();
      if (!data || !data.authenticated) continue;
      try {
        ws.send(payload);
      } catch (error) {
        console.error("[GameRoom] erro no broadcast:", error);
      }
    }
  }

  // Sockets autenticados de um userId (exceto opcionalmente `exceptWs`).
  socketsForUser(userId, exceptWs = null) {
    const result = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (exceptWs && ws === exceptWs) continue;
      const data = ws.deserializeAttachment();
      if (data && data.authenticated && data.userId === userId) {
        result.push(ws);
      }
    }
    return result;
  }

  // Garante 1 socket por userId: fecha conexões antigas duplicadas.
  enforceUniqueConnection(userId, keepWs) {
    for (const ws of this.socketsForUser(userId, keepWs)) {
      try {
        this.send(ws, {
          type: "session-replaced",
          message: "Sua sessão foi substituída por uma nova conexão",
        });
        ws.close(1000, "Session replaced by new connection");
      } catch (error) {
        console.error("[GameRoom] erro ao substituir sessão:", error);
      }
    }
  }

  roomStatePayload(room, userId) {
    return {
      type: "room-state",
      code: room.code,
      hostUserId: room.hostUserId,
      isHost: room.hostUserId === userId,
      mode: room.mode,
      seed: room.seed,
      roundId: room.roundId,
      members: room.members.map((m) => ({ userId: m.userId, nickname: m.nickname })),
      memberCount: this.memberCount(room),
    };
  }

  // ---------------------------------------------------------------------------
  // Anti-spam (chat)
  // ---------------------------------------------------------------------------

  checkSpam(userId, text) {
    const now = Date.now();
    let state = this.spamState.get(userId);
    if (!state) {
      state = { messages: [], lastMessageAt: 0, infractions: 0, mutedUntil: 0 };
    }

    if (state.mutedUntil && now < state.mutedUntil) {
      return { ok: false, reason: "muted", retryAfterMs: state.mutedUntil - now };
    }

    state.messages = state.messages.filter(
      (m) => now - m.ts <= this.SPAM_CONFIG.WINDOW_MS
    );

    if (now - state.lastMessageAt < this.SPAM_CONFIG.MIN_INTERVAL_MS) {
      state.infractions++;
    }

    const normalized = text.toLowerCase();
    state.messages.push({ ts: now, text: normalized });
    state.lastMessageAt = now;

    if (state.messages.length > this.SPAM_CONFIG.MAX_MESSAGES) state.infractions++;
    const repeated = state.messages.filter((m) => m.text === normalized).length;
    if (repeated > this.SPAM_CONFIG.MAX_REPEATED) state.infractions++;

    let mutedNow = false;
    let muteMs = 0;
    if (state.infractions > 0) {
      muteMs = Math.min(
        this.SPAM_CONFIG.BASE_MUTE_MS * state.infractions,
        this.SPAM_CONFIG.MAX_MUTE_MS
      );
      if (muteMs > 0) {
        state.mutedUntil = now + muteMs;
        mutedNow = true;
      }
    }

    this.spamState.set(userId, state);

    if (mutedNow) return { ok: false, reason: "spam", retryAfterMs: muteMs };
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Conexão
  // ---------------------------------------------------------------------------

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const connectionId = crypto.randomUUID();
    const code = this.extractCode(request);

    server.serializeAttachment({
      connectionId,
      code,
      userId: null,
      nickname: null,
      authenticated: false,
      connectedAt: this.now(),
    });

    this.send(server, {
      type: "request-auth",
      message: "Identifique-se para entrar na sala",
      connectionId,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      if (message.length > this.MAX_MESSAGE_SIZE) {
        this.send(ws, {
          type: "error",
          code: "MESSAGE_TOO_LARGE",
          message: `Mensagem muito grande. Máximo: ${this.MAX_MESSAGE_SIZE} bytes`,
        });
        return;
      }

      const userData = ws.deserializeAttachment();

      let data;
      try {
        data = JSON.parse(message);
      } catch {
        data = { type: "message", text: message };
      }

      switch (data.type) {
        case "join":
          await this.handleJoin(ws, userData, data);
          break;
        case "message":
          await this.handleChat(ws, userData, data);
          break;
        case "game-state":
          await this.handleGameState(ws, userData, data);
          break;
        case "live-input":
          await this.handleLiveInput(ws, userData, data);
          break;
        case "new-round":
          await this.handleNewRound(ws, userData, data);
          break;
        case "get-room-state":
          await this.handleGetRoomState(ws, userData);
          break;
        case "ping":
          await this.handlePing(ws, userData, data);
          break;
        default:
          this.send(ws, {
            type: "error",
            code: "UNKNOWN_TYPE",
            message: `Tipo de mensagem desconhecido: ${data.type}`,
          });
      }
    } catch (error) {
      console.error("[GameRoom] erro ao processar mensagem:", error);
      this.send(ws, { type: "error", message: "Erro ao processar mensagem" });
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async handleJoin(ws, userData, data) {
    const userId = (data.userId || "").trim();
    const nickname = (data.nickname || "").trim();
    const intent = data.intent === "create" ? "create" : "join";

    if (!userId) {
      this.send(ws, { type: "error", code: "NOT_AUTHENTICATED", message: "userId é obrigatório" });
      return;
    }
    if (!nickname || nickname.length < 2 || nickname.length > 20) {
      this.send(ws, {
        type: "error",
        code: "INVALID_NICKNAME",
        message: "Apelido deve ter entre 2 e 20 caracteres",
      });
      return;
    }

    let room = await this.getRoom();
    const code = userData.code;

    // Detecta reconexão: userId já é membro de uma sala ativa.
    const existingMember =
      room && !room.closed && room.members.find((m) => m.userId === userId);

    if (intent === "create" && !existingMember) {
      if (room && room.created && !room.closed) {
        this.send(ws, {
          type: "error",
          code: "ROOM_EXISTS",
          message: "Esta sala já existe. Gere outro código.",
        });
        return;
      }
      const mode = this.VALID_MODES.has(data.mode) ? data.mode : "termo";
      room = {
        created: true,
        closed: false,
        code,
        hostUserId: userId,
        mode,
        seed: this.generateSeed(),
        roundId: crypto.randomUUID(),
        members: [{ userId, nickname, joinedAt: this.now() }],
      };
      await this.putRoom(room);
      await this.putGameState(null);
    } else {
      // intent === 'join' (ou create numa sala já existente onde já é membro)
      if (!room || !room.created) {
        this.send(ws, {
          type: "error",
          code: "ROOM_NOT_FOUND",
          message: "Sala não encontrada. Verifique o código.",
        });
        return;
      }
      if (room.closed) {
        this.send(ws, {
          type: "error",
          code: "ROOM_CLOSED",
          message: "Esta sala foi encerrada.",
        });
        return;
      }

      if (!existingMember) {
        // Apelido único dentro da sala (case-insensitive).
        const clash = room.members.find(
          (m) => m.userId !== userId && m.nickname.toLowerCase() === nickname.toLowerCase()
        );
        if (clash) {
          this.send(ws, {
            type: "error",
            code: "NICKNAME_TAKEN",
            message: `O apelido "${nickname}" já está em uso nesta sala.`,
          });
          return;
        }
        room.members.push({ userId, nickname, joinedAt: this.now() });
        await this.putRoom(room);
      }
    }

    const isReconnect = !!existingMember;

    // Autentica este socket.
    userData.userId = userId;
    userData.nickname = nickname;
    userData.authenticated = true;
    ws.serializeAttachment(userData);

    // 1 socket por usuário.
    this.enforceUniqueConnection(userId, ws);

    // Snapshot de estado para o cliente que entrou/reconectou.
    this.send(ws, this.roomStatePayload(room, userId));

    const gameState = await this.getGameState();
    if (gameState) {
      this.send(ws, {
        type: "game-state",
        roundId: room.roundId,
        hostUserId: room.hostUserId,
        gameState,
      });
    }

    // Notifica os demais apenas em entrada nova (não em reconexão).
    if (!isReconnect) {
      this.broadcast(
        {
          type: "user-joined",
          userId,
          nickname,
          members: room.members.map((m) => ({ userId: m.userId, nickname: m.nickname })),
          memberCount: this.memberCount(room),
        },
        ws
      );
    }
  }

  async handleChat(ws, userData, data) {
    if (!userData.authenticated) {
      this.send(ws, {
        type: "error",
        code: "NOT_AUTHENTICATED",
        message: "Entre na sala antes de enviar mensagens",
      });
      return;
    }

    const text = (data.text || "").trim();
    if (!text) {
      this.send(ws, { type: "error", message: "Mensagem vazia" });
      return;
    }

    const spam = this.checkSpam(userData.userId, text);
    if (!spam.ok) {
      this.send(ws, {
        type: "error",
        code: spam.reason === "muted" ? "USER_MUTED" : "SPAM_DETECTED",
        message:
          spam.reason === "muted"
            ? "Você está temporariamente bloqueado por excesso de mensagens."
            : "Comportamento de spam detectado. Você foi bloqueado temporariamente.",
        retryAfterMs: spam.retryAfterMs,
      });
      return;
    }

    const room = await this.getRoom();
    this.broadcast({
      type: "chat-message",
      text,
      nickname: userData.nickname,
      userId: userData.userId,
      connectionId: userData.connectionId,
      memberCount: this.memberCount(room),
    });
  }

  async handleGameState(ws, userData, data) {
    if (!userData.authenticated) {
      this.send(ws, { type: "error", code: "NOT_AUTHENTICATED", message: "Não autenticado" });
      return;
    }
    const room = await this.getRoom();
    if (!room) return;

    if (userData.userId !== room.hostUserId) {
      this.send(ws, {
        type: "error",
        code: "NOT_HOST",
        message: "Apenas o anfitrião pode jogar.",
      });
      return;
    }
    if (data.roundId !== room.roundId) {
      this.send(ws, {
        type: "error",
        code: "ROUND_ID_MISMATCH",
        message: "Rodada desatualizada.",
      });
      return;
    }
    if (!data.gameState || typeof data.gameState !== "object") {
      this.send(ws, { type: "error", message: "gameState inválido" });
      return;
    }

    await this.putGameState(data.gameState);

    // Retransmite para os demais (o host já tem o estado localmente).
    this.broadcast(
      {
        type: "game-state",
        roundId: room.roundId,
        hostUserId: room.hostUserId,
        gameState: data.gameState,
      },
      ws
    );
  }

  async handleLiveInput(ws, userData, data) {
    // Feedback efêmero de digitação: o host transmite o palpite parcial e o
    // servidor apenas RETRANSMITE para os demais (não persiste).
    if (!userData.authenticated) return;
    const room = await this.getRoom();
    if (!room) return;
    if (userData.userId !== room.hostUserId) return; // só o host digita
    if (data.roundId !== room.roundId) return; // rodada desatualizada

    this.broadcast(
      {
        type: "live-input",
        currentGuess: Array.isArray(data.currentGuess) ? data.currentGuess : [],
        typedIndex: typeof data.typedIndex === "number" ? data.typedIndex : -1,
        roundId: room.roundId,
      },
      ws
    );
  }

  async handleNewRound(ws, userData, data) {
    if (!userData.authenticated) {
      this.send(ws, { type: "error", code: "NOT_AUTHENTICATED", message: "Não autenticado" });
      return;
    }
    const room = await this.getRoom();
    if (!room) return;

    if (userData.userId !== room.hostUserId) {
      this.send(ws, {
        type: "error",
        code: "NOT_HOST",
        message: "Apenas o anfitrião pode iniciar uma nova rodada.",
      });
      return;
    }

    const modeChanged = this.VALID_MODES.has(data.mode) && data.mode !== room.mode;
    if (this.VALID_MODES.has(data.mode)) {
      room.mode = data.mode;
    }
    room.seed = this.generateSeed();
    room.roundId = crypto.randomUUID();
    await this.putRoom(room);
    await this.putGameState(null);

    this.broadcast({
      type: "new-round",
      mode: room.mode,
      seed: room.seed,
      roundId: room.roundId,
      hostUserId: room.hostUserId,
      modeChanged,
    });
  }

  async handleGetRoomState(ws, userData) {
    const room = await this.getRoom();
    if (!room) {
      this.send(ws, { type: "error", code: "ROOM_NOT_FOUND", message: "Sala não encontrada" });
      return;
    }
    this.send(ws, this.roomStatePayload(room, userData.userId));
    const gameState = await this.getGameState();
    if (gameState) {
      this.send(ws, {
        type: "game-state",
        roundId: room.roundId,
        hostUserId: room.hostUserId,
        gameState,
      });
    }
  }

  async handlePing(ws, userData, data) {
    const room = await this.getRoom();
    this.send(ws, {
      type: "pong",
      time: data.time,
      connectionId: userData.connectionId,
      memberCount: this.memberCount(room),
    });
  }

  // ---------------------------------------------------------------------------
  // Saída / desconexão
  // ---------------------------------------------------------------------------

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      const userData = ws.deserializeAttachment();

      if (userData && userData.authenticated && userData.userId) {
        // Se ainda existe outro socket para o mesmo usuário, esta foi uma
        // conexão substituída/duplicada — não removemos o membro.
        const others = this.socketsForUser(userData.userId, ws);
        if (others.length === 0) {
          await this.handleMemberLeave(userData.userId);
        }
      }
    } catch (error) {
      console.error("[GameRoom] erro no close:", error);
    } finally {
      const validCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
      try {
        ws.close(validCode, "Durable Object fechando WebSocket");
      } catch {
        // já fechado
      }
    }
  }

  async handleMemberLeave(userId) {
    const room = await this.getRoom();
    if (!room || room.closed) return;

    const member = room.members.find((m) => m.userId === userId);
    if (!member) return;

    room.members = room.members.filter((m) => m.userId !== userId);

    // Último membro: encerra a sala.
    if (room.members.length === 0) {
      room.closed = true;
      await this.putRoom(room);
      return;
    }

    const wasHost = room.hostUserId === userId;
    let newHost = null;
    if (wasHost) {
      // Promove o membro mais antigo (menor joinedAt).
      newHost = room.members
        .slice()
        .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1))[0];
      room.hostUserId = newHost.userId;
    }

    await this.putRoom(room);

    // Notifica saída.
    this.broadcast({
      type: "user-left",
      userId,
      nickname: member.nickname,
      members: room.members.map((m) => ({ userId: m.userId, nickname: m.nickname })),
      memberCount: this.memberCount(room),
    });

    // Notifica troca de host.
    if (newHost) {
      this.broadcast({
        type: "new-host",
        userId: newHost.userId,
        nickname: newHost.nickname,
      });
      for (const hostWs of this.socketsForUser(newHost.userId)) {
        this.send(hostWs, {
          type: "you-are-host",
          message: "Você agora é o anfitrião da sala!",
        });
      }
    }
  }

  async webSocketError(ws, error) {
    console.error("[GameRoom] erro no WebSocket:", error);
  }
}
