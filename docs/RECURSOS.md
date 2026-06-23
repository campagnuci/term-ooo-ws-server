# 📚 Recursos do WebSocket

## Identificação

**userId** (cliente) → Gerado no localStorage, identifica o usuário  
**connectionId** (servidor) → Gerado automaticamente, identifica a conexão específica  
**nickname** → 2-20 caracteres, obrigatório para chat

### Conexão Única

**1 userId = 1 conexão ativa**

Se conectar novamente com mesmo userId:
- Nova conexão: recebe `auth-accepted`
- Antiga conexão: recebe `session-replaced` e desconecta

## Endpoint

**Desenvolvimento:** `ws://localhost:3000`  
**Produção:** `wss://ws-cloudflare.<seu-subdomain>.workers.dev`  
**Protocolo:** WebSocket (RFC 6455) + JSON

---

## Mensagens Cliente → Servidor

### 1. auth

Autentica com userId + nickname.

```json
{
  "type": "auth",
  "userId": "user-abc-123",
  "nickname": "João"
}
```

**Campos:**
- `userId` (obrigatório): UUID gerado pelo cliente
- `nickname` (2-20 chars): Nome de exibição

**Resposta:**
- ✅ `auth-accepted` → Autenticado
- ⚠️ `session-replaced` → Conexão antiga desconectada
- ❌ `error` → Inválido

---

### 2. message

Envia mensagem ao chat.

```json
{
  "type": "message",
  "text": "Olá, pessoal!"
}
```

**Requer:** Autenticação prévia  
**Limite:** 4KB por mensagem  
**Proteção:** Anti-spam automático

---

### 3. ping

Testa latência.

```json
{
  "type": "ping",
  "time": 1701345296789
}
```

**Resposta:** `pong` com timestamp

---

### 4. get-stats

Solicita estatísticas.

```json
{
  "type": "get-stats"
}
```

**Resposta:** `stats` com contadores

---

## Mensagens Servidor → Cliente

### 1. request-auth

Servidor solicita autenticação.

