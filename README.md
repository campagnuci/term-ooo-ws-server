# WebSocket Server - Cloudflare Durable Objects

Backend WebSocket em tempo real do **[termo.enresshou.dev](https://termo.enresshou.dev)**, usando **Cloudflare Workers** e **Durable Objects** com **API de Hibernação**.

Expõe **dois** Durable Objects, roteados por caminho no `worker.js`:

| Caminho | Durable Object | Arquivo | Uso |
|---------|----------------|---------|-----|
| `/room/<CODE>` | `GameRoom` | `game-room.js` | 🎮 **Salas multiplayer** do jogo (Cooperativo, Competição e Time Trial — partidas multi-rodada) — uma instância por código de sala |
| qualquer outro | `WebSocketHibernationServer` | `websocket-server.js` | 💬 Chat global único (legado) |

> O frontend (`term-ooo`) conecta em `wss://<worker>.<subdomain>.workers.dev/room/<CODE>`.
> A URL é configurada via `VITE_CHAT_WS_URL` no app.

## ✨ Recursos

- 🎮 **Salas multiplayer** - Uma instância de `GameRoom` por código de sala (`room:<CODE>`)
- 🤝 **Modo Cooperativo** - O anfitrião joga e transmite o tabuleiro; os demais assistem e usam o chat
- 🏆 **Modo Competição** - Corrida de tempo **multi-rodada**: soma o tempo de cada rodada; **menor total vence**; ranking acumulado ao vivo (🥇🥈🥉)
- ⏱️ **Modo Time Trial** - Contra o relógio, **multi-rodada**: tempo fixo do host, **pontos acumulados** e término de rodada autoritativo via `alarm`
- 🚦 **Partidas multi-rodada + largada sincronizada** - N rodadas (1–20) com placar acumulado; cada rodada inicia com contagem regressiva 5→1 (`roundStartedAt` ancorado no futuro) e **avanço automático** entre rodadas
- 👑 **Migração de host** - Se o anfitrião sai, o membro mais antigo é promovido
- 🔒 **Conexão Única** - 1 userId = 1 conexão ativa (sessão antiga é substituída)
- 📡 **Broadcast** - Entrada/saída, estado do jogo, rodadas e ranking
- ⏱️ **Cronômetro sincronizado** - Servidor marca início/fim da rodada; clientes contam localmente em sincronia (sem broadcasts por segundo)
- 🛡️ **Anti-Spam** - Detecção automática de flood e repetição (apenas no chat)
- ⚡ **Hibernação** - Conexões persistem; o DO acorda ao receber mensagens
- 🌍 **Produção** - Deploy global instantâneo via Wrangler

## 🏗️ Arquitetura

```
worker.js              # Roteamento + validação (Upgrade header, Origin) + proxy
game-room.js           # Durable Object GameRoom (salas multiplayer)  ← principal
websocket-server.js    # Durable Object do chat global (legado)
client.js              # Cliente Node.js de teste (conecta no chat global)
exemplo-browser.html   # Demo browser
wrangler.toml          # Bindings dos DOs + migrations
```

O **estado canônico** de cada sala fica no storage do Durable Object (sobrevive à hibernação).
Os `Map`s em memória são reconstruídos vazios ao acordar — a busca de sockets é feita por
`ctx.getWebSockets()` + `deserializeAttachment()` (que persiste na hibernação).

## 🧭 Roteamento e Segurança (worker.js)

1. Exige header `Upgrade: websocket` (senão `426 Upgrade Required`)
2. Valida **Origin** contra uma allowlist (libera `localhost` em dev):
   - `https://termo.enresshou.dev`
   - `http://localhost:5175`
3. Roteia:
   - `/room/<CODE>` → valida `CODE` com `^[A-Z0-9]{4,6}$` → `GAME_ROOM.idFromName("room:<CODE>")`
   - demais caminhos → `WEBSOCKET_HIBERNATION_SERVER.idFromName("global-chat")`

## 🚀 Início Rápido

```bash
# Desenvolvimento local (wrangler dev — porta 3000)
pnpm dev

# Deploy em produção
pnpm deploy

# Cliente Node de teste (conecta no CHAT GLOBAL legado)
pnpm client          # produção
pnpm client:local    # local
```

> Requer **Node >= 22** e **Wrangler 4**. Autentique com `pnpm wrangler login` antes do deploy.

## 🎮 Salas Multiplayer (`GameRoom`)

### Modelo de autoridade

- O **servidor** é autoridade sobre: membros, host, `mode`, `seed`, `roundId` e o tipo de sala (`gameType`).
- O servidor **nunca conhece a palavra** — apenas `(mode, seed)`. Os clientes derivam a palavra do dicionário embutido via `getDailyWords`.
- **Cooperativo:** só o host roda o engine e transmite o `GameState`; o servidor **retransmite e persiste** (para late joiners / reconexão). A palavra é revelada a todos no fim da rodada.
- **Competição:** cada cliente roda o próprio engine e **reporta quando termina**; o servidor controla o ranking e decide o fim de cada rodada.
- **Time Trial:** como a competição, mas o servidor guarda o **limite de tempo** (`timeLimitMs`), **pontua** cada acerto (`computePoints`) e arma um **`alarm`** que encerra a **rodada** no fim do relógio (ver [Modo Time Trial](#modo-time-trial-contra-o-relógio)).
- **Multi-rodada:** competição e Time Trial são partidas de **N rodadas** com placar **acumulado** (`room.competition.cumulative`); o servidor pontua cada rodada (`scoreRound`) e **avança automaticamente** (ver [Ciclo da partida](#ciclo-da-partida-multi-rodada) e [Pontuação acumulada](#pontuação-acumulada-scoreround)).
- **Cronômetro / largada:** o servidor é autoridade do tempo da rodada (`roundStartedAt`/`roundEndedAt`) e ancora a largada **no futuro** para a contagem regressiva (ver [Largada e contagem regressiva](#largada-e-contagem-regressiva)); cada cliente ancora no próprio relógio e conta localmente (ver [Cronômetro sincronizado da rodada](#cronômetro-sincronizado-da-rodada)).

### Ciclo da partida (multi-rodada)

Uma partida competitiva tem **N rodadas** (`room.competition.totalRounds`, 1–20). A pontuação **acumula** em `room.competition.cumulative` e o conjunto de competidores é **fixado na largada** (`room.competition.competitors`).

1. **Início** (`start-match`, só host): exige **≥ 2 jogadores**; lê `rounds` (clamp 1–20, padrão 5), fixa os **competidores** (quem está na sala agora), gera `seed` + `roundId`, zera o placar e transmite `match-start`. A rodada 1 começa **após a contagem** (ver [Largada e contagem regressiva](#largada-e-contagem-regressiva)).
2. **Durante a rodada:** cada competidor resolve seu tabuleiro; ao terminar (acertar **ou** esgotar tentativas) envia `competitor-finished`. `room.competition.finishers` é o estado da **rodada corrente** (zerado a cada rodada).
3. **Fim da rodada** (`isRoundOver`): quando **todos os competidores ativos terminam**, **ou** (Competição) quando o pódio (1º/2º/3º) está completo e resta apenas **1** jogador. No Time Trial, o `alarm` do tempo também encerra a rodada.
4. **Pontuação** (`scoreRound`) é somada ao acumulado; então `endCurrentRound`:
   - se **restam rodadas** → prepara a próxima (novo `seed`/`roundId`, `finishers` zerado, nova largada futura) e transmite **`round-advanced`** com o ranking acumulado;
   - se foi a **última** → `status: "ended"` e transmite `match-end`.

```js
// Fim da RODADA (game-room.js)
roundEnds =
  stillTrying === 0 ||
  (gameType === "competition" && stillTrying === 1 && solvedCount >= PODIUM_SIZE /* 3 */)
// stillTrying = competidores ATIVOS (ainda na sala) que não terminaram a rodada
```

### Pontuação acumulada (`scoreRound`)

- **Time Trial:** soma os **pontos** de cada rodada (DNF = 0) em `totalPoints`; **maior total vence** (desempate pelo menor `totalMs`).
- **Competição (corrida de tempo):** soma o **tempo de resolução** em `totalMs`; **menor total vence**. Quem **não resolve** a rodada recebe `(maior tempo entre os solvers da rodada) + 60000ms`; se **ninguém** resolve, a rodada é **anulada** (todos +0).
- Só **competidores ativos** (ainda na sala) pontuam a cada rodada: quem entrou **depois** da largada apenas assiste; quem **sai** tem o placar **congelado**.

### Largada e contagem regressiva

Cada rodada (inclusive a 1ª) começa com uma **contagem regressiva de 5s** vista por todos. Para isso o servidor ancora o início **no futuro**:

- `roundStartedAt = Date.now() + COUNTDOWN_MS` (5s). As mensagens carregam `startsAt` (= `roundStartedAt`); o cliente roda a animação 5→1 "Vai!" até lá.
- O **relógio do Time Trial** e a medição de `solveMs` só contam **após** `roundStartedAt`; o `alarm` é agendado para `roundStartedAt + timeLimitMs`.
- `competitor-finished` recebido **antes** de `roundStartedAt` é **rejeitado** (não pontua/mede durante a contagem).
- As rodadas **avançam automaticamente** — ao encerrar uma, o servidor já prepara a próxima, sem ação do host.

### Cronômetro sincronizado da rodada

O servidor é a **autoridade do tempo**, garantindo que todos os jogadores vejam **o mesmo cronômetro** com latência mínima:

- **Competição / Time Trial:** o relógio de cada rodada começa **após a contagem** (`roundStartedAt`, igual para todos) e congela no fim da rodada.
- **Cooperativo:** começa na **1ª ação do host** (primeira `live-input`/`game-state`) — propagada a todos via `round-timing` — e congela quando o host conclui (`isGameOver`).
- O servidor guarda `roundStartedAt`/`roundEndedAt` (epoch ms) no storage e anexa um bloco `timer` às mensagens de rodada:

```js
timer = {
  startedAt,   // epoch ms (servidor) — início; null se ainda não começou
  endedAt,     // epoch ms (servidor) — fim; null se em andamento
  elapsedMs,   // decorrido no instante do envio (cliente ancora: startLocal = recebimento − elapsedMs)
  durationMs,  // duração final congelada (idêntica para todos) quando terminou
  limitMs,     // limite de tempo (Time Trial) → contagem regressiva; null nos demais modos
  serverNow,   // epoch ms (servidor) no instante do envio
}
```

- O cliente **ancora o início no próprio relógio** (`startLocal = recebimento − elapsedMs`) e conta localmente — **sem broadcasts por segundo** e imune a relógios desajustados. *Late joiners* e reconexões recebem o `timer` via `room-state`; trocas de host re-sincronizam via `round-timing`.

## ⏱️ Modo Time Trial (contra o relógio)

Variante competitiva com **tempo fixo**. Reusa o estado de competição (`room.competition`), com três adições no servidor:

1. **Limite de tempo:** no `start-match`, o host envia `timeLimitMs`; o servidor faz *clamp* em **30s–15min** (padrão 2min) e o guarda em `room.timeLimitMs`. O bloco `timer` passa a expor `limitMs` (o cliente mostra **contagem regressiva**).
2. **Término de rodada autoritativo (`alarm`):** o servidor agenda `ctx.storage.setAlarm(roundStartedAt + timeLimitMs)`. Quando dispara, `alarm()` marca quem não terminou como **DNF (0 pontos)**, pontua a rodada e **avança** (`round-advanced`) — ou encerra a partida (`match-end`) se foi a última. O `alarm` é o **único** uso do alarm do DO (re-armado a cada rodada) e é cancelado (`deleteAlarm`) se a rodada terminar antes (todos concluíram) ou se a sala fechar.
3. **Pontuação (só quem resolve pontua):**

```js
points = 1000                                   // base por resolver
       + Math.round(1000 * timeLeftMs / limit)  // até +1000 por tempo restante
       + 150 * attemptsLeft                      // 150 por tentativa não usada
// attemptsLeft = maxAttempts(modo) - tentativas usadas ; não-solvers = 0
```

Cada **rodada** termina quando **todos terminam** (sem encerramento por pódio, ao contrário da Competição) **ou** quando o `alarm` dispara; os **pontos somam** entre as rodadas. O ranking é por **pontos acumulados** (desempate pelo menor tempo total); `solveRank` fica `null` (a ordenação é feita no cliente). Cada finalista da rodada carrega `points` e `solveMs`.

> O modo **Cooperativo não** é afetado. A lógica competitiva (Competição **e** Time Trial) compartilha a máquina de rodadas, guardada por `isCompetitive`/`gameType`; o Time Trial adiciona o limite de tempo, a pontuação e o `alarm`.

## 📡 Protocolo de Mensagens

### Cliente → Servidor

| Tipo | Quem | Descrição |
|------|------|-----------|
| `join` | todos | Autentica (`userId`, `nickname`, `intent`, `mode?`, `gameType?`) |
| `message` | todos | Mensagem de chat (passa pelo anti-spam) |
| `game-state` | host (coop) | Snapshot do tabuleiro do host |
| `live-input` | host (coop) | Digitação ao vivo (efêmero, não persiste) |
| `new-round` | host (coop) | Nova palavra |
| `start-match` | host (competição/Time Trial) | Inicia a partida (≥ 2 jogadores; `rounds` 1–20; `timeLimitMs` no Time Trial) |
| `competitor-finished` | todos (competição/Time Trial) | Reporta fim da rodada (`solved`, `attempts`, `roundId`) |
| `get-room-state` | todos | Solicita snapshot da sala |
| `ping` | todos | Mede latência |

### Servidor → Cliente

> As mensagens de rodada (`room-state`, `game-state`, `new-round`, `match-start`, `round-advanced`, `competitor-finished`, `match-end`, `round-timing`) carregam o bloco **`timer`** do cronômetro (ver [Cronômetro sincronizado da rodada](#cronômetro-sincronizado-da-rodada)). As competitivas também trazem `round`/`totalRounds`/`startsAt`/`competitorIds`.

| Tipo | Descrição |
|------|-----------|
| `request-auth` | Pede autenticação ao conectar |
| `room-state` | Snapshot da sala (inclui `gameType`, `matchStatus`, `standings` acumuladas, `roundFinishers`, `round`/`totalRounds`, `startsAt`, `competitorIds`, `timer`) |
| `game-state` | Tabuleiro do host (coop) — relay/replay (+ `timer`) |
| `live-input` | Digitação ao vivo do host (coop) |
| `new-round` | Nova rodada iniciada (coop) (+ `timer`) |
| `match-start` | Partida (Competição/Time Trial) iniciada (`mode`, `seed`, `roundId`, `round`, `totalRounds`, `startsAt`, `competitorIds`, `timer` — `limitMs` no Time Trial) |
| `round-advanced` | 🆕 Rodada encerrada e próxima preparada (novo `seed`/`roundId`, `round`, `startsAt`, `standings` acumuladas, `roundFinishers`) (+ `timer`) |
| `competitor-finished` | Progresso da rodada (`roundFinishers` = quem terminou a rodada; `standings` = ranking acumulado; `solveMs` e, no Time Trial, `points`) (+ `timer`) |
| `match-end` | Partida encerrada — clientes revelam a palavra; `standings` = classificação **final acumulada** (+ `timer`; `reason: "timeout"` quando o tempo do Time Trial esgota) |
| `round-timing` | Sincroniza o cronômetro (início/fim) — usado no coop (1ª ação do host, fim da rodada) e após troca de host |
| `chat-message` | Mensagem de chat |
| `user-joined` / `user-left` | Entrada/saída de membros |
| `new-host` / `you-are-host` | Migração de host |
| `pong` | Resposta de latência |
| `session-replaced` | Conexão substituída por outra (mesmo userId) |
| `error` | Erro (com `code` e `message`) |

## 👑 Migração de Host e Conexão Única

- **Conexão única:** ao autenticar, sockets antigos do mesmo `userId` recebem `session-replaced` e são fechados.
- **Migração de host:** ao sair (sem outras conexões ativas), se era o host, o membro mais antigo (`joinedAt`) é promovido e recebe `you-are-host`; os demais recebem `new-host`.
- **Última saída:** quando o último membro sai, a sala é marcada como encerrada.

## 🛡️ Sistema Anti-Spam (chat)

**Detecção automática** (tentativas/jogadas **não** são limitadas):
- Flood (muitas mensagens rápidas — janela de 10s, máx. 10 msgs)
- Repetição (mesma mensagem 3x)
- Intervalo mínimo de 250ms entre mensagens

**Mute progressivo:** 1ª infração 5s → reincidência até 60s → reset após bom comportamento.

## ⚡ Hibernação e Persistência

- `ctx.acceptWebSocket()` habilita a Hibernação (conexões persistem inativas)
- `serializeAttachment()` mantém os dados de cada conexão durante a hibernação
- Estado canônico (`room`, `gameState`) em `ctx.storage` — sobrevive a reinícios do DO. O `room` inclui o cronômetro da rodada (`roundStartedAt`/`roundEndedAt`) e, no Time Trial, o limite (`timeLimitMs`), então *late joiners* e reconexões recuperam o tempo correto
- `room.competition` guarda o estado multi-rodada — `currentRound`/`totalRounds`, o placar acumulado (`cumulative`), os finalistas da rodada (`finishers`) e o conjunto fixo de `competitors` — sobrevivendo à hibernação entre rodadas
- Ao mudar o cronômetro, `room` e `gameState` são gravados **atomicamente** (`ctx.storage.put({ room, gameState })`), evitando estado inconsistente caso o DO hiberne/seja despejado entre escritas
- **Time Trial:** `ctx.storage.setAlarm()` agenda o término no fim do tempo; o `alarm()` é entregue mesmo após hibernação (cancelado via `deleteAlarm()` se a partida terminar antes)
- Sockets de um usuário são encontrados iterando `ctx.getWebSockets()`

```javascript
webSocketMessage(ws, message)  // Processa mensagens
webSocketClose(ws, ...)        // Desconexão + migração de host
webSocketError(ws, error)      // Trata erros
```

## ⚙️ Configuração (wrangler.toml)

```toml
name = "ws-cloudflare"
main = "worker.js"

[[durable_objects.bindings]]
name = "WEBSOCKET_HIBERNATION_SERVER"
class_name = "WebSocketHibernationServer"

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

# Migrations incrementais (SQLite-backed DOs) — nunca edite tags antigas
[[migrations]]
tag = "v1"
new_sqlite_classes = ["WebSocketHibernationServer"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["GameRoom"]
```

## 🖥️ Cliente Legado (chat global)

O `client.js` é um cliente Node de teste que conecta no **chat global** (não nas salas):

```bash
Digite seu nickname: João
[João] > Olá pessoal!    # Envia mensagem
[João] > /ping           # Latência
[João] > /stats          # Estatísticas
[João] > /sair           # Encerra
```

As **salas multiplayer** são consumidas pelo frontend `term-ooo` (rota `/sala/:code`), não por este CLI.

## 📚 Documentação

- **[QUICKSTART.md](docs/QUICKSTART.md)** - Guia rápido
- **[RECURSOS.md](docs/RECURSOS.md)** - API do WebSocket
- **[INTEGRACAO.md](docs/INTEGRACAO.md)** - Guia de integração técnica

## 💰 Custos (Free Tier)

**100% gratuito para uso moderado:**
- Workers: 100.000 requests/dia
- Durable Objects: 1M requests/mês
- WebSocket: ilimitado com hibernação

## 🐛 Troubleshooting

**"Upgrade Required" (426)** — use `wss://` (não `http://`).
**"Origin não autorizada" (403)** — adicione a origin em `worker.js` (`allowedOrigins`).
**"Código de sala inválido" (400)** — o código deve casar `^[A-Z0-9]{4,6}$`.
**Conexão falha local** — confira se o servidor está rodando (`pnpm dev`, porta 3000).
**Deploy falha** — autentique com `pnpm wrangler login`.

## 📖 Referência

- [Durable Objects - WebSocket Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/api/websockets/)

## 📄 Licença

MIT
