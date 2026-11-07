# Stress Client — Distributed Wagering Processor

Cliente de stress test para o backend do desafio (Distributed Wagering Processor). Simula tráfego realista de provedores de jogos (slots, crash, blackjack, roleta) contra múltiplas instâncias do backend, exercitando os dois canais de ingestão (HTTP e SQS), e valida a consistência financeira ao final de cada run.

Escrito em **Go** (módulo `github.com/jungle-gaming/wagering-clients`), sem dependências além do AWS SDK v2 para SQS.

---

## 1. Visão Geral

O stress client tem dois modos de operação:

| Modo | Binário | Uso |
|------|---------|-----|
| **Standalone** | `tables/<game>/main.go` | Uma mesa por processo, com flags de CLI. Bom para isolar um perfil de jogo. |
| **Orquestrador** | `orchestrator/main.go` | Todas as mesas (ou um subconjunto) em paralelo, cada uma com N instâncias concorrentes, reconciliação global e relatório único. |

Em ambos os modos, o fluxo é:

1. **Validação de conectividade** — `GET /health/ready` em todas as instâncias do backend + verificação da fila SQS.
2. **Criação de wallets** — wallets sintéticas e determinísticas (UUID v4 derivado do índice do jogador), criadas em paralelo (16 workers). Reexecuções reaproveitam as mesmas wallets via 409.
3. **Simulação de rodadas** — cada mesa gera rodadas de jogo; cada jogador aposta e recebe um resultado (WIN/LOSS/REFUND/ROLLBACK), enviado via HTTP ou SQS conforme o perfil da mesa.
4. **Reconciliação** — `POST /wallets/:id/reconciliation` para todas as wallets (16 workers) e verificação de invariantes globais.
5. **Relatório** — JSON com contadores, valores agregados, percentis de latência, distribuição por instância e resultado das invariantes.

### Princípios

- **Money como inteiros (cents)** — sem `float64` em valores monetários; a API usa strings decimais com 2 casas.
- **Idempotência no cliente** — cada transação carrega `Idempotency-Key` (HTTP) ou `MessageDeduplicationId` (SQS), derivada de `providerId:externalTransactionId`.
- **Falhas de transporte ≠ rejeições de negócio** — 422/409/202 são contadas como categorias; só erros de rede/5xx contam como falha de envio.
- **Métricas por mesa** — contadores atômicos por mesa (`TableProgress`), evitando poluição entre mesas; percentis de latência são globais (`Metrics`).
- **Cancelamento cooperativo** — `SIGINT`/`SIGTERM` cancelam o `context`; rodadas em andamento terminam e o resultado parcial é reportado.

---

## 2. Stack

| Camada | Tecnologia |
|--------|-----------|
| Linguagem | Go 1.26 |
| HTTP | `net/http` (timeout 10s, retry com backoff exponencial em 5xx/erros de conexão) |
| SQS | `aws-sdk-go-v2` (FIFO, `MessageGroupId` = wallet, dedup por mensagem) |
| Rate limiting | Token bucket próprio (`core/sqs.go`) — protege o LocalStack, que tem throughput muito menor que o SQS real |
| Money | `int64` cents + conversão para string decimal (2 casas) |
| RNG | `rand.Rand` protegido por mutex (`lockedRand`) — uma instância por mesa |
| Logs | Logger próprio, thread-safe, stdout + arquivo opcional, níveis debug/info/warn/error |

### Por que Go?

- Goroutines + channels mapeiam diretamente o modelo de carga: N jogadores por rodada, M mesas em paralelo, K instâncias por mesa.
- Sem framework: o cliente é um binário único por mesa + um orquestrador, o que simplifica deploy e execução em CI.
- `sync/atomic` para contadores sem lock no hot-path de envio.

---

## 3. Arquitetura de Alto Nível

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Orchestrator (main)                        │
│  valida conectividade → seleciona mesas → roda em paralelo          │
│  agrega resultados → reconcilia → invariantes → relatório JSON      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (uma goroutine por mesa, N instâncias por mesa)
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ FortuneChimp │      │   Blackjack  │      │    Crash     │  ... (uma por perfil)
│  (HTTP)      │      │   (SQS)      │      │   (SQS)      │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │  RunRound()         │                     │
       ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        core.BaseTable                               │
│  ciclo de vida: wallets → loop de rodadas → resultado final          │
│  SendTransaction() → escolhe canal (HTTP/SQS) e classifica resposta  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  HTTPClient  │      │ SQSProducer  │      │   Metrics    │
│ round-robin  │      │ FIFO + rate  │      │ contadores + │
│ retry 5xx    │      │ limiter      │      │ percentis    │
└──────┬───────┘      └──────┬───────┘      └──────────────┘
       │                     │
       ▼                     ▼
  Backend (N instâncias)   LocalStack SQS (wager-transactions.fifo)
