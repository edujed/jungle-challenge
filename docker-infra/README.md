# Infraestrutura Local

PostgreSQL 16 + LocalStack (SQS) + NGINX (load balancer) + 4 backends para
desenvolvimento e testes.

## Subir

```bash
cd infra
docker compose up -d
```

Aguarde o healthcheck do LocalStack passar (~15s). O serviço `sqs-bootstrap`
cria as filas automaticamente e sai.

Verifique:

```bash
# Postgres
docker compose exec postgres pg_isready -U wagering -d wagering

# SQS
docker compose exec localstack awslocal sqs list-queues --region us-east-1

# NGINX (load balancer)
curl -s http://localhost:8080/health/live

# Backend direto (sem LB)
curl -s http://localhost:3000/health/live
```

## Filas criadas

| Fila | Tipo | Dedup | Observações |
|---|---|---|---|
| `wager-transactions.fifo` | FIFO | `ContentBasedDeduplication=true` | Fila principal. `FifoThroughputPerMessage=1` (ordenação por group ID). |
| `wager-transactions-dlq.fifo` | FIFO | `ContentBasedDeduplication=true` | Dead-letter queue. Redrive após 5 receives. |

Redrive policy: `maxReceiveCount=5` → mensagem vai para a DLQ após 5 tentativas de receive.

## Migrations

O diretório `../migrations/` é montado em `/docker-entrypoint-initdb.d/`.
Os scripts `.sql` são executados **apenas no primeiro boot** (quando o data
directory está vazio). Para re-aplicar migrations após alterar o schema:

```bash
docker compose down -v   # apaga o volume
docker compose up -d     # recria + re-aplica migrations
```

## Parar

```bash
docker compose down          # parar (dados persistem)
docker compose down -v       # parar + apagar dados (postgres + localstack)
```

## Recriar filas (sem apagar dados do postgres)

```bash
docker compose run --rm sqs-bootstrap
```

## Endpoints

| Serviço | Endpoint | Observações |
|---|---|---|
| **NGINX (LB)** | `http://localhost:8080` | **Use este endpoint no client Go.** Round-robin entre 4 backends. |
| Backend 1 | `http://localhost:3000` | Direto (sem LB). `X-Instance-Id: inst-1` |
| Backend 2 | `http://localhost:3001` | Direto (sem LB). `X-Instance-Id: inst-2` |
| Backend 3 | `http://localhost:3002` | Direto (sem LB). `X-Instance-Id: inst-3` |
| Backend 4 | `http://localhost:3003` | Direto (sem LB). `X-Instance-Id: inst-4` |
| PostgreSQL | `localhost:5432` | db: `wagering`, user: `wagering`, pass: `wagering` |
| SQS (LocalStack) | `http://localhost:4566` | Cada backend consome diretamente (sem LB). |

## Variáveis de ambiente

Definidas em `.env` (mesmo diretório). O `docker compose` lê automaticamente.
Os clientes Go usam os mesmos valores:

```bash
# Exemplo: rodar o cliente blackjack (via NGINX LB)
cd clients
go run ./tables/blackjack \
  -base http://localhost:8080 \
  -sqs http://localhost:4566 \
  -sqs-queue wager-transactions.fifo
```

## Load Balancing (NGINX)

O NGINX distribui a carga HTTP entre as 4 instâncias do backend com
**round-robin**. O client Go conecta em **uma única URL** (`http://localhost:8080`).

### Header `X-Instance-Id`

Cada backend adiciona o header `X-Instance-Id` em toda resposta (ex.:
`inst-1`). O client Go lê este header e agrega a distribuição por instância
no relatório final:

```json
{
  "instance_distribution": {
    "inst-1": 25012,
    "inst-2": 25008,
    "inst-3": 25001,
    "inst-4": 24979
  }
}
```

### Failover

Se um backend falhar (`max_fails=3` em 10s), o NGINX o remove do pool e
redireciona o tráfego para os restantes. O teste de crash recovery (matar 1
de 4 containers) é trivial: o NGINX detecta a falha e redistribui.

### SQS não passa pelo NGINX

Cada instância consome diretamente da fila SQS. O SQS é o load balancer
natural para o canal assíncrono — não há necessidade de proxy.
