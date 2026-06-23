/**
 * Worker - Ponto de entrada para requisições WebSocket
 *
 * O Worker valida requisições e faz proxy para o Durable Object.
 * Isso evita cobranças no Durable Object por requisições inválidas.
 *
 * Referência: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 */

// Importa e exporta os Durable Objects
export { WebSocketHibernationServer } from './websocket-server.js';
export { GameRoom } from './game-room.js';

// Código de sala: 4 a 6 caracteres alfanuméricos maiúsculos
const ROOM_CODE_REGEX = /^[A-Z0-9]{4,6}$/;

export default {
  async fetch(request, env, ctx) {
    // Valida se é uma requisição WebSocket
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Esperado header Upgrade: websocket", {
        status: 426,
        statusText: "Upgrade Required",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    // Validação de Origin para segurança
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    // Lista de origins permitidas
    const allowedOrigins = [
      "https://termo.enresshou.dev",
      "http://localhost:5175"
    ];

    // Em desenvolvimento (wrangler dev), permitir origens locais
    const isDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    if (origin && !isDev) {
      const isAllowed = allowedOrigins.some(allowed => origin.startsWith(allowed));
      if (!isAllowed) {
        return new Response("Origin não autorizada", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
    }

    // Roteamento por caminho:
    //   /room/<CODE>  -> Durable Object de sala multiplayer (GameRoom)
    //   qualquer outro -> chat global (WebSocketHibernationServer)
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts[0] === "room") {
      const code = (pathParts[1] || "").toUpperCase();
      if (!ROOM_CODE_REGEX.test(code)) {
        return new Response("Código de sala inválido", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const roomId = env.GAME_ROOM.idFromName(`room:${code}`);
      const roomStub = env.GAME_ROOM.get(roomId);
      return roomStub.fetch(request);
    }

    // Chat global: sala única, todas as conexões vão para a mesma instância.
    const durableObjectId = env.WEBSOCKET_HIBERNATION_SERVER.idFromName("global-chat");
    const durableObjectStub = env.WEBSOCKET_HIBERNATION_SERVER.get(durableObjectId);

    // Faz proxy da requisição para o Durable Object
    // O DO aceitará a conexão e retornará o lado cliente
    return durableObjectStub.fetch(request);
  },
};