```

### Componentes do `core`

| Arquivo | Responsabilidade |
|---------|-----------------|
| `core.go` | `NewCore()` — entry point; monta HTTP (com readiness check) e SQS opcional |
| `config.go` | `Config` — configuração comum (URLs, SQS, duração, relatório, auth) |
| `http.go` | `HTTPClient` — round-robin entre instâncias, retry com backoff + jitter, Bearer token, `Idempotency-Key`, connection pooling (`MaxConnsPerHost: 200`) |
| `sqs.go` | `SQSProducer` — envio FIFO com dedup, retry em rate-limit, token bucket, connection pooling (`MaxConnsPerHost: 200`) |
| `table.go` | `Table` (interface), `BaseTable` (ciclo de vida genérico), `SendTransaction`, `TableProgress`, `lockedRand` |
| `money.go` | `Money` (cents), parse/formatação decimal, `RandomMoney` |
| `metrics.go` | `Metrics` — contadores atômicos globais + percentis P50/P95/P99 |
| `instances.go` | `InstanceTracker` — distribuição de tráfego HTTP por instância (via header `X-Instance-Id`) |
| `reconcile.go` | `ReconcileAll` — reconciliação concorrente de todas as wallets |
| `invariants.go` | `CheckInvariants` — invariantes financeiras globais |
| `report.go` | `WriteReport` — relatório JSON |
| `logger.go` | `Logger` — thread-safe, multi-destino |

---

## 4. Perfis de Mesa (Metodologia de Carga)

Cada mesa implementa `core.Table` (apenas `RunRound`) e define um **perfil de carga** distinto, cobrindo os cenários exigidos pelo desafio:

| Mesa | Canal | Perfil |
|------|-------|--------|
| `fortune-chimp` | HTTP | Slots: BET → WIN (8%, mult 2x). Sem reversões. |
| `fortune-chimp-v2` | SQS | Slots via fila: BET → WIN (10%, mult 2x). |
| `blackjack` | SQS | BET → WIN (45%) / LOSS / PUSH (55%); REFUND (2% das rodadas) ou ROLLBACK (1%); **30% das reversões chegam antes da BET** (out-of-order). |
| `roulette` | **Misto** (HTTP/SQS por paridade do jogador) | BET → WIN (25%, mult 3x) / LOSS; REFUND em massa quando a rodada é anulada (2%); **20% dos REFUND chegam antes da BET**. |
| `crash` | SQS | BET → WIN (50%, multiplicador variável 1.01x–49.99x) / LOSS; ROLLBACK em massa em 1% das rodadas (falha do servidor de crash); **10% dos ROLLBACK chegam antes da BET**. |

### Mecanismos de estresse

- **Out-of-order** — reversões (REFUND/ROLLBACK) enviadas antes da BET de referência, com sleep aleatório (0–3s) para ampliar a janela de race. Exercita o `pending-reference` do backend.
- **Bursts** — REFUND/ROLLBACK em massa (todas as apostas da rodada) exercitam créditos simultâneos no mesmo wallet.
- **Hot wallet** (flag `-hot-wallet`) — 80% das apostas concentradas em um único wallet, exercitando o update atômico condicionado sob contenção.
- **Jitter** — o orquestrador aplica ±7% de variação no número de jogadores por rodada (`jitterInt`).
- **Múltiplas instâncias por mesa** — `Instances: 10` no orquestrador: cada instância tem wallets disjuntas (namespace no player ID) e loop de rodadas próprio; `PlayersPerRound` é dividido entre elas.
- **Canal misto** — `roulette` alterna HTTP/SQS por jogador, exercitando os dois caminhos de ingestão simultaneamente.

### Idempotência

- `externalTransactionId` é determinístico por (mesa, rodada, jogador, tipo): ex. `crash-r42-p7-bet`.
- `Idempotency-Key` (HTTP) = `providerId:externalTransactionId`; `MessageDeduplicationId` (SQS) = `walletId-<unixnano>`.
- Reenvios com a mesma key exercitam o caminho de dedup do backend (409 / inbox).

---

## 5. Estratégia de Concorrência (no cliente)

- **Por rodada**: uma goroutine por jogador (`sync.WaitGroup`), erros coletados em `errCh` com buffer dimensionado.
- **Por mesa**: `BaseTable.Run` executa o loop de rodadas sequencialmente (com `RoundDuration` opcional entre rodadas); a concorrência está dentro da rodada.
- **Por orquestrador**: uma goroutine por mesa, N goroutines por instância; resultados agregados por soma de contadores e adição decimal.
- **RNG**: `lockedRand` (mutex) — uma instância por mesa, compartilhada pelas goroutines da rodada.
- **Contadores**: `sync/atomic` (`TableProgress`), sem lock no hot-path.
- **HTTP**: round-robin simples (não thread-safe, mas chamado sob a mesma goroutine por request — na prática cada goroutine de jogador chama `doRequest` que lê/incrementa `rr`; o índice pode "pular" valores, o que é aceitável para distribuição de carga).
- **Connection pooling** (HTTP e SQS): `http.Transport` com `MaxConnsPerHost: 200`, `MaxIdleConnsPerHost: 50`, `IdleConnTimeout: 90s`. Sem esse limite, ~5.000 goroutines × rajadas de requests criam milhares de conexões TCP novas por segundo, esgotando o range de portas efêmeras do host (32768–60999 = 28k portas) e causando `connection refused` / `connection reset by peer`.
- **Retry com backoff + jitter**: 5 tentativas, base 200ms, multiplicação exponencial, jitter 0–100ms (evita thundering herd na recuperação).

> Nota: o round-robin do `HTTPClient` não é protegido por mutex; sob concorrência o índice pode ser incrementado de forma não atômica. Isso é aceitável para o objetivo de distribuição de carga (qualquer instância é válido), mas não garante distribuição exata.

---

## 6. Reconciliação e Invariantes

Ao final de cada run (standalone ou orquestrador):

1. **Reconciliação** (`ReconcileAll`) — para cada wallet, `POST /wallets/:id/reconciliation` compara o saldo armazenado com o saldo calculado a partir do ledger. 16 workers, erros agregados.
2. **Invariante `balance_consistency`** — PASS se nenhuma wallet reportar inconsistência.
3. **Invariante `no_negative_balance`** — consulta `GET /wallets/:id` para todas as wallets (16 workers) e falha se alguma tiver saldo negativo.

O resultado das invariantes entra no relatório JSON e no log.

---

## 7. Métricas e Relatório

### Métricas globais (`Metrics`)

Contadores atômicos: `totalRequests`, `success`, `errors`, `duplicates` (409), `rejections` (422), `pendingRef` (202), `conflicts` — mais latências coletadas para percentis **P50/P95/P99**.

### Métricas por mesa (`TableProgress`)

Contadores: bets, wins, losses, refunds, rollbacks, rejections, duplicates, sendFailures — e valores em cents (bets, wins, refunds, rollbacks) para auditoria. `SendFailures` conta envios SQS que falharam após todos os retries (mensagem **nunca chegou** à fila — distinto de 409).

### Relatório

- **Standalone**: `core.WriteReport` → `{ table: TableResult, invariants: [...] }`.
- **Orquestrador**: JSON único com `timestamp`, `duration`, `instances`, `tables` (por mesa: contadores, valores, percentis, `instance_distribution`), `invariants`, `totalTransactions`, `totalErrors`, `instance_distribution` global.
- **Relatórios parciais**: a cada `PartialReportInterval` apostas (100 no orquestrador), um `TableSnapshot` é anexado em `/tmp/test-reports/partial-<table>.jsonl` — útil para monitorar runs longos.

### Distribuição por instância

`InstanceTracker` conta respostas HTTP por valor do header `X-Instance-Id` (definido pelo backend, ADR-011), global e por mesa. SQS não passa pelo load balancer, então só o tráfego HTTP é medido.

---

## 8. Como Executar

### Pré-requisitos

- Go 1.26+
- Backend rodando (múltiplas instâncias ou atrás de LB)
- LocalStack (ou MiniStack) com a fila FIFO `wager-transactions.fifo` criada

### Orquestrador (recomendado)

```bash
cd stress-client