```json
{
  "type": "request-auth",
  "message": "Por favor, identifique-se",
  "connectionId": "conn-abc-123",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Ação:** Enviar `auth`

---

### 2. session-replaced

Conexão substituída por nova.

```json
{
  "type": "session-replaced",
  "message": "Sua sessão foi substituída por uma nova conexão",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Quando:** Mesmo userId conectou em outro lugar  
**Ação:** Mostrar aviso e fechar

---

### 3. auth-accepted

Autenticação aceita.

```json
{
  "type": "auth-accepted",
  "message": "Bem-vindo ao Chat Global!",
  "userId": "user-abc-123",
  "connectionId": "conn-xyz-789",
  "nickname": "João",
  "uniqueUsers": 5,
  "totalConnections": 5,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Ação:** Habilitar chat

---

### 4. chat-message

Mensagem de outro usuário.

```json
{
  "type": "chat-message",
  "text": "Olá!",
  "nickname": "João",
  "userId": "user-abc-123",
  "connectionId": "conn-xyz-789",
  "uniqueUsers": 5,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Recebido por:** Todos autenticados

---

### 5. user-joined

Usuário entrou no chat.

```json
{
  "type": "user-joined",
  "message": "João entrou no chat",
  "nickname": "João",
  "userId": "user-abc-123",
  "uniqueUsers": 6,
  "totalConnections": 6,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

---

### 6. user-left

Usuário saiu do chat.

```json
{
  "type": "user-left",
  "message": "João saiu do chat",
  "nickname": "João",
  "userId": "user-abc-123",
  "uniqueUsers": 5,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

---

### 7. pong

Resposta ao ping.

```json
{
  "type": "pong",
  "time": 1701345296789,
  "connectionId": "conn-xyz-789",
  "uniqueUsers": 5,
  "totalConnections": 5,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Uso:** `latency = Date.now() - data.time`

---

### 8. stats

Estatísticas do servidor.

```json
{
  "type": "stats",
  "uniqueUsers": 5,
  "totalConnections": 5,
  "isConnected": true,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

---

### 9. error

Erro genérico.

```json
{
  "type": "error",
  "code": "MESSAGE_TOO_LARGE",
  "message": "Mensagem muito grande",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Códigos comuns:**
- `MESSAGE_TOO_LARGE` - Mensagem > 4KB
- `SPAM_DETECTED` - Comportamento de spam detectado
- `USER_MUTED` - Bloqueado temporariamente
- Mensagens sem código (erros simples)

---

## Sistema Anti-Spam

### Configuração

| Parâmetro | Valor |
|-----------|-------|
| Janela | 10 segundos |
| Máx mensagens | 10 por janela |
| Intervalo mín | 250ms entre msgs |
| Máx repetidas | 3x mesma msg |
| Mute base | 5 segundos |
| Mute máx | 60 segundos |

### Detecção

**Infrações:**
1. Intervalo < 250ms entre mensagens
2. Mais de 10 mensagens em 10s
3. Mesma mensagem 3x na janela

**Mute progressivo:**
- 1ª infração: 5s
- 2ª infração: 10s
- 3ª infração: 15s
- Máximo: 60s

### Mensagens de Bloqueio

**SPAM_DETECTED:**
```json
{
  "type": "error",
  "code": "SPAM_DETECTED",
  "message": "Detectamos comportamento de spam",
  "retryAfterMs": 5000,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**USER_MUTED:**
```json
{
  "type": "error",
  "code": "USER_MUTED",
  "message": "Você está temporariamente bloqueado",
  "retryAfterMs": 5000,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

### Implementação no Cliente

```javascript
let muteUntil = null;

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.code === 'SPAM_DETECTED' || data.code === 'USER_MUTED') {
    muteUntil = Date.now() + data.retryAfterMs;
    
    // Desabilitar botão de envio
    sendButton.disabled = true;
    
    // Contador regressivo
    const interval = setInterval(() => {
      if (Date.now() >= muteUntil) {
        sendButton.disabled = false;
        clearInterval(interval);
      } else {
        const remaining = Math.ceil((muteUntil - Date.now()) / 1000);
        showMessage(`Bloqueado: ${remaining}s restantes`);
      }
    }, 1000);
  }
};

// Validar antes de enviar
function sendMessage(text) {
  if (muteUntil && Date.now() < muteUntil) {
    alert('Você está temporariamente bloqueado');
    return;
  }
  
  ws.send(JSON.stringify({ type: 'message', text }));
}
```

---

## Exemplo Completo

```javascript
const ws = new WebSocket('wss://ws-cloudflare.seu-subdomain.workers.dev');
let userId = localStorage.getItem('userId') || crypto.randomUUID();
localStorage.setItem('userId', userId);

ws.onopen = () => console.log('Conectado');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'request-auth':
      ws.send(JSON.stringify({
        type: 'auth',
        userId: userId,
        nickname: 'João'
      }));
      break;
      
    case 'auth-accepted':
      console.log('✅ Autenticado:', data.nickname);
      break;
      
    case 'chat-message':
      console.log(`${data.nickname}: ${data.text}`);
      break;
      
    case 'user-joined':
    case 'user-left':
      console.log(data.message);
      break;
      
    case 'session-replaced':
      alert('Você conectou em outro lugar');
      ws.close();
      break;
      
    case 'error':
      console.error(data.message);
      break;
  }
};

ws.onerror = (error) => console.error('Erro:', error);
ws.onclose = () => console.log('Desconectado');

// Enviar mensagem
function sendMessage(text) {
  ws.send(JSON.stringify({ type: 'message', text }));
}

// Verificar latência
function ping() {
  ws.send(JSON.stringify({ type: 'ping', time: Date.now() }));
}
```

---

## Limites

| Item | Valor |
|------|-------|
| Nickname | 2-20 caracteres |
| Mensagem | 4KB máximo |
| Conexões por userId | 1 única |
| Formato | JSON válido |

---

## Boas Práticas

### 1. Validar JSON
```javascript
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    handleMessage(data);
  } catch (error) {
    console.error('JSON inválido:', error);
  }
};
```

### 2. Verificar Estado
```javascript
function sendMessage(text) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket não conectado');
    return;
  }
  ws.send(JSON.stringify({ type: 'message', text }));
}
```

### 3. Reconexão Automática
```javascript
let reconnectAttempts = 0;
const MAX_ATTEMPTS = 5;

function connect() {
  const ws = new WebSocket(url);
  
  ws.onclose = () => {
    if (reconnectAttempts < MAX_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(() => connect(), 1000 * reconnectAttempts);
    }
  };
  
  ws.onopen = () => {
    reconnectAttempts = 0;
  };
}
```

### 4. Limitar Tamanho
```javascript
const MAX_LENGTH = 1000;

function sendMessage(text) {
  if (text.length > MAX_LENGTH) {
    alert(`Mensagem muito longa (máx: ${MAX_LENGTH})`);
    return;
  }
  ws.send(JSON.stringify({ type: 'message', text }));
}
```

### 5. Sanitizar Input
```javascript
function sanitize(text) {
  return text
    .trim()
    .replace(/[<>]/g, ''); // Previne XSS
}
```

---

## Troubleshooting

**Conexão falha:**
- Use `wss://` em produção, `ws://` local
- Verifique URL e porta
- Confirme origin permitida

**Nickname rejeitado:**
- 2-20 caracteres
- Não pode estar em uso por outro userId

**Mensagens não enviadas:**
- Verifique autenticação
- Verifique estado da conexão
- Verifique limite de 4KB

**Desconexões frequentes:**
- Implemente reconexão automática
- Verifique rede/firewall
- Use heartbeat (ping/pong)

---

## Referência

- [WebSocket API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/api/websockets/)
