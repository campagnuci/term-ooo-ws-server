import WebSocket from 'ws';
import readline from 'readline';

// Detecta ambiente de desenvolvimento
const isLocal = process.argv.includes('--local') || process.env.NODE_ENV === 'development';

const REMOTE_URL = "wss://hidden-tree-8ed4.arthrmrs.workers.dev";
const LOCAL_URL = "ws://localhost:3000";

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║          CHAT GLOBAL - CLIENTE WEBSOCKET                 ║');
console.log('╚══════════════════════════════════════════════════════════╝');

let rl;
let authenticated = false;
let userId = null;
let connectionId = null;
let myNickname = null;

// Simula localStorage para Node.js
if (typeof localStorage === 'undefined') {
  const fs = await import('fs');
  const path = await import('path');
  const storageFile = path.join(process.cwd(), '.chat-storage.json');

  global.localStorage = {
    getItem: (key) => {
      try {
        const data = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
        return data[key] || null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      } catch { }
      data[key] = value;
      fs.writeFileSync(storageFile, JSON.stringify(data));
    }
  };
}

// Inicializa userId após localStorage estar disponível
userId = localStorage.getItem('chat-userId') || crypto.randomUUID();
localStorage.setItem('chat-userId', userId);

const url = isLocal ? LOCAL_URL : REMOTE_URL;

