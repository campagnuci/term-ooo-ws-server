# 🚀 Guia Rápido

## Desenvolvimento Local

### 1. Iniciar Servidor

```bash
pnpm dev
```

**Saída esperada:**
```
⛅️ wrangler 4.51.0
Ready on http://localhost:3000
```

### 2. Conectar Cliente

```bash
pnpm client:local
```

**Fluxo de autenticação:**
```
✓ Conectado
Digite seu nickname: João

┌─────────────────────────────────┐
│ Bem-vindo ao Chat Global!       │
│ Nickname: João                  │
│ Usuários online: 1              │
└─────────────────────────────────┘

[João] > 
```

### 3. Testar Chat

**Abra múltiplos terminais** com nicknames diferentes:

**Terminal 1:**
```bash
pnpm client:local
# Nickname: João
[João] > Olá pessoal!
```

**Terminal 2:**
```bash
pnpm client:local
# Nickname: Maria
[Maria] > Oi João!
```

**Você verá broadcasts:**
```
🟢 Maria entrou no chat (Total: 2)
💬 [Maria]: Oi João!
```

## Deploy em Produção

### 1. Autenticar

```bash
pnpm wrangler login
```

### 2. Deploy

```bash
pnpm deploy
```

**Saída:**
```
✨ Deployment complete!
https://ws-cloudflare.<seu-subdomain>.workers.dev
```

### 3. Configurar Billing Limit (Recomendado)

1. Acesse: [dash.cloudflare.com](https://dash.cloudflare.com)
2. Account → Billing → Set Spending Limit: **$0.00**
3. Ativar alertas em 80% do Free Tier

### 4. Testar Produção

Atualize `client.js` (linha 7):
```javascript
const REMOTE_URL = "wss://ws-cloudflare.<seu-subdomain>.workers.dev";
```

Teste:
```bash
pnpm client
```

## Comandos Disponíveis

```bash
[João] > Olá!          # Envia mensagem
[João] > /ping         # Verifica latência
[João] > /stats        # Mostra estatísticas
[João] > /sair         # Encerra conexão
```

## Browser Demo

Abra `exemplo-browser.html` no navegador:

1. Conecta automaticamente
2. Solicita nickname
3. Interface visual completa
4. Contador de mute (se aplicável)

## Recursos Implementados

### ✅ Identificação
- UUID único por usuário
- Nickname obrigatório (2-20 chars)
- Validação de duplicatas

### ✅ Conexão Única
- 1 userId = 1 conexão
- Desconecta automaticamente conexão antiga
- Notificação `session-replaced`

### ✅ Anti-Spam
- Janela de 10s
- Máx 10 mensagens/janela
- Intervalo mín 250ms
- Mute progressivo 5s-60s

### ✅ Broadcast
- Entrada/saída de usuários
- Mensagens com nickname
- Apenas usuários autenticados

### ✅ Hibernação
- Economia automática de custos
- Conexões persistem
- Reativação instantânea

## Fluxo Técnico

```
1. Cliente → Worker
   - Valida WebSocket upgrade
   - Valida origin

2. Worker → Durable Object
   - Obtém instância "global-chat"
   - Faz proxy da requisição

3. Durable Object → Cliente
   - Aceita conexão
   - Solicita auth
   - Retorna WebSocket

4. Cliente ↔ Durable Object
   - Mensagens diretas
   - Broadcast automático
   - Hibernação quando inativo
```

## Testes

### Validar Worker
```bash
curl http://localhost:3000
# Retorna: "Esperado header Upgrade: websocket" (426)
```

### Testar Anti-Spam
```bash
# No cliente, envie mensagens rapidamente
[João] > msg1
[João] > msg2
[João] > msg3
# ... continue enviando ...
# Você verá: "USER_MUTED - Aguarde 5s"
```

### Ver Logs
```bash
# Terminal onde rodou pnpm dev
# Logs aparecem automaticamente
```

### Monitorar Produção
```bash
pnpm wrangler tail
```

## Próximos Passos

- [ ] Domínio customizado
- [ ] Múltiplas salas
- [ ] Persistência de mensagens
- [ ] Autenticação JWT
- [ ] Mensagens privadas

## Troubleshooting

**Porta 3000 ocupada:**
```toml
# wrangler.toml
[dev]
port = 3001  # Altere aqui
```

**Deploy não funciona:**
```bash
# Re-autentique
pnpm wrangler logout
pnpm wrangler login
```

**Cliente não conecta:**
- Verifique se servidor está rodando
- Confirme URL no client.js
- Use `ws://` local, `wss://` produção

## Documentação Completa

- **[RECURSOS.md](RECURSOS.md)** - API WebSocket completa
- **[INTEGRACAO.md](INTEGRACAO.md)** - Guia de integração técnica