go run ./orchestrator \
  -base "http://localhost:8080" \
  -sqs http://localhost:4566 \
  -sqs-queue wager-transactions.fifo \
  -duration 120 \
  -tables all \
  -report /tmp/stress-report.json \
  -log-file /tmp/stress.log \
  -log-level info
```

Flags:

| Flag | Default | Descrição |
|------|---------|-----------|
| `-base` | `http://localhost:8080` | URLs do backend separadas por vírgula (round-robin) |
| `-sqs` | `http://localhost:4566` | Endpoint SQS (LocalStack) |
| `-sqs-queue` | `wager-transactions.fifo` | Nome da fila FIFO |
| `-duration` | `120` | Duração máxima em segundos |
| `-tables` | `all` | Subconjunto: `fortune-chimp,blackjack,...` |
| `-report` | — | Caminho do relatório JSON final |
| `-log-file` | — | Arquivo de log (stdout sempre ativo) |
| `-log-level` | `info` | `debug`, `info`, `warn`, `error` |
| `-token` | `$AUTH_TOKEN` | Bearer token (default: dev token) |
| `-verbose` | `false` | Logs detalhados por mesa |

### Standalone (uma mesa)

```bash
go run ./tables/crash \
  -base "http://localhost:3000,http://localhost:3001" \
  -sqs http://localhost:4566 \
  -players 100 -rounds 200 \
  -min-bet 0.50 -max-bet 50.00 \
  -report /tmp/crash-report.json
```

