# 📡 Guia de Integração - WebSocket Chat API

Documentação para integrar sua aplicação ao serviço de chat em tempo real via WebSocket.

---

## 📋 Índice

1. [Início Rápido](#início-rápido)
2. [Endpoint de Conexão](#endpoint-de-conexão)
3. [Fluxo de Autenticação](#fluxo-de-autenticação)
4. [Protocolo de Mensagens](#protocolo-de-mensagens)
5. [Exemplos de Integração](#exemplos-de-integração)
6. [Tratamento de Erros](#tratamento-de-erros)
7. [Boas Práticas](#boas-práticas)
8. [Limites e Considerações](#limites-e-considerações)
9. [Troubleshooting](#troubleshooting)

---

## 🚀 Início Rápido

### Resumo

Este serviço oferece um chat global em tempo real via WebSocket com:

- 💬 **Chat global** - Todos os usuários conversam na mesma sala
- 🆔 **Identificação dupla** - userId (cliente) + connectionId (servidor)
- 👤 **Nickname obrigatório** - Defina antes de conversar
- 📡 **Broadcast em tempo real** - Mensagens instantâneas
- 🔒 **Conexão única** - 1 userId = 1 conexão (sessão única)
- 📊 **Estatísticas precisas** - Usuários únicos vs conexões totais

### Exemplo Básico (JavaScript)

```javascript
const ws = new WebSocket('wss://seu-servidor.workers.dev');
const userId = localStorage.getItem('userId') || crypto.randomUUID();
localStorage.setItem('userId', userId);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'request-auth') {
    // Servidor solicita autenticação
    ws.send(JSON.stringify({
      type: 'auth',
      userId: userId,
      nickname: 'João'
    }));
  }
  
  if (data.type === 'chat-message') {
    console.log(`${data.nickname}: ${data.text}`);
  }
};
```

---

## 🔌 Endpoint de Conexão

### URL do Serviço

```
wss://seu-servidor.workers.dev
```

**Substitua** `seu-servidor.workers.dev` pelo domínio fornecido.

### Estabelecendo Conexão

```javascript
const ws = new WebSocket('wss://seu-servidor.workers.dev');

ws.onopen = () => {
  console.log('Conectado!');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Processar mensagens
};

ws.onerror = (error) => {
  console.error('Erro:', error);
};

ws.onclose = () => {
  console.log('Desconectado');
};
```

---

## 🔐 Fluxo de Autenticação

### Arquitetura

**userId** (cliente) → Identifica o proprietário (persiste no localStorage)  
**connectionId** (servidor) → Identifica a conexão específica  
**⚠️ IMPORTANTE**: Apenas 1 conexão ativa por userId (sessão única)

### Diagrama

```
1. Cliente conecta ao WebSocket
        ↓
2. Servidor envia "request-auth" com connectionId
        ↓
3. Cliente envia "auth" com userId (localStorage) + nickname
        ↓
4. Servidor valida:
   - Verifica nickname (único por usuário)
   - DESCONECTA conexão antiga se userId já conectado
        ↓
5. Responde:
   ✓ "auth-accepted" → Autenticado
   ✗ "error" → Inválido
        ↓
6. Se havia conexão antiga: envia "session-replaced"
```

### Passo a Passo

#### 1️⃣ Conectar ao WebSocket

```javascript
const ws = new WebSocket('wss://seu-servidor.workers.dev');
```

#### 2️⃣ Receber Solicitação de Autenticação

Ao conectar, você receberá:

```json
{
  "type": "request-auth",
  "message": "Por favor, identifique-se",
  "connectionId": "conn-abc-123",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Importante:** Guarde o `connectionId` (identifica esta conexão específica).

#### 3️⃣ Enviar userId + Nickname

```javascript
// userId persiste no localStorage (mesmo em várias abas)
const userId = localStorage.getItem('userId') || crypto.randomUUID();
localStorage.setItem('userId', userId);

ws.send(JSON.stringify({
  type: 'auth',
  userId: userId,
  nickname: 'João'
}));
```

**Regras:**
- **userId**: Obrigatório (gerado pelo cliente)
- **nickname**: 2-20 caracteres, único por userId

#### 4️⃣ Receber Confirmação

**✅ Sucesso:**
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

**❌ Falha:**
```json
{
  "type": "error",
  "message": "Nickname 'João' já está em uso por outro usuário",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**⚠️ Conexão Substituída (se já conectado):**

Se você se autenticar com um `userId` que já está conectado em outra aba/dispositivo, a **conexão antiga** receberá:

```json
{
  "type": "session-replaced",
  "message": "Sua sessão foi substituída por uma nova conexão",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

E será automaticamente desconectada. A nova conexão continuará normalmente.

---

## 📡 Protocolo de Mensagens

### Formato

Todas as mensagens são **JSON strings**.

```javascript
// Enviar
ws.send(JSON.stringify({ type: 'message', text: 'Olá!' }));

// Receber
const data = JSON.parse(event.data);
```

---

## 📤 Mensagens que Você Envia

### 1. Autenticar (obrigatório ao conectar)

```json
{
  "type": "auth",
  "userId": "user-abc-123",
  "nickname": "João"
}
```

**Quando:** Logo após receber `request-auth`

**⚠️ IMPORTANTE:** Se você já está conectado em outra aba/dispositivo com este `userId`, a conexão antiga será automaticamente desconectada (receberá `session-replaced`).

**Exemplo:**
```javascript
const userId = localStorage.getItem('userId') || crypto.randomUUID();
localStorage.setItem('userId', userId);

ws.send(JSON.stringify({
  type: 'auth',
  userId: userId,
  nickname: 'João'
}));
```

---

### 2. Enviar Mensagem (requer autenticação)

```json
{
  "type": "message",
  "text": "Sua mensagem aqui"
}
```

**Quando:** Após estar autenticado

**Exemplo:**
```javascript
ws.send(JSON.stringify({
  type: 'message',
  text: 'Olá, pessoal!'
}));
```

**Resultado:** Todos os usuários online receberão sua mensagem.

---

### 3. Verificar Latência (opcional)

```json
{
  "type": "ping",
  "time": 1701345296789
}
```

**Exemplo:**
```javascript
ws.send(JSON.stringify({
  type: 'ping',
  time: Date.now()
}));
```

**Uso:** Para medir latência da conexão.

---

### 4. Obter Estatísticas (opcional)

```json
{
  "type": "get-stats"
}
```

**Exemplo:**
```javascript
ws.send(JSON.stringify({
  type: 'get-stats'
}));
```

**Resultado:** Recebe estatísticas completas (usuários únicos, conexões totais, suas conexões).

---

## 📥 Mensagens que Você Recebe

### 1. Solicitação de Autenticação

**Quando:** Ao conectar

```json
{
  "type": "request-auth",
  "message": "Por favor, identifique-se",
  "connectionId": "conn-abc-123",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Ação:** Enviar `auth` com userId + nickname

---

### 2. Sessão Substituída (se já conectado)

**Quando:** Você se autentica com um `userId` que já está conectado em outro lugar

```json
{
  "type": "session-replaced",
  "message": "Sua sessão foi substituída por uma nova conexão",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Ação:** Mostrar aviso ao usuário e fechar conexão. A **conexão antiga** recebe esta mensagem e é desconectada. A nova conexão continua normalmente.

### 3. Autenticação Aceita

**Quando:** Após enviar auth válido

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

**Ação:** Marcar como autenticado, exibir interface de chat

---

### 3. Mensagem de Chat

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

**Recebido por:** Todos os usuários autenticados

**Ação:** Exibir mensagem (compare `userId` com o seu para identificar suas mensagens)

---


### 5. Usuário Entrou

```json
{
  "type": "user-joined",
  "message": "João entrou no chat",
  "nickname": "João",
  "userId": "user-abc-123",
  "uniqueUsers": 6,
  "totalConnections": 8,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Quando:** NOVO usuário (primeira conexão do userId)

**Recebido por:** Todos exceto quem entrou

---

### 6. Usuário Saiu

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

**Quando:** ÚLTIMA conexão do userId desconecta

**Recebido por:** Todos os usuários restantes

---

### 7. Resposta ao Ping

```json
{
  "type": "pong",
  "time": 1701345296789,
  "connectionId": "conn-xyz-789",
  "uniqueUsers": 5,
  "totalConnections": 7,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Uso:** Calcular latência
```javascript
const latency = Date.now() - data.time;
```

---

### 8. Estatísticas

```json
{
  "type": "stats",
  "uniqueUsers": 5,
  "totalConnections": 5,
  "isConnected": true,
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Recebido por:** Apenas quem solicitou

---

### 9. Erro

```json
{
  "type": "error",
  "message": "Nickname deve ter entre 2 e 20 caracteres",
  "timestamp": "2024-11-30T12:34:56.789Z"
}
```

**Erros comuns:**
- `"userId é obrigatório"`
- `"Nickname deve ter entre 2 e 20 caracteres"`
- `"Nickname 'João' já está em uso por outro usuário"`
- `"Você precisa se autenticar antes de enviar mensagens"`
- **`MESSAGE_TOO_LARGE`** - Mensagem muito grande (máx 4KB)

---

## 💻 Exemplos de Integração

### JavaScript (Browser) - Completo

```javascript
class ChatClient {
  constructor(url) {
    this.ws = null;
    this.authenticated = false;
    this.userId = null;
    this.nickname = null;
    this.url = url;
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      console.log('✓ Conectado ao servidor');
    };
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };
    
    this.ws.onerror = (error) => {
      console.error('❌ Erro:', error);
    };
    
    this.ws.onclose = () => {
      console.log('⊗ Desconectado');
      this.authenticated = false;
    };
  }
  
  handleMessage(data) {
    switch (data.type) {
      case 'request-auth':
        this.connectionId = data.connectionId;
        this.onAuthRequested?.();
        break;
        
      case 'auth-accepted':
        this.authenticated = true;
        this.nickname = data.nickname;
        console.log(`✓ Autenticado: ${this.nickname}`);
        console.log(`👥 ${data.uniqueUsers} usuários | ${data.totalConnections} conexões`);
        this.onAuthenticated?.(data);
        break;
        
      case 'chat-message':
        const isMyMessage = data.userId === this.userId;
        this.onChatMessage?.(data, isMyMessage);
        break;
        
      case 'session-replaced':
        console.log(`⚠️ ${data.message}`);
        console.log(`💡 Você conectou em outro lugar`);
        this.authenticated = false;
        this.onSessionReplaced?.(data);
        if (this.ws) this.ws.close();
        break;
        
      case 'user-joined':
        console.log(`🟢 ${data.message}`);
        this.onUserJoined?.(data);
        break;
        
      case 'user-left':
        console.log(`🔴 ${data.message}`);
        this.onUserLeft?.(data);
        break;
        
      case 'pong':
        const latency = Date.now() - data.time;
        console.log(`📡 ${latency}ms | ${data.uniqueUsers} usuários`);
        this.onPong?.(latency, data);
        break;
        
        case 'stats':
          console.log(`📊 ${data.uniqueUsers} usuários | ${data.totalConnections} conexões`);
          this.onStats?.(data);
          break;
        
        case 'error':
          console.error(`❌ ${data.message}`);
          this.onError?.(data.message);
          break;
    }
  }
  
  authenticate(nickname) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'auth',
        userId: this.userId,
        nickname: nickname
      }));
    }
  }
  
  sendMessage(text) {
    if (!this.authenticated) {
      console.error('❌ Você precisa estar autenticado');
      return false;
    }
    
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'message',
        text: text
      }));
      return true;
    }
    
    return false;
  }
  
  ping() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'ping',
        time: Date.now()
      }));
    }
  }
  
  getStats() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'get-stats'
      }));
    }
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Uso
const chat = new ChatClient('wss://seu-servidor.workers.dev');

// Callbacks
chat.onAuthRequested = () => {
  const nickname = prompt('Digite seu nickname:');
  chat.authenticate(nickname);
};

chat.onAuthenticated = (data) => {
  console.log('Você está no chat!');
};

chat.onChatMessage = (data, isMyMessage) => {
  const prefix = isMyMessage ? 'Você' : data.nickname;
  console.log(`${prefix}: ${data.text}`);
};

// Conectar
chat.connect();

// Enviar mensagem
// chat.sendMessage('Olá pessoal!');
```

---

### React Hook (TypeScript)

```typescript
import { useEffect, useState, useCallback } from 'react';

interface Message {
  type: string;
  text?: string;
  nickname?: string;
  userId?: string;
  connections?: number;
  timestamp?: string;
  message?: string;
  time?: number;
}

export function useChatWebSocket(url: string) {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    const websocket = new WebSocket(url);
    
    websocket.onopen = () => {
      setConnected(true);
      setError(null);
    };
    
    websocket.onmessage = (event) => {
      const data: Message = JSON.parse(event.data);
      
      switch (data.type) {
        case 'request-auth':
          // connectionId fornecido pelo servidor
          break;
          
        case 'auth-accepted':
          setAuthenticated(true);
          setNickname(data.nickname!);
          setOnlineCount(data.uniqueUsers!);
          break;
          
        case 'session-replaced':
          // Avisa usuário e reconecta/fecha
          alert(data.message);
          if (ws) ws.close();
          setAuthenticated(false);
          break;
        
        case 'chat-message':
        case 'user-joined':
        case 'user-left':
          setMessages(prev => [...prev, data]);
          if (data.uniqueUsers) setOnlineCount(data.uniqueUsers);
          break;
          
        case 'stats':
          setOnlineCount(data.uniqueUsers!);
          break;
          
        case 'error':
          setError(data.message!);
          break;
      }
    };
    
    websocket.onerror = () => {
      setError('Erro na conexão');
    };
    
    websocket.onclose = () => {
      setConnected(false);
      setAuthenticated(false);
    };
    
    setWs(websocket);
    
    return () => {
      websocket.close();
    };
  }, [url]);
  
  const authenticate = useCallback((nick: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'auth',
        userId: userId,
        nickname: nick
      }));
      setError(null);
    }
  }, [ws, userId]);
  
  const sendMessage = useCallback((text: string) => {
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify({
        type: 'message',
        text: text
      }));
      return true;
    }
    return false;
  }, [ws, authenticated]);
  
  const ping = useCallback(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ping',
        time: Date.now()
      }));
    }
  }, [ws]);
  
  return {
    connected,
    authenticated,
    userId,
    nickname,
    messages,
    onlineCount,
    error,
    authenticate: authenticate,
    sendMessage,
    ping
  };
}
```

---

### Node.js

```javascript
import WebSocket from 'ws';
import readline from 'readline';

const ws = new WebSocket('wss://seu-servidor.workers.dev');
let authenticated = false;
let userId = null;
let nickname = null;
let rl = null;

ws.on('open', () => {
  console.log('✓ Conectado ao servidor');
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  
  switch (message.type) {
    case 'request-auth':
      connectionId = message.connectionId;
      console.log(`UserId: ${userId}`);
      console.log(`ConnectionId: ${connectionId}\n`);
      
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('Digite seu nickname: ', (nick) => {
        ws.send(JSON.stringify({
          type: 'auth',
          userId: userId,
          nickname: nick
        }));
      });
      break;
      
    case 'auth-accepted':
      authenticated = true;
      nickname = message.nickname;
      console.log(`\n✓ Autenticado: ${nickname}`);
      console.log(`👥 ${message.uniqueUsers} usuários | ${message.totalConnections} conexões\n`);
      
      rl.close();
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `[${nickname}] > `
      });
      
      rl.prompt();
      
      rl.on('line', (input) => {
        if (input.trim()) {
          ws.send(JSON.stringify({
            type: 'message',
            text: input.trim()
          }));
        }
        rl.prompt();
      });
      break;
      
    case 'chat-message':
      const isMyMessage = message.userId === userId;
      const prefix = isMyMessage ? 'Você' : message.nickname;
      console.log(`\n${prefix}: ${message.text}`);
      if (rl) rl.prompt();
      break;
      
    case 'user-joined':
      console.log(`\n🟢 ${message.message}`);
      if (rl) rl.prompt();
      break;
      
    case 'user-left':
      console.log(`\n🔴 ${message.message}`);
      if (rl) rl.prompt();
      break;
      
    case 'error':
      console.error(`\n❌ ${message.message}`);
      if (rl) rl.prompt();
      break;
  }
});

ws.on('error', (error) => {
  console.error('❌ Erro:', error.message);
});

ws.on('close', () => {
  console.log('⊗ Desconectado');
  process.exit(0);
});
```

---

## ⚠️ Tratamento de Erros

### 1. Nickname Inválido

```json
{
  "type": "error",
  "message": "Nickname deve ter entre 2 e 20 caracteres"
}
```

**Ação:** Solicitar novo nickname ao usuário

```javascript
if (data.type === 'error') {
  alert(data.message);
  // Solicitar novo nickname
}
```

---

### 2. Nickname em Uso por Outro Usuário

```json
{
  "type": "error",
  "message": "Nickname 'João' já está em uso por outro usuário"
}
```

**Ação:** Solicitar nickname diferente

**Nota:** Múltiplas abas do mesmo userId podem usar o mesmo nickname

---

### 3. Mensagem Sem Autenticação

```json
{
  "type": "error",
  "message": "Você precisa se autenticar antes de enviar mensagens"
}
```

**Ação:** Garantir autenticação antes de enviar

```javascript
function sendMessage(text) {
  if (!authenticated) {
    console.error('Não autenticado');
    return;
  }
  ws.send(JSON.stringify({ type: 'message', text }));
}
```

---

### 4. Reconexão Automática

```javascript
let reconnectAttempts = 0;
const MAX_ATTEMPTS = 5;

function connect() {
  const ws = new WebSocket(url);
  
  ws.onclose = () => {
    if (reconnectAttempts < MAX_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`Reconectando... (${reconnectAttempts}/${MAX_ATTEMPTS})`);
      
      // Backoff exponencial
      setTimeout(() => connect(), 1000 * reconnectAttempts);
    } else {
      console.error('Falha ao reconectar');
    }
  };
  
  ws.onopen = () => {
    reconnectAttempts = 0; // Reset
  };
}
```

---

## ✅ Boas Práticas

### 1. Sempre Validar JSON

```javascript
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    handleMessage(data);
  } catch (error) {
    console.error('Erro ao parsear JSON:', error);
  }
};
```

### 2. Verificar Estado da Conexão

```javascript
function sendMessage(text) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket não está conectado');
    return false;
  }
  
  ws.send(JSON.stringify({ type: 'message', text }));
  return true;
}
```

### 3. Gerenciar Estado de Autenticação

```javascript
let authenticated = false;

function handleNicknameAccepted(data) {
  authenticated = true;
  // Habilitar interface de chat
  enableChatUI();
}

function sendMessage(text) {
  if (!authenticated) {
    alert('Você precisa estar autenticado');
    return;
  }
  // Enviar mensagem
}
```

### 4. Limitar Tamanho de Mensagens

```javascript
const MAX_MESSAGE_LENGTH = 1000;

function sendMessage(text) {
  if (text.length > MAX_MESSAGE_LENGTH) {
    alert(`Mensagem muito longa (máx: ${MAX_MESSAGE_LENGTH})`);
    return;
  }
  
  ws.send(JSON.stringify({ type: 'message', text }));
}
```

### 5. Sanitizar Input do Usuário

```javascript
function sanitizeNickname(nickname) {
  return nickname
    .trim()
    .slice(0, 20)
    .replace(/[<>'"]/g, ''); // Remove caracteres perigosos
}

function sanitizeMessage(text) {
  return text
    .trim()
    .replace(/[<>]/g, ''); // Previne XSS
}
```

### 6. Implementar Heartbeat (opcional)

```javascript
let heartbeatInterval;

ws.onopen = () => {
  // Ping a cada 30 segundos
  heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'ping', 
        time: Date.now() 
      }));
    }
  }, 30000);
};

ws.onclose = () => {
  clearInterval(heartbeatInterval);
};
```

---

## 📊 Limites e Considerações

### Limites do Serviço

| Item | Limite |
|------|--------|
| **Nickname** | 2-20 caracteres |
| **Tamanho da mensagem** | 4KB máximo |
| **Usuários simultâneos** | ~1000 por sala |

### Conexão Única
- **1 userId = 1 conexão**: Se você conectar de outra aba/dispositivo com o mesmo `userId`, a conexão anterior será automaticamente desconectada
- Você receberá `session-replaced` na aba antiga antes de ser desconectado

### Validações
- **Tamanho máximo**: 4KB por mensagem (exceder = erro `MESSAGE_TOO_LARGE`)
- **Formato**: Apenas JSON válido é aceito

### Outras Considerações

1. **Mensagens não persistidas**: Histórico não é salvo

2. **Chat público**: Mensagens visíveis para todos os usuários autenticados

3. **Nickname único por userId**: Cada userId pode ter apenas um nickname

4. **Contadores**:
   - `uniqueUsers` → Quantidade de userIds únicos autenticados
   - `totalConnections` → Total de conexões WebSocket ativas (sempre igual a `uniqueUsers` com conexão única)

---

## 🔧 Troubleshooting

### Problema: Não Consegue Conectar

**Sintomas:**
- `WebSocket connection failed`
- Erro de conexão

**Soluções:**
1. Verificar se a URL está correta
2. Verificar se há conexão com internet
3. Tentar protocolo `ws://` em vez de `wss://` para teste local
4. Verificar firewall/proxy

---

### Problema: Nickname Rejeitado

**Sintomas:**
- Recebe `error` após enviar nickname

**Causas possíveis:**
- Nickname < 2 ou > 20 caracteres
- Nickname já em uso por outro usuário
- Caracteres especiais problemáticos

**Solução:**
Tentar outro nickname válido

---

### Problema: Mensagens Não Enviadas

**Sintomas:**
- `ws.send()` não funciona
- Nenhum erro aparece

**Verificar:**
1. `ws.readyState === WebSocket.OPEN`
2. `authenticated === true`
3. Formato JSON correto

```javascript
// Debug
console.log('Estado:', ws.readyState);
console.log('Autenticado:', authenticated);
```

---

### Problema: Desconexões Frequentes

**Causas possíveis:**
- Conexão de internet instável
- Firewall/proxy interrompendo
- Timeout de inatividade

**Soluções:**
1. Implementar reconexão automática
2. Implementar heartbeat (ping a cada 30s)
3. Verificar configurações de rede

---

### Problema: Alta Latência

**Sintomas:**
- Mensagens demoram para chegar
- Resposta lenta

**Verificar:**
1. Latência da rede (use `ping`)
2. Implementar heartbeat para manter conexão ativa
3. Verificar se há sobrecarga de mensagens

---

## 📄 Versão

**Versão da API:** 1.5
**Última atualização:** 30 de novembro de 2024

---

## ⚖️ Termos de Uso

Este serviço é fornecido "como está". Ao usar este serviço você concorda em:

- Respeitar outros usuários
- Não utilizar para fins ilegais
- Não enviar conteúdo malicioso

O serviço pode ser descontinuado ou modificado sem aviso prévio.
