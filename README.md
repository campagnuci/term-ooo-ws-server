# WebSocket Server - Cloudflare Durable Objects

Servidor WebSocket em tempo real usando **Cloudflare Workers** e **Durable Objects** com **API de Hibernação**.

## ✨ Recursos

- 💬 **Chat Global** - Sala única em tempo real
- 🆔 **Identificação** - userId (cliente) + nickname obrigatório
- 🔒 **Conexão Única** - 1 userId = 1 conexão ativa
- 📡 **Broadcast** - Notificações de entrada/saída
- 🛡️ **Anti-Spam** - Detecção automática de flood e repetição
- ⚡ **Hibernação** - Economia de custos (paga apenas quando ativo)
- 🌍 **Produção** - Deploy global instantâneo

## 🏗️ Arquitetura

```
worker.js              # Validação e proxy
websocket-server.js    # Durable Object (servidor WebSocket)
client.js              # Cliente Node.js
exemplo-browser.html   # Demo browser completo
```

**Benefícios da Hibernação:**
- ✅ Economia: Durable Objects hibernam quando inativos
- ✅ Conexões persistem durante hibernação
- ✅ Reativação automática ao receber mensagens

## 🚀 Início Rápido

### Desenvolvimento Local

```bash
# Terminal 1: Servidor
pnpm dev

# Terminal 2: Cliente
pnpm client:local
```

### Deploy em Produção

```bash
# Deploy
pnpm deploy

# Testar
pnpm client
```

**URL gerada:** `wss://ws-cloudflare.<seu-subdomain>.workers.dev`

## 🎮 Usando o Cliente

```bash
# Ao conectar
Digite seu nickname: João

# Comandos
[João] > Olá pessoal!    # Envia mensagem
[João] > /ping           # Verifica latência
[João] > /stats          # Mostra estatísticas
[João] > /sair           # Encerra conexão
```

**Notificações automáticas:**
- 🟢 Usuário entrou
- 🔴 Usuário saiu
- 💬 Mensagens do chat

## 🛡️ Sistema Anti-Spam

**Detecção automática:**
- Flood (muitas mensagens rápidas)
- Repetição (mesma mensagem 3x)
- Intervalo mínimo 250ms entre mensagens

**Mute progressivo:**
- 1ª infração: 5 segundos
- Reincidência: até 60 segundos
- Reset automático após bom comportamento

## 📚 Documentação

- **[QUICKSTART.md](docs/QUICKSTART.md)** - Guia rápido detalhado
- **[RECURSOS.md](docs/RECURSOS.md)** - API completa do WebSocket
- **[INTEGRACAO.md](docs/INTEGRACAO.md)** - Guia de integração técnica

## 🔧 Como Funciona

### Worker (worker.js)
1. Valida requisições WebSocket
2. Verifica origin permitida
3. Faz proxy para Durable Object

### Durable Object (websocket-server.js)
1. Aceita conexão com `ctx.acceptWebSocket()`
2. Solicita autenticação (userId + nickname)
3. Enforce conexão única por userId
4. Processa mensagens e faz broadcast
5. Hiberna quando sem atividade

### Handlers
```javascript
webSocketMessage(ws, message)  // Processa mensagens
webSocketClose(ws, ...)        // Gerencia desconexões
webSocketError(ws, error)      // Trata erros
```

## 💡 Características Técnicas

**Identificação:**
- `userId`: Gerado pelo cliente (localStorage)
- `connectionId`: Gerado pelo servidor (único por conexão)
- `nickname`: 2-20 caracteres, definido na auth

**Conexão Única:**
- Se userId já conectado → desconecta conexão antiga
- Nova conexão recebe `auth-accepted`
- Antiga recebe `session-replaced` e desconecta

**Persistência:**
- `serializeAttachment()` mantém dados durante hibernação
- Estado em memória para performance
- Dados perdidos ao reiniciar DO (comportamento esperado)

## 🌐 Distribuindo Instâncias

Atualmente usa sala global única:
```javascript
// worker.js
const id = env.WEBSOCKET_HIBERNATION_SERVER.idFromName("global-chat");
```

Para múltiplas salas/instâncias:
```javascript
// Por sala
const id = env.WEBSOCKET_HIBERNATION_SERVER.idFromName(`room-${roomId}`);

// Por usuário
const id = env.WEBSOCKET_HIBERNATION_SERVER.idFromName(`user-${userId}`);

// ID único
const id = env.WEBSOCKET_HIBERNATION_SERVER.newUniqueId();
```

## 💰 Custos (Free Tier)

**100% gratuito para uso moderado:**
- Workers: 100.000 requests/dia
- Durable Objects: 1M requests/mês
- WebSocket: ilimitado com hibernação

**Seu uso esperado:** < 1% do Free Tier

## 🐛 Troubleshooting

**"Upgrade Required"**
```bash
# Use ws:// ou wss:// (não http://)
```

**Conexão falha local**
```bash
# Verifique se servidor está rodando
pnpm dev
```

**Deploy falha**
```bash
# Autentique primeiro
pnpm wrangler login
```

## 📖 Referência

- [Durable Objects - WebSocket Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/api/websockets/)

## 📄 Licença

MIT