Flags comuns: `-base`, `-sqs`, `-sqs-queue`, `-players`, `-rounds`, `-min-bet`, `-max-bet`, `-win-rate`, `-round-duration` (ms), `-hot-wallet`, `-duration` (s), `-report`, `-verbose`.

### Variáveis de ambiente

| Variável | Uso |
|----------|-----|
| `AUTH_TOKEN` | Bearer token (fallback: `stress-test-dev-token`, aceito pelo `NoopTokenValidator` do backend com `AUTH_ENABLED=false`) |

---

## 9. Estrutura de Pastas

```
stress-client/
├── go.mod / go.sum
├── core/                          # Biblioteca compartilhada (sem main)
│   ├── core.go                    # NewCore() — montagem de HTTP + SQS
│   ├── config.go                  # Config + ParseBaseURLs
│   ├── http.go                    # HTTPClient (round-robin, retry, idempotency)
│   ├── sqs.go                     # SQSProducer (FIFO, dedup, rate limiter)
│   ├── table.go                   # Table, BaseTable, SendTransaction, TableProgress, lockedRand
│   ├── money.go                   # Money (cents) + conversão decimal
│   ├── metrics.go                 # Metrics globais + percentis
│   ├── instances.go               # InstanceTracker (X-Instance-Id)
│   ├── reconcile.go               # ReconcileAll
│   ├── invariants.go              # CheckInvariants
│   ├── report.go                  # WriteReport
│   └── logger.go                  # Logger thread-safe
├── tables/                        # CLIs standalone (um binário por jogo)
│   ├── fortune-chimp/{game,main}.go
│   ├── fortune-chimp-v2/{game,main}.go
│   ├── blackjack/{game,main}.go
│   ├── roulette/{game,main}.go
│   └── crash/{game,main}.go
└── orchestrator/
    ├── main.go                    # Orquestrador (specs, agregação, relatório)
    └── tables/                    # Wrappers de construção p/ o orquestrador
        ├── fortune-chimp.go
        ├── fortune-chimp-v2.go
        ├── blackjack.go
        ├── roulette.go
        └── crash.go
```

### Adicionando uma nova mesa

1. Crie `tables/<game>/game.go` com um tipo que embute `*core.BaseTable` e implemente `RunRound` (veja `crash/game.go` como referência completa).
2. Crie `tables/<game>/main.go` (CLI standalone) — copie de uma mesa existente e ajuste `gameID`/`providerID` e os defaults.
3. Registre no orquestrador: adicione um `TableSpec` em `defaultSpecs()` (`orchestrator/main.go`) e um wrapper em `orchestrator/tables/<game>.go`.

---

## 10. Limitações e Trade-offs

| Ponto | Descrição |
|-------|-----------|
| **Rate limit SQS fixo** | 1500 msg/s no orquestrador — calibrado para o LocalStack, não para o SQS real. Em produção o limite deveria ser maior/removido. |
| **Connection pooling fixo** | `MaxConnsPerHost: 200` em HTTP e SQS — calibrado para o host local. Em produção com mais instâncias ou mais carga, o valor pode precisar ser ajustado. |
| **Round-robin não atômico** | O índice do `HTTPClient` pode ser incrementado de forma não thread-safe; aceitável para distribuição de carga, não para métricas exatas de balanceamento. |
| **Percentis globais** | P50/P95/P99 são compartilhados entre mesas (uma única `Metrics` no `Core`); o relatório por mesa repete os mesmos percentis. Contadores de resultado são por mesa. |
| **SQS fire-and-forget** | O cliente não confirma o processamento das mensagens SQS; a validação acontece na reconciliação final. |
| **Wallets com saldo fixo** | Saldo inicial de R$ 100,00; mesas com `MaxBetCents` alto podem esgotar wallets (rejeições 422 por saldo insuficiente são esperadas e contadas). |
| **Sem replay de falhas** | `SendFailures` são reportadas, mas as mensagens não são reenviadas (o objetivo é medir, não garantir entrega). |

---

## 11. Referências

- `../ARCHITECTURE.md` — arquitetura do backend (hot-path, idempotência, outbox, SQS).
- `../README.md` — especificação do desafio.
- `core/table.go` — contrato `Table`/`BaseTable` (fonte de verdade para novas mesas).
