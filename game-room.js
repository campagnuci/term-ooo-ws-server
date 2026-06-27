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
    this.MAX_ATTEMPTS = { termo: 6, dueto: 7, quarteto: 9 };

    // Tipos de sala válidos (escolhidos na criação, fixos durante a vida da sala).
    this.VALID_GAME_TYPES = new Set(["coop", "competition", "timetrial"]);

    // Time Trial: limites do tempo escolhido pelo host e padrão.
    this.TIMETRIAL_MIN_MS = 30_000; // 30s
    this.TIMETRIAL_MAX_MS = 15 * 60_000; // 15min
    this.TIMETRIAL_DEFAULT_MS = 120_000; // 2min

    // Partidas com múltiplas rodadas (competição e Time Trial). A pontuação
    // acumula a cada rodada; ao fim de todas, o ranking final é congelado.
    this.DEFAULT_ROUNDS = 5;
    this.MAX_ROUNDS = 20;
    // Contagem regressiva antes de CADA rodada (início e entre rodadas). O
    // relógio/pontos só começam ao fim dela: `roundStartedAt` é ancorado no
    // futuro (now + COUNTDOWN_MS), então o Time Trial não consome tempo durante
    // a animação e ninguém é pego de surpresa.
    this.COUNTDOWN_MS = 5_000;
    // Penalidade de quem não resolve uma rodada de Competição: tempo do solver
    // mais lento da rodada + este valor.
    this.COMPETITION_DNF_PENALTY_MS = 60_000;

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
    const comp = room.competition;
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
      gameType: room.gameType || "coop",
      matchStatus: comp ? comp.status : "idle",
      // standings = ranking ACUMULADO (rodadas concluídas). roundFinishers = quem
      // já terminou a rodada CORRENTE (status ⏳/✅/💀 ao vivo).
      standings: comp ? comp.cumulative || [] : [],
      roundFinishers: comp ? comp.finishers || [] : [],
      round: comp ? comp.currentRound || 0 : 0,
      totalRounds: comp ? comp.totalRounds || 0 : 0,
      // Momento (epoch servidor) em que a rodada corrente começa de fato. Se está
      // no futuro, os clientes mostram a contagem regressiva.
      startsAt: comp && comp.status === "active" ? room.roundStartedAt : null,
      competitorIds: comp && Array.isArray(comp.competitors)
        ? comp.competitors.map((c) => c.userId)
        : [],
      timer: this.roundTimer(room),
    };
  }

  // ---------------------------------------------------------------------------
  // Cronômetro da rodada (autoridade do servidor)
  //
  // O servidor marca quando a rodada começou/terminou (epoch ms) e envia um
  // bloco `timer` junto das mensagens relevantes. Os clientes ancoram o início
  // no PRÓPRIO relógio via `elapsedMs` (now - elapsedMs), evitando problemas de
  // skew entre relógios; o valor final congelado (`durationMs`) é idêntico para
  // todos. Sem broadcasts por segundo: o tique é local em cada cliente.
  // ---------------------------------------------------------------------------

  roundTimer(room) {
    const startedAt =
      room && typeof room.roundStartedAt === "number" ? room.roundStartedAt : null;
    const endedAt =
      room && typeof room.roundEndedAt === "number" ? room.roundEndedAt : null;
    const now = Date.now();
    return {
      startedAt,
      endedAt,
      // Tempo decorrido no instante do envio (cliente ancora no próprio relógio).
      elapsedMs: startedAt != null ? Math.max(0, (endedAt ?? now) - startedAt) : null,
      // Duração final congelada (idêntica para todos) quando a rodada terminou.
      durationMs:
        startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null,
      // Limite de tempo (Time Trial) — o cliente mostra contagem regressiva. null nos demais modos.
      limitMs: room && typeof room.timeLimitMs === "number" ? room.timeLimitMs : null,
      serverNow: now,
    };
  }

  // Tipos "competitivos": cada jogador joga o próprio tabuleiro e reporta o fim.
  isCompetitive(room) {
    return !!room && (room.gameType === "competition" || room.gameType === "timetrial");
  }

  /**
   * Pontuação do Time Trial (somente quem resolve pontua):
   *   pontos = 1000 (base) + tempo restante (até +1000) + 150 por tentativa não usada.
   * Mais tempo restante e menos tentativas usadas ⇒ mais pontos.
   * Não-solvers (esgotaram tentativas ou o tempo) = 0.
   */
  computePoints(room, solved, attempts, solveMs) {
    if (!solved) return 0;
    const limit = typeof room.timeLimitMs === "number" ? room.timeLimitMs : null;
    const timeLeft = limit != null && solveMs != null ? Math.max(0, limit - solveMs) : 0;
    const timeComponent = limit ? Math.round((1000 * timeLeft) / limit) : 0;
    const maxAttempts = this.MAX_ATTEMPTS[room.mode] ?? 6;
    const attemptsLeft = Math.max(0, maxAttempts - (Number.isFinite(attempts) ? attempts : 0));
    const attemptComponent = 150 * attemptsLeft;
    return 1000 + timeComponent + attemptComponent;
  }

  // Sincroniza o cronômetro com TODOS os membros (inclusive o host). Usado nas
  // transições do coop (início na 1ª ação do host; fim quando o host conclui) e
  // após troca de host. Aceita um snapshot pré-calculado para que host e
  // espectadores ancorem no MESMO instante de servidor.
  broadcastRoundTiming(room, timerSnapshot = null) {
    this.broadcast({
      type: "round-timing",
      roundId: room.roundId,
      timer: timerSnapshot ?? this.roundTimer(room),
    });
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
        case "start-match":
          await this.handleStartMatch(ws, userData, data);
          break;
        case "competitor-finished":
          await this.handleCompetitorFinished(ws, userData, data);
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
      const gameType = this.VALID_GAME_TYPES.has(data.gameType) ? data.gameType : "coop";
      const competitive = gameType === "competition" || gameType === "timetrial";
      room = {
        created: true,
        closed: false,
        code,
        hostUserId: userId,
        mode,
        seed: this.generateSeed(),
        roundId: crypto.randomUUID(),
        members: [{ userId, nickname, joinedAt: this.now() }],
        gameType,
        // Cronômetro da rodada (epoch ms). Coop: começa na 1ª ação do host.
        // Competição/Time Trial: começa no start-match. null = não iniciado/terminado.
        roundStartedAt: null,
        roundEndedAt: null,
        // Limite de tempo (Time Trial), definido a cada start-match. null nos demais.
        timeLimitMs: null,
        // Estado da partida (competição e Time Trial compartilham o mesmo formato).
        competition: competitive ? { status: "idle", finishers: [] } : null,
      };
      // Escrita atômica (room + gameState) para não deixar estado inconsistente.
      await this.ctx.storage.put({ room, gameState: null });
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
        timer: this.roundTimer(room),
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

    // Competição e Time Trial não usam o tabuleiro compartilhado do host.
    if (this.isCompetitive(room)) return;

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

    // Cronômetro do coop: inicia na 1ª ação do host (fallback caso não tenha
    // havido live-input) e congela quando o host conclui a rodada.
    let timingChanged = false;
    if (room.roundStartedAt == null) {
      room.roundStartedAt = Date.now();
      timingChanged = true;
    }
    if (data.gameState.isGameOver && room.roundEndedAt == null) {
      // Garante duração >= 1ms mesmo se início e fim caem no mesmo instante
      // (ex.: 1ª mensagem já é game-over, sem live-input prévio).
      room.roundEndedAt = Math.max(Date.now(), room.roundStartedAt + 1);
      timingChanged = true;
    }

    // Persiste room + gameState atomicamente quando o cronômetro muda, evitando
    // estado inconsistente (roundStartedAt salvo mas gameState antigo) caso o DO
    // seja despejado entre as duas escritas.
    if (timingChanged) {
      await this.ctx.storage.put({ room, gameState: data.gameState });
    } else {
      await this.putGameState(data.gameState);
    }

    // Snapshot único do cronômetro: host e espectadores ancoram no mesmo instante.
    const timer = this.roundTimer(room);

    // Retransmite para os demais (o host já tem o estado localmente).
    // Quando o cronômetro mudou, o broadcastRoundTiming abaixo já sincroniza
    // todos — então omitimos o timer aqui para evitar duplicidade.
    this.broadcast(
      {
        type: "game-state",
        roundId: room.roundId,
        hostUserId: room.hostUserId,
        gameState: data.gameState,
        ...(timingChanged ? {} : { timer }),
      },
      ws
    );

    // Sincroniza início/fim com TODOS (inclui o host, que não recebe o broadcast acima).
    if (timingChanged) this.broadcastRoundTiming(room, timer);
  }

  async handleLiveInput(ws, userData, data) {
    // Feedback efêmero de digitação: o host transmite o palpite parcial e o
    // servidor apenas RETRANSMITE para os demais (não persiste).
    if (!userData.authenticated) return;
    const room = await this.getRoom();
    if (!room) return;
    if (userData.userId !== room.hostUserId) return; // só o host digita
    if (data.roundId !== room.roundId) return; // rodada desatualizada

    // 1ª tecla digitada da rodada inicia o cronômetro do coop e sincroniza todos.
    if (room.roundStartedAt == null) {
      room.roundStartedAt = Date.now();
      await this.putRoom(room);
      this.broadcastRoundTiming(room);
    }

    // Sem `timer` aqui: o cronômetro é sincronizado via `round-timing` (acima,
    // na 1ª tecla) e via `room-state`/`game-state`. O cliente não consome timer
    // no live-input, então incluí-lo seria peso morto a cada tecla.
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

    // Em sala competitiva, 'new-round' (fluxo do coop) nunca deve abortar uma
    // partida multi-rodada em andamento. O fluxo competitivo usa 'start-match'.
    if (this.isCompetitive(room) && room.competition && room.competition.status === "active") {
      this.send(ws, {
        type: "error",
        code: "MATCH_IN_PROGRESS",
        message: "Uma partida já está em andamento.",
      });
      return;
    }

    const modeChanged = this.VALID_MODES.has(data.mode) && data.mode !== room.mode;
    if (this.VALID_MODES.has(data.mode)) {
      room.mode = data.mode;
    }
    room.seed = this.generateSeed();
    room.roundId = crypto.randomUUID();
    // Nova rodada: cronômetro zerado; recomeça na 1ª ação do host.
    room.roundStartedAt = null;
    room.roundEndedAt = null;
    // Defensivo: se por algum motivo um new-round chegar a uma sala
    // competitiva, zera o ranking/estado para não vazar uma partida encerrada
    // a quem reconectar antes do próximo start-match.
    if (this.isCompetitive(room) && room.competition) {
      room.competition = {
        status: "idle",
        currentRound: 0,
        totalRounds: 0,
        finishers: [],
        cumulative: [],
        competitors: [],
      };
      // Time Trial: cancela qualquer alarm pendente e limpa o limite (evita que
      // um timer obsoleto vaze para os clientes via room-state).
      if (room.gameType === "timetrial") {
        await this.ctx.storage.deleteAlarm();
        room.timeLimitMs = null;
      }
    }
    await this.ctx.storage.put({ room, gameState: null });

    this.broadcast({
      type: "new-round",
      mode: room.mode,
      seed: room.seed,
      roundId: room.roundId,
      hostUserId: room.hostUserId,
      modeChanged,
      timer: this.roundTimer(room),
    });
  }

  // ---------------------------------------------------------------------------
  // Competição
  // ---------------------------------------------------------------------------

  // Tamanho do pódio (1º, 2º e 3º lugares).
  PODIUM_SIZE = 3;

  // Regras de término de uma partida competitiva:
  //  - termina se TODOS os jogadores terminaram (acertaram ou esgotaram as
  //    tentativas); OU
  //  - termina se o pódio (1º/2º/3º) já está completo E resta apenas 1 jogador
  //    ainda tentando — não há mais medalha a conquistar, então não faz sentido
  //    deixar esse último jogador sozinho.
  // Enquanto houver vaga no pódio, os jogadores restantes continuam jogando
  // (mesmo que reste apenas 1), pois ainda podem conquistar uma medalha.
  // "Terminar" = acertar a palavra OU esgotar as tentativas. Só acertos contam
  // para o pódio; quem falha não é ranqueado.
  //
  // Time Trial: o tempo é tratado pelo `alarm()`; a partida só termina "cedo"
  // (antes do tempo) quando TODOS terminaram — não há encerramento por pódio.
  // Competidores da partida que AINDA estão na sala. O conjunto de competidores
  // é fixado no start-match (quem entra depois assiste e só joga na próxima
  // partida); quem sai tem o placar congelado e deixa de pontuar.
  activeCompetitors(room) {
    const comp = room.competition;
    if (!comp || !Array.isArray(comp.competitors)) return [];
    const memberIds = new Set(room.members.map((m) => m.userId));
    return comp.competitors.filter((c) => memberIds.has(c.userId));
  }

  // Fim da RODADA corrente (não da partida). Mesmas regras de antes, mas sobre os
  // competidores ativos:
  //  - Time Trial: termina quando todos terminaram (o `alarm()` trata o tempo).
  //  - Competição: todos terminaram OU pódio cheio e resta só 1 tentando.
  isRoundOver(room) {
    const comp = room.competition;
    if (!comp) return false;
    const finisherIds = new Set(comp.finishers.map((f) => f.userId));
    const stillTrying = this.activeCompetitors(room).filter(
      (c) => !finisherIds.has(c.userId)
    ).length;
    if (room.gameType === "timetrial") return stillTrying === 0;
    const solvedCount = comp.finishers.filter((f) => f.solved).length;
    const podiumFull = solvedCount >= this.PODIUM_SIZE;
    return stillTrying === 0 || (stillTrying === 1 && podiumFull);
  }

  // Acumula o resultado da rodada corrente no ranking da partida (comp.cumulative).
  //  - Time Trial: soma os pontos da rodada (DNF = 0); maior total vence.
  //  - Competição: soma o TEMPO da rodada; menor total vence. Quem não resolve
  //    recebe (tempo do solver mais lento da rodada) + penalidade. Se NINGUÉM
  //    resolve, a rodada é anulada (todos somam 0 → ranking inalterado).
  scoreRound(room) {
    const comp = room.competition;
    const isTT = room.gameType === "timetrial";
    const active = this.activeCompetitors(room);
    const finById = new Map(comp.finishers.map((f) => [f.userId, f]));

    let slowestSolverMs = null;
    if (!isTT) {
      // Baseline da penalidade = solver MAIS LENTO da rodada, considerando TODOS
      // que resolveram (inclui quem resolveu e depois saiu — o tempo dele ainda
      // serve de referência, senão a penalidade dos não-solvers ficaria menor).
      for (const f of comp.finishers) {
        if (f.solved && typeof f.solveMs === "number") {
          slowestSolverMs =
            slowestSolverMs == null ? f.solveMs : Math.max(slowestSolverMs, f.solveMs);
        }
      }
    }
    const voidRound = !isTT && slowestSolverMs == null; // ninguém resolveu

    if (!Array.isArray(comp.cumulative)) comp.cumulative = [];
    for (const c of active) {
      const f = finById.get(c.userId);
      const solved = !!(f && f.solved);

      let entry = comp.cumulative.find((e) => e.userId === c.userId);
      if (!entry) {
        entry = {
          userId: c.userId,
          nickname: c.nickname,
          totalMs: 0,
          totalPoints: 0,
          roundsSolved: 0,
          roundsPlayed: 0,
        };
        comp.cumulative.push(entry);
      }
      entry.nickname = c.nickname;
      entry.roundsPlayed += 1;
      if (solved) entry.roundsSolved += 1;

      if (isTT) {
        const pts = f && typeof f.points === "number" ? f.points : 0;
        entry.totalPoints += pts;
        if (solved && typeof f.solveMs === "number") entry.totalMs += f.solveMs;
      } else if (voidRound) {
        // rodada anulada: ninguém soma tempo
      } else if (solved && typeof f.solveMs === "number") {
        entry.totalMs += f.solveMs;
      } else {
        entry.totalMs += slowestSolverMs + this.COMPETITION_DNF_PENALTY_MS;
      }
    }
  }

  // Encerra a rodada corrente: pontua, congela o relógio e ou avança para a
  // próxima rodada (ancorando o início após o countdown) ou encerra a partida.
  // Persiste o `room`. Retorna o que precisa ser transmitido.
  async endCurrentRound(room) {
    const comp = room.competition;
    if (room.roundEndedAt == null) room.roundEndedAt = Date.now();

    const finishedRound = comp.currentRound;
    const finishedRoundFinishers = comp.finishers.slice();

    this.scoreRound(room);

    const hasMore =
      comp.currentRound < comp.totalRounds && this.activeCompetitors(room).length > 0;

    if (hasMore) {
      comp.currentRound += 1;
      comp.finishers = [];
      room.seed = this.generateSeed();
      room.roundId = crypto.randomUUID();
      // A próxima rodada começa após o countdown; o relógio do TT é ancorado lá.
      room.roundStartedAt = Date.now() + this.COUNTDOWN_MS;
      room.roundEndedAt = null;
      if (room.gameType === "timetrial" && typeof room.timeLimitMs === "number") {
        await this.ctx.storage.setAlarm(room.roundStartedAt + room.timeLimitMs);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
      await this.putRoom(room);
      return { outcome: "advanced", finishedRound, finishedRoundFinishers };
    }

    comp.status = "ended";
    if (room.gameType === "timetrial") await this.ctx.storage.deleteAlarm();
    await this.putRoom(room);
    return { outcome: "ended", finishedRound, finishedRoundFinishers };
  }

  // Transmite o resultado de uma rodada encerrada: `round-advanced` (próxima
  // rodada) ou `match-end` (partida encerrada). Em ambos, `standings` é o ranking
  // ACUMULADO já com a rodada recém-encerrada incluída.
  broadcastRoundOutcome(room, res) {
    const comp = room.competition;
    const common = {
      standings: comp.cumulative || [],
      roundFinishers: res.finishedRoundFinishers,
      finishedRound: res.finishedRound,
      totalRounds: comp.totalRounds,
      roundId: room.roundId,
      timer: this.roundTimer(room),
    };
    if (res.outcome === "advanced") {
      this.broadcast({
        type: "round-advanced",
        matchStatus: "active",
        round: comp.currentRound,
        mode: room.mode,
        seed: room.seed,
        hostUserId: room.hostUserId,
        startsAt: room.roundStartedAt,
        competitorIds: comp.competitors.map((c) => c.userId),
        ...common,
      });
    } else {
      this.broadcast({ type: "match-end", matchStatus: "ended", ...common });
    }
  }

  async handleStartMatch(ws, userData, data) {
    if (!userData.authenticated) {
      this.send(ws, { type: "error", code: "NOT_AUTHENTICATED", message: "Não autenticado" });
      return;
    }
    const room = await this.getRoom();
    if (!room) return;
    if (!this.isCompetitive(room)) {
      this.send(ws, {
        type: "error",
        code: "NOT_COMPETITION",
        message: "Esta sala não é de competição.",
      });
      return;
    }
    if (userData.userId !== room.hostUserId) {
      this.send(ws, {
        type: "error",
        code: "NOT_HOST",
        message: "Apenas o anfitrião pode iniciar a partida.",
      });
      return;
    }
    if (this.memberCount(room) < 2) {
      this.send(ws, {
        type: "error",
        code: "NOT_ENOUGH_PLAYERS",
        message: "São necessários ao menos 2 jogadores para iniciar a partida.",
      });
      return;
    }
    // Não permite reiniciar por cima de uma partida em andamento (evita descartar
    // resultados já reportados sem marcá-los e deixar jogadores órfãos).
    if (room.competition && room.competition.status === "active") {
      this.send(ws, {
        type: "error",
        code: "MATCH_IN_PROGRESS",
        message: "Uma partida já está em andamento.",
      });
      return;
    }

    if (this.VALID_MODES.has(data.mode)) room.mode = data.mode;
    room.seed = this.generateSeed();
    room.roundId = crypto.randomUUID();

    // Número de rodadas da partida (clamp 1..MAX). Competidores fixados agora:
    // quem entrar depois assiste e só joga na próxima partida.
    const requestedRounds = Math.round(Number(data.rounds));
    const totalRounds = Number.isFinite(requestedRounds)
      ? Math.min(this.MAX_ROUNDS, Math.max(1, requestedRounds))
      : this.DEFAULT_ROUNDS;
    room.competition = {
      status: "active",
      currentRound: 1,
      totalRounds,
      finishers: [],
      cumulative: [],
      competitors: room.members.map((m) => ({ userId: m.userId, nickname: m.nickname })),
    };

    // A rodada 1 começa após o countdown (igual para todos). O relógio/pontos só
    // contam a partir de `roundStartedAt` — o Time Trial não gasta tempo na contagem.
    room.roundStartedAt = Date.now() + this.COUNTDOWN_MS;
    room.roundEndedAt = null;

    // Time Trial: define o limite de tempo (clamp).
    let alarmAt = null;
    if (room.gameType === "timetrial") {
      const requested = Number(data.timeLimitMs);
      room.timeLimitMs = Number.isFinite(requested)
        ? Math.min(this.TIMETRIAL_MAX_MS, Math.max(this.TIMETRIAL_MIN_MS, Math.round(requested)))
        : this.TIMETRIAL_DEFAULT_MS;
      alarmAt = room.roundStartedAt + room.timeLimitMs;
    } else {
      room.timeLimitMs = null;
    }

    // Time Trial: arma o alarm autoritativo ANTES de persistir. Se o DO for
    // despejado entre as duas escritas, o pior caso é um alarm sem partida ativa
    // (no-op via guard de status), e não uma partida ativa sem alarm (travada).
    if (alarmAt != null) await this.ctx.storage.setAlarm(alarmAt);
    await this.ctx.storage.put({ room, gameState: null });

    this.broadcast({
      type: "match-start",
      mode: room.mode,
      seed: room.seed,
      roundId: room.roundId,
      hostUserId: room.hostUserId,
      matchStatus: "active",
      round: 1,
      totalRounds,
      startsAt: room.roundStartedAt,
      competitorIds: room.competition.competitors.map((c) => c.userId),
      standings: [],
      roundFinishers: [],
      timer: this.roundTimer(room),
    });
  }

  async handleCompetitorFinished(ws, userData, data) {
    if (!userData.authenticated) return;
    const room = await this.getRoom();
    if (!room || !this.isCompetitive(room) || !room.competition) return;
    if (room.competition.status !== "active") return;
    if (data.roundId !== room.roundId) return;

    const userId = userData.userId;

    // Só competidores fixados no start-match pontuam (quem entrou depois assiste).
    if (!this.activeCompetitors(room).some((c) => c.userId === userId)) return;

    // Antes do fim do countdown a rodada ainda não começou: ignora (evita
    // pontuar/medir tempo negativo durante a contagem regressiva).
    if (room.roundStartedAt != null && Date.now() < room.roundStartedAt) return;

    // Time Trial: o relógio do SERVIDOR é autoridade. Rejeita submissões que
    // chegam após o fim do tempo (o `alarm()` trata esse jogador como DNF) —
    // fecha a janela em que um palpite tardio (skew/latência) ainda pontuaria.
    if (
      room.gameType === "timetrial" &&
      room.roundStartedAt != null &&
      room.timeLimitMs != null &&
      Date.now() > room.roundStartedAt + room.timeLimitMs
    ) {
      return;
    }

    // Idempotente: ignora se este jogador já terminou a rodada CORRENTE.
    if (room.competition.finishers.some((f) => f.userId === userId)) return;

    const solved = !!data.solved;
    const attempts = Number.isFinite(data.attempts) ? data.attempts : 0;
    const priorSolvers = room.competition.finishers.filter((f) => f.solved).length;
    // Competição: posição pela ORDEM de acerto. Time Trial: ranqueia por PONTOS
    // (o cliente ordena), então solveRank fica null.
    const solveRank =
      room.gameType === "competition" && solved ? priorSolvers + 1 : null;
    // Tempo individual de resolução (epoch do servidor → exato, sem skew).
    const solveMs =
      room.roundStartedAt != null ? Math.max(0, Date.now() - room.roundStartedAt) : null;
    // Pontos só no Time Trial (mais tempo restante + menos tentativas = mais pontos).
    const points =
      room.gameType === "timetrial" ? this.computePoints(room, solved, attempts, solveMs) : null;

    const finisher = {
      userId,
      nickname: userData.nickname,
      solved,
      attempts,
      solveRank,
      solveMs,
      points,
      finishedAt: this.now(),
    };
    room.competition.finishers.push(finisher);

    const roundOver = this.isRoundOver(room);
    // Se a rodada não acabou, persiste já o finisher. Se acabou, o
    // endCurrentRound abaixo persiste (após pontuar) — evita escrita dupla.
    if (!roundOver) await this.putRoom(room);

    // Avisa todos que este jogador terminou a rodada corrente. `standings` é o
    // ranking ACUMULADO das rodadas já concluídas (a atual entra só ao encerrar);
    // `roundFinishers` mostra o progresso da rodada corrente (✅/💀).
    this.broadcast({
      type: "competitor-finished",
      userId,
      nickname: userData.nickname,
      solved,
      attempts,
      solveRank,
      solveMs,
      points,
      standings: room.competition.cumulative || [],
      roundFinishers: room.competition.finishers,
      round: room.competition.currentRound,
      totalRounds: room.competition.totalRounds,
      roundId: room.roundId,
      timer: this.roundTimer(room),
    });

    if (roundOver) {
      const res = await this.endCurrentRound(room);
      this.broadcastRoundOutcome(room, res);
    }
  }

  // Disparado pelo runtime quando o tempo do Time Trial esgota (setAlarm no
  // start-match). Encerra a partida de forma autoritativa: quem não terminou
  // vira DNF (0 pontos) e o ranking é congelado.
  async alarm() {
    const room = await this.getRoom();
    if (!room || room.gameType !== "timetrial" || !room.competition) return;
    if (room.competition.status !== "active") return;
    // Defensivo: o alarm é armado em (início + limite); se disparar antes do
    // início real (durante o countdown), ignora.
    if (room.roundStartedAt != null && Date.now() < room.roundStartedAt) return;

    // Quem não terminou a rodada vira DNF (0 pontos) — só competidores ativos.
    const finisherIds = new Set(room.competition.finishers.map((f) => f.userId));
    for (const c of this.activeCompetitors(room)) {
      if (finisherIds.has(c.userId)) continue;
      room.competition.finishers.push({
        userId: c.userId,
        nickname: c.nickname,
        solved: false,
        attempts: 0,
        solveRank: null,
        solveMs: null,
        points: 0,
        timedOut: true,
        finishedAt: this.now(),
      });
    }

    // Congela exatamente no fim do tempo (durationMs == timeLimitMs → 0:00).
    // Definido ANTES de endCurrentRound para preservar este instante exato.
    if (room.roundEndedAt == null) {
      room.roundEndedAt =
        room.roundStartedAt != null && room.timeLimitMs != null
          ? room.roundStartedAt + room.timeLimitMs
          : Date.now();
    }

    // Encerra a rodada: pontua e avança (próxima rodada) ou encerra a partida.
    const res = await this.endCurrentRound(room);
    this.broadcastRoundOutcome(room, res);
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
        timer: this.roundTimer(room),
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
      if (room.gameType === "timetrial") await this.ctx.storage.deleteAlarm();
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
      // Re-sincroniza o cronômetro após a troca de host (coop em andamento), para
      // que o novo host e todos os membros tenham uma âncora fresca e correta.
      if (room.gameType === "coop" && room.roundStartedAt != null) {
        this.broadcastRoundTiming(room);
      }
    }

    // Partida competitiva em andamento: a saída pode esvaziar os competidores
    // (encerra a partida) ou completar a rodada (os restantes já terminaram).
    if (this.isCompetitive(room) && room.competition && room.competition.status === "active") {
      if (this.activeCompetitors(room).length === 0) {
        room.competition.status = "ended";
        if (room.roundEndedAt == null) room.roundEndedAt = Date.now();
        if (room.gameType === "timetrial") await this.ctx.storage.deleteAlarm();
        await this.putRoom(room);
        this.broadcast({
          type: "match-end",
          matchStatus: "ended",
          standings: room.competition.cumulative || [],
          totalRounds: room.competition.totalRounds,
          roundId: room.roundId,
          timer: this.roundTimer(room),
        });
      } else if (this.isRoundOver(room)) {
        const res = await this.endCurrentRound(room);
        this.broadcastRoundOutcome(room, res);
      }
    }
  }

  async webSocketError(ws, error) {
    console.error("[GameRoom] erro no WebSocket:", error);
  }
}
