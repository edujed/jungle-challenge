#!/usr/bin/env bash
# Smoke test: sobe a app na porta 3999, testa os endpoints, derruba.
#
# Rotas reais do app v2 (NestJS):
#   GET  /health/live
#   GET  /health/ready
#   POST /wallets
#   GET  /wallets/:walletId
#   GET  /wallets/:walletId/ledger
#   POST /wallets/:walletId/reconciliation
#   POST /wagering/transactions
#   GET  /wagering/transactions/:transactionId
#   GET  /providers/:providerId/wagering/transactions/:externalTransactionId
#
# Kinds válidos: OPENING | BET | WIN | LOSS | REFUND | ROLLBACK
# (playerId e walletId devem ser UUIDs válidos)
set -uo pipefail

cd "$(dirname "$0")/.."

export PORT=3999
export DATABASE_URL="postgresql://wagering:wagering@localhost:5432/wagering"
export INSTANCE_ID="smoke-test"

LOG=/tmp/smoke-app.log
: > "$LOG"

# UUIDs válidos (o schema exige UUID para playerId e walletId)
PLAYER_ID="$(bun -e 'console.log(crypto.randomUUID())')"
WALLET_ID="$(bun -e 'console.log(crypto.randomUUID())')"
# Chave de idempotência e externalTransactionId únicos por execução
# (evita conflito com execuções anteriores — o banco persiste entre runs)
RUN_ID="$(date +%s%N)"
IDEMPOTENCY_KEY="smoke-key-$RUN_ID"
EXT_TX_ID="ext-smoke-$RUN_ID"

bun src/main.ts > "$LOG" 2>&1 &
APP_PID=$!

# Aguarda o server subir (até 15s)
for i in $(seq 1 30); do
  if curl -sf http://localhost:3999/health/live > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "=== 1. Liveness (/health/live) ==="
curl -s -i http://localhost:3999/health/live
echo

echo "=== 2. Readiness (/health/ready) ==="
curl -s -i http://localhost:3999/health/ready
echo

echo "=== 3. Criar wallet (POST /wallets) ==="
echo "playerId=$PLAYER_ID"
WALLET=$(curl -s -X POST http://localhost:3999/wallets \
  -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo "$WALLET"
WALLET_ID=$(echo "$WALLET" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "walletId=$WALLET_ID"

echo "=== 4. Consultar wallet (GET /wallets/:id) ==="
curl -s -i "http://localhost:3999/wallets/$WALLET_ID"
echo

echo "=== 5. Submeter transação (POST /wagering/transactions, kind=BET) ==="
curl -s -i -X POST http://localhost:3999/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"providerId\":\"prov-1\",\"externalTransactionId\":\"$EXT_TX_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
echo

echo "=== 6. Replay idempotente (mesma Idempotency-Key) ==="
curl -s -i -X POST http://localhost:3999/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"providerId\":\"prov-1\",\"externalTransactionId\":\"$EXT_TX_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
echo

echo "=== 7. Reconciliação (POST /wallets/:id/reconciliation) ==="
curl -s -i -X POST "http://localhost:3999/wallets/$WALLET_ID/reconciliation"
echo

echo "=== 8. Headers (X-Instance-Id / X-Correlation-Id) ==="
curl -s -D - -o /dev/null http://localhost:3999/health/live | grep -iE "x-instance-id|x-correlation-id"

echo "=== 9. Log estruturado (últimas linhas) ==="
tail -20 "$LOG"

# Derruba a app
kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
echo "=== App encerrada (PID $APP_PID) ==="