console.log(`\nConectando em: ${url}`);
console.log(`Ambiente: ${isLocal ? 'LOCAL (desenvolvimento)' : 'REMOTO (produção)'}`);
console.log(`User ID: ${userId.substring(0, 8)}...\n`);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('✓ Conexão estabelecida com sucesso!');
  console.log('⏳ Aguardando solicitação de autenticação...\n');
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());

    switch (message.type) {
      case 'request-auth':
        connectionId = message.connectionId;

        console.log(`🆔 UserId: ${userId}`);
        console.log(`🔌 ConnectionId: ${connectionId}\n`);

        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
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
        myNickname = message.nickname;

        console.log(`\n┌─────────────────────────────────────────────────────────┐`);
        console.log(`│ ${message.message.padEnd(55)} │`);
        console.log(`│ Nickname: ${myNickname.padEnd(47)} │`);
        console.log(`│ Usuários online: ${String(message.uniqueUsers).padEnd(38)} │`);
        console.log(`│ Conexões totais: ${String(message.totalConnections).padEnd(38)} │`);
        console.log(`└─────────────────────────────────────────────────────────┘\n`);

        console.log('Comandos disponíveis:');
        console.log('  - Digite mensagens normalmente para enviar ao chat');
        console.log('  - /ping       - Verifica latência');
        console.log('  - /stats      - Mostra estatísticas');
        console.log('  - /sair       - Encerra conexão');
        console.log('\n⚠️  ATENÇÃO: Apenas 1 conexão por usuário é permitida');
        console.log('   Se conectar em outro lugar, esta sessão será encerrada\n');

        rl.close();
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: `[${myNickname}] > `
        });

        rl.prompt();

        rl.on('line', (input) => {
          const mensagem = input.trim();

          // >>> BLOQUEIO LOCAL DURANTE MUTE <<<
          if (global.ultimaMuteExpira && Date.now() < global.ultimaMuteExpira) {
            const rest = Math.ceil((global.ultimaMuteExpira - Date.now()) / 1000);
            console.log(`⛔ Você está temporariamente bloqueado. Aguarde ${rest}s.`);
            rl.prompt();
            return;
          }

          // >>> AVISO QUANDO MUTE ACABAR <<<
          if (global.ultimaMuteExpira && Date.now() >= global.ultimaMuteExpira) {
            console.log('🟢 Você não está mais bloqueado, pode enviar mensagens.');
            delete global.ultimaMuteExpira;
          }

          if (!mensagem) {
            rl.prompt();
            return;
          }

          if (mensagem.toLowerCase() === '/sair') {
            console.log('\n⊗ Encerrando conexão...');
            ws.close();
            rl.close();
            return;
          }

          if (mensagem.toLowerCase() === '/ping') {
            const pingTime = Date.now();
            ws.send(JSON.stringify({ type: 'ping', time: pingTime }));
            rl.prompt();
            return;
          }

          if (mensagem.toLowerCase() === '/stats') {
            ws.send(JSON.stringify({ type: 'get-stats' }));
            rl.prompt();
            return;
          }

          ws.send(JSON.stringify({
            type: 'message',
            text: mensagem,
          }));

          rl.prompt();
        });

        rl.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        });
        break;

      case 'session-replaced':
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        console.log(`\n⚠️  ${message.message}`);
        console.log(`💡 Você conectou em outro lugar (navegador/aba/dispositivo)`);
        console.log(`🔴 Esta conexão será encerrada\n`);
        authenticated = false;
        if (rl) rl.close();
        break;

      case 'user-joined':
        if (!authenticated) return;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        console.log(`[🟢 ENTROU] ${message.message} (Usuários: ${message.uniqueUsers})`);
        rl.prompt();
        break;

      case 'user-left':
        if (!authenticated) return;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        console.log(`[🔴 SAIU] ${message.message} (Usuários: ${message.uniqueUsers})`);
        rl.prompt();
        break;

      case 'chat-message':
        if (!authenticated) return;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        const time = new Date(message.timestamp).toLocaleTimeString('pt-BR');
        const isMyMessage = message.userId === userId;
        const prefix = isMyMessage ? '📤' : '💬';
        console.log(`${prefix} [${time}] ${message.nickname}: ${message.text}`);
        rl.prompt();
        break;

      case 'pong':
        if (!authenticated) return;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        const latency = message.time ? Date.now() - message.time : 'N/A';
        console.log(`[📡 PING] Latência: ${latency}ms | Usuários: ${message.uniqueUsers} | Conexões: ${message.totalConnections}`);
        rl.prompt();
        break;

      case 'stats':
        if (!authenticated) return;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        console.log(`[📊 ESTATÍSTICAS]`);
        console.log(`  - Usuários únicos: ${message.uniqueUsers}`);
        console.log(`  - Conexões totais: ${message.totalConnections}`);
        console.log(`  - Você está conectado: ${message.isConnected ? 'Sim' : 'Não'}`);
        rl.prompt();
        break;

      case 'error':
        process.stdout.clearLine();
        process.stdout.cursorTo(0);

        if (message.code) {
          const base = `[❌ ERRO - ${message.code}] ${message.message}`;

          // NEW: anti-spam
          if (message.code === 'SPAM_DETECTED' || message.code === 'USER_MUTED') {
            const wait = message.retryAfterMs
              ? ` Aguarde ${Math.ceil(message.retryAfterMs / 1000)}s.`
              : '';
            console.log(`${base}${wait}`);
          }
          else if (message.code === 'MESSAGE_TOO_LARGE') {
            console.log(`${base}`);
            console.log(`📏 Tamanho recebido: ${message.receivedSize} bytes`);
            console.log(`📏 Tamanho máximo: ${message.maxSize} bytes`);
          }
          else {
            console.log(`${base}`);
          }
        } else {
          console.log(`[❌ ERRO] ${message.message}`);
        }

        if (authenticated) rl.prompt();
        break;

      default:
        if (authenticated) {
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          console.log(`[SERVIDOR] ${JSON.stringify(message)}`);
          rl.prompt();
        }
    }
  } catch (error) {
    if (authenticated) {
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      console.log(`[SERVIDOR] ${data}`);
      rl.prompt();
    }
  }
});

ws.on('error', (error) => {
  console.error('\n[❌ ERRO] Erro na conexão WebSocket:', error.message);
});

ws.on('close', () => {
  console.log('\n⊗ Conexão WebSocket encerrada.');
  process.exit(0);
});
