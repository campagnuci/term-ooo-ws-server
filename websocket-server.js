import { DurableObject } from "cloudflare:workers";

export class WebSocketHibernationServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.activeUsers = new Map();
    this.MAX_MESSAGE_SIZE = 4096;

    // Anti-spam config
    this.SPAM_CONFIG = {
      WINDOW_MS: 10_000,       // janela de 10s
      MAX_MESSAGES: 10,        // até 10 msg / janela
      MIN_INTERVAL_MS: 250,    // pelo menos 250ms entre msgs
      MAX_REPEATED: 3,         // mesma msg no máx 3x na janela
      BASE_MUTE_MS: 5_000,     // começa com 5s de mute
      MAX_MUTE_MS: 60_000      // no máx 60s mutado
    };

    // state de spam por usuário
    // key: userId (ou connectionId se quiser pré-auth)
    // value: { messages, lastMessageAt, infractions, mutedUntil }
    this.spamState = new Map();
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);

    const connectionId = crypto.randomUUID();

    server.serializeAttachment({
      connectionId: connectionId,
      userId: null,
      nickname: null,
      authenticated: false,
      connectedAt: new Date().toISOString()
    });

    server.send(JSON.stringify({
      type: "request-auth",
      message: "Por favor, identifique-se",
      connectionId: connectionId,
      timestamp: new Date().toISOString(),
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  getUserKey(userData) {
    // depois de autenticado, usa userId
    if (userData && userData.userId) {
      return `user:${userData.userId}`;
    }
    // fallback: connectionId (antes de auth, se quiser proteger)
    return `conn:${userData.connectionId}`;
  }

  checkSpam(userKey, text) {
    const now = Date.now();
    let state = this.spamState.get(userKey);

    if (!state) {
      state = {
        messages: [],        // { ts, text }
        lastMessageAt: 0,
        infractions: 0,
        mutedUntil: 0
      };
    }

    // Se está mutado, bloqueia
    if (state.mutedUntil && now < state.mutedUntil) {
      const retryAfterMs = state.mutedUntil - now;
      return {
        ok: false,
        reason: "muted",
        retryAfterMs
      };
    }

    // Limpa mensagens fora da janela
    state.messages = state.messages.filter(m => (now - m.ts) <= this.SPAM_CONFIG.WINDOW_MS);

    // Regra 1: intervalo mínimo entre mensagens
    if (now - state.lastMessageAt < this.SPAM_CONFIG.MIN_INTERVAL_MS) {
      state.infractions++;
    }

    // Adiciona mensagem atual ao histórico
    const normalized = text.toLowerCase();
    state.messages.push({ ts: now, text: normalized });
    state.lastMessageAt = now;

    // Regra 2: quantidade máxima na janela
    if (state.messages.length > this.SPAM_CONFIG.MAX_MESSAGES) {
      state.infractions++;
    }

    // Regra 3: repetição da mesma mensagem
    const repeatedCount = state.messages.filter(m => m.text === normalized).length;
    if (repeatedCount > this.SPAM_CONFIG.MAX_REPEATED) {
      state.infractions++;
    }

    let mutedNow = false;
    let muteMs = 0;

    // Se acumulou infrações, aplica mute progressivo
    if (state.infractions > 0) {
      // simples: exponencial ou linear
      muteMs = Math.min(
        this.SPAM_CONFIG.BASE_MUTE_MS * state.infractions,
        this.SPAM_CONFIG.MAX_MUTE_MS
      );

      if (muteMs > 0) {
        state.mutedUntil = now + muteMs;
        mutedNow = true;
      }
    }

    // Atualiza estado
    this.spamState.set(userKey, state);

    if (mutedNow) {
      return {
        ok: false,
        reason: "spam",
        retryAfterMs: muteMs
      };
    }

    return { ok: true };
  }

  enforceUniqueConnection(userId, newWs) {
    const existingWs = this.activeUsers.get(userId);

    if (existingWs && existingWs !== newWs) {
      try {
        existingWs.send(JSON.stringify({
          type: "session-replaced",
          message: "Sua sessão foi substituída por uma nova conexão",
          timestamp: new Date().toISOString(),
        }));

        existingWs.close(1000, "Session replaced by new connection");
      } catch (error) {
        console.error("Erro ao desconectar sessão antiga:", error);
      }
    }

    this.activeUsers.set(userId, newWs);
  }

  removeActiveUser(userId) {
    this.activeUsers.delete(userId);
  }

  validateMessageSize(ws, message) {
    if (message.length > this.MAX_MESSAGE_SIZE) {
      ws.send(JSON.stringify({
        type: "error",
        code: "MESSAGE_TOO_LARGE",
        message: `Mensagem muito grande. Máximo: ${this.MAX_MESSAGE_SIZE} bytes`,
        maxSize: this.MAX_MESSAGE_SIZE,
        receivedSize: message.length,
        timestamp: new Date().toISOString(),
      }));

      return false;
    }
    return true;
  }

  broadcast(data, exclude = null, onlyAuthenticated = false) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    const websockets = this.ctx.getWebSockets();

    for (const ws of websockets) {
      if (exclude && ws === exclude) {
        continue;
      }

      if (onlyAuthenticated) {
        const userData = ws.deserializeAttachment();
        if (!userData.authenticated) {
          continue;
        }
      }

      try {
        ws.send(message);
      } catch (error) {
        console.error("Erro ao enviar broadcast:", error);
      }
    }
  }

  isUserConnected(userId) {
    return this.activeUsers.has(userId);
  }

  getUniqueUsersCount() {
    const websockets = this.ctx.getWebSockets();
    const uniqueUsers = new Set();

    for (const ws of websockets) {
      const data = ws.deserializeAttachment();
      if (data.authenticated && data.userId) {
        uniqueUsers.add(data.userId);
      }
    }

    return uniqueUsers.size;
  }

  getAuthenticatedConnectionsCount() {
    const websockets = this.ctx.getWebSockets();
    let count = 0;

    for (const ws of websockets) {
      const data = ws.deserializeAttachment();
      if (data.authenticated) {
        count++;
      }
    }

    return count;
  }

  async webSocketMessage(ws, message) {
    try {
      if (!this.validateMessageSize(ws, message)) {
        return;
      }

      const userData = ws.deserializeAttachment();

      let messageData;
      try {
        messageData = JSON.parse(message);
      } catch {
        messageData = { type: "message", text: message };
      }

      switch (messageData.type) {
        case "auth":
          const userId = messageData.userId?.trim();
          const nickname = messageData.nickname?.trim();

          if (!userId) {
            ws.send(JSON.stringify({
              type: "error",
              message: "userId é obrigatório",
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          if (!nickname || nickname.length < 2 || nickname.length > 20) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Nickname deve ter entre 2 e 20 caracteres",
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          const websockets = this.ctx.getWebSockets();
          for (const otherWs of websockets) {
            if (otherWs === ws) continue;
            const otherData = otherWs.deserializeAttachment();
            if (otherData.authenticated &&
              otherData.nickname === nickname &&
              otherData.userId !== userId) {
              ws.send(JSON.stringify({
                type: "error",
                message: `Nickname "${nickname}" já está em uso por outro usuário`,
                timestamp: new Date().toISOString(),
              }));
              return;
            }
          }

          this.enforceUniqueConnection(userId, ws);

          userData.userId = userId;
          userData.nickname = nickname;
          userData.authenticated = true;
          ws.serializeAttachment(userData);

          const uniqueUsers = this.getUniqueUsersCount();
          const totalConnections = this.getAuthenticatedConnectionsCount();

          ws.send(JSON.stringify({
            type: "auth-accepted",
            message: "Bem-vindo ao Chat Global!",
            userId: userId,
            connectionId: userData.connectionId,
            nickname: nickname,
            uniqueUsers: uniqueUsers,
            totalConnections: totalConnections,
            timestamp: new Date().toISOString(),
          }));

          this.broadcast({
            type: "user-joined",
            message: `${nickname} entrou no chat`,
            nickname: nickname,
            userId: userId,
            uniqueUsers: uniqueUsers,
            totalConnections: totalConnections,
            timestamp: new Date().toISOString(),
          }, ws, true);
          break;

        case "ping":
          ws.send(JSON.stringify({
            type: "pong",
            time: messageData.time,
            connectionId: userData.connectionId,
            uniqueUsers: this.getUniqueUsersCount(),
            totalConnections: this.getAuthenticatedConnectionsCount(),
            timestamp: new Date().toISOString(),
          }));
          break;

        case "get-stats":
          ws.send(JSON.stringify({
            type: "stats",
            uniqueUsers: this.getUniqueUsersCount(),
            totalConnections: this.getAuthenticatedConnectionsCount(),
            isConnected: userData.authenticated,
            timestamp: new Date().toISOString(),
          }));
          break;

        case "message":
        default:
          if (!userData.authenticated) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Você precisa se autenticar antes de enviar mensagens",
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          const text = (messageData.text || message).trim();
          if (!text || text.length === 0) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Mensagem vazia",
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          // >>> Anti-SPAM <<<
          const userKey = this.getUserKey(userData);
          const spamCheck = this.checkSpam(userKey, text);

          if (!spamCheck.ok) {
            ws.send(JSON.stringify({
              type: "error",
              code: spamCheck.reason === "muted" ? "USER_MUTED" : "SPAM_DETECTED",
              message: spamCheck.reason === "muted"
                ? "Você está temporariamente bloqueado por enviar muitas mensagens."
                : "Detectamos comportamento de spam. Você foi temporariamente bloqueado.",
              retryAfterMs: spamCheck.retryAfterMs,
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          this.broadcast({
            type: "chat-message",
            text: text,
            nickname: userData.nickname,
            userId: userData.userId,
            connectionId: userData.connectionId,
            uniqueUsers: this.getUniqueUsersCount(),
            timestamp: new Date().toISOString(),
          }, null, true);
          break;
      }
    } catch (error) {
      console.error("Erro ao processar mensagem:", error);
      ws.send(JSON.stringify({
        type: "error",
        message: "Erro ao processar mensagem",
        timestamp: new Date().toISOString(),
      }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const userData = ws.deserializeAttachment();

    if (userData.authenticated && userData.userId) {
      this.removeActiveUser(userData.userId);

      this.broadcast({
        type: "user-left",
        message: `${userData.nickname} saiu do chat`,
        nickname: userData.nickname,
        userId: userData.userId,
        uniqueUsers: this.getUniqueUsersCount(),
        timestamp: new Date().toISOString(),
      }, ws, true);
    }

    const validCode = (code === 1005 || code === 1006 || code === 1015) ? 1000 : code;
    ws.close(validCode, "Durable Object fechando WebSocket");
  }

  async webSocketError(ws, error) {
    console.error("Erro no WebSocket:", error);
  }
}
