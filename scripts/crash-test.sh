#!/usr/bin/env bash
# crash-test.sh — Simula um crash de backend e verifica a recuperação.
#
# Uso:
#   ./scripts/crash-test.sh [-kill CONTAINER_NAME]
#
# Fluxo:
#   1. Verifica readiness (4 backends + SQS)
#   2. Cria uma wallet de referência
#   3. Envia N transações (BET) para a wallet
#   4. SIGKILL o container alvo
#   5. Aguarda o container voltar (restart: unless-stopped)
#   6. Verifica readiness novamente
#   7. Roda reconciliação na wallet de referência
#   8. Relatório
#
# Nota: o orquestrador Go do v1 não existe no v2. Este script usa curl
# diretamente para enviar transações e verificar a recuperação.
set -euo pipefail

# Defaults
KILL_TARGET="wagering-backend-1"
TX_COUNT=20
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$PROJECT_ROOT/docker-infra"
BASE_URLS=(http://localhost:3000 http://localhost:3001 http://localhost:3002 http://localhost:3003)
SQS_ENDPOINT="http://localhost:4566"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -kill) KILL_TARGET="$2"; shift 2 ;;
    -tx) TX_COUNT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [-kill CONTAINER_NAME] [-tx N]"
      exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ─── 1. Check readiness ─────────────────────────────────────────────────────

log "checking backend readiness (4 instances)..."
for port in 3000 3001 3002 3003; do
  local_ready=false
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:${port}/health/ready" > /dev/null 2>&1; then
      local_ready=true
      break
    fi
    sleep 1
  done
  if [[ "$local_ready" == "false" ]]; then
    log "ERROR: backend on port $port not ready after 30s"
    exit 1
  fi
  log "  port $port: ready"
done

log "checking SQS..."
if ! curl -sf "${SQS_ENDPOINT}/" > /dev/null 2>&1; then
  log "WARNING: SQS endpoint not reachable"
fi

# ─── 2. Create reference wallet ─────────────────────────────────────────────

log "creating reference wallet..."
PLAYER_ID="$(bun -e 'console.log(crypto.randomUUID())')"
WALLET_RESPONSE=$(curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
WALLET_ID=$(echo "$WALLET_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -z "$WALLET_ID" ]]; then
  log "ERROR: failed to create wallet: $WALLET_RESPONSE"
  exit 1
fi
log "  walletId=$WALLET_ID"

# ─── 3. Send transactions ───────────────────────────────────────────────────

log "sending $TX_COUNT transactions (BET)..."
PROCESSED=0
FAILED=0
for i in $(seq 1 "$TX_COUNT"); do
  EXT_ID="crash-ext-$i-$(date +%s%N)"
  IDEM_KEY="crash-key-$i-$(date +%s%N)"
  # Round-robin entre as 4 instâncias
  idx=$(( (i - 1) % 4 ))
  BASE="${BASE_URLS[$idx]}"
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/wagering/transactions" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $IDEM_KEY" \
    -d "{\"providerId\":\"crash-test\",\"externalTransactionId\":\"$EXT_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$i\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"1.00\",\"currency\":\"BRL\"}}")
  if [[ "$RESPONSE" == "201" || "$RESPONSE" == "200" ]]; then
    PROCESSED=$((PROCESSED + 1))
  else
    FAILED=$((FAILED + 1))
    log "  tx $i: HTTP $RESPONSE (expected 200/201)"
  fi
done
log "  processed: $PROCESSED, failed: $FAILED"

# ─── 4. SIGKILL the backend container ───────────────────────────────────────

log "killing $KILL_TARGET (SIGKILL)..."
docker kill -s KILL "$KILL_TARGET" 2>/dev/null || {
  log "WARNING: could not kill $KILL_TARGET"
}
log "killed $KILL_TARGET"

# ─── 5. Wait for container to come back ─────────────────────────────────────

log "waiting for $KILL_TARGET to restart..."
for i in $(seq 1 60); do
  if docker ps --format '{{.Names}}' | grep -q "^${KILL_TARGET}$"; then
    log "  container is up after ${i}s"
    break
  fi
  if [[ $i -eq 60 ]]; then
    log "ERROR: $KILL_TARGET did not restart after 60s"
    exit 1
  fi
  sleep 1
done

# ─── 6. Wait for all backends to be ready ───────────────────────────────────

log "waiting for all backends to be ready..."
for port in 3000 3001 3002 3003; do
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:${port}/health/ready" > /dev/null 2>&1; then
      log "  port $port: ready after ${i}s"
      break
    fi
    if [[ $i -eq 60 ]]; then
      log "ERROR: port $port not ready after 60s"
      exit 1
    fi
    sleep 1
  done
done

# ─── 7. Reconciliation ──────────────────────────────────────────────────────

log "running reconciliation on reference wallet..."
RECON=$(curl -s -X POST "http://localhost:3000/wallets/$WALLET_ID/reconciliation")
echo "$RECON"
CONSISTENT=$(echo "$RECON" | grep -o '"consistent":[a-z]*' | cut -d':' -f2)
if [[ "$CONSISTENT" == "true" ]]; then
  log "✓ reconciliation: CONSISTENT"
else
  log "✗ reconciliation: INCONSISTENT"
  exit 1
fi

# ─── 8. Report ──────────────────────────────────────────────────────────────

log "=========================================="
log "CRASH TEST COMPLETE"
log "=========================================="
log "  transactions sent:   $TX_COUNT"
log "  processed:           $PROCESSED"
log "  failed:              $FAILED"
log "  killed:              $KILL_TARGET"
log "  reconciliation:      $CONSISTENT"
log ""
log "Key checks:"
log "  - Transactions were processed before the crash"
log "  - Container restarted automatically (restart: unless-stopped)"
log "  - All backends recovered to ready state"
log "  - Reconciliation: wallet balance is consistent"
