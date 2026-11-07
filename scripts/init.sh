#!/usr/bin/env bash
# init.sh — Sobe a infraestrutura (PostgreSQL + LocalStack/SQS) e aplica as migrations.
#
# Uso:
#   ./scripts/init.sh              # sobe tudo + aplica migrations + valida
#   ./scripts/init.sh --reset      # apaga volumes e recria do zero
#   ./scripts/init.sh --rebuild    # rebuilda as imagens do backend antes de subir
#   ./scripts/init.sh --status     # apenas verifica o status
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/../docker-infra" && pwd)"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
PG_CONTAINER="wagering-postgres"
PG_USER="wagering"
PG_DB="wagering"
BACKEND_PORTS=(3000 3001 3002 3003)

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ─── Helpers ────────────────────────────────────────────────────────────────

pg_exec() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -c "$1" 2>/dev/null
}

wait_for_postgres() {
  log "aguardando PostgreSQL..."
  for i in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" > /dev/null 2>&1; then
      log "  PostgreSQL pronto"
      return 0
    fi
    if [[ $i -eq 30 ]]; then
      log "ERROR: PostgreSQL não ficou pronto após 30s"
      return 1
    fi
    sleep 1
  done
}

wait_for_localstack() {
  log "aguardando LocalStack..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:4566/ > /dev/null 2>&1; then
      log "  LocalStack pronto"
      return 0
    fi
    if [[ $i -eq 30 ]]; then
      log "WARNING: LocalStack não ficou pronto após 30s (as filas podem não ter sido criadas)"
      return 1
    fi
    sleep 1
  done
}

# ─── Validações ─────────────────────────────────────────────────────────────

# Valida o schema do banco: tabelas, constraints, índices e triggers.
# Retorna 0 se tudo ok, 1 se algo estiver faltando.
validate_schema() {
  local errors=0

  # 1. Tabelas (5)
  local tables
  tables=$(pg_exec "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages');")
  if [[ "$tables" == "5" ]]; then
    log "  ✓ Tabelas: 5/5"
  else
    log "  ✗ Tabelas: ${tables:-0}/5"
    errors=$((errors + 1))
  fi

  # 2. Constraints-chave (nomes explícitos definidos em 002_constraints.sql)
  local constraints
  constraints=$(pg_exec "
    SELECT count(*) FROM (
      SELECT 1 FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
        AND (
          (tc.table_name = 'wallets' AND tc.constraint_name = 'uq_wallets_player_currency')
          OR (tc.table_name = 'wager_transactions' AND tc.constraint_name = 'uq_wager_transactions_idempotency_key')
          OR (tc.table_name = 'wallet_ledger_entries' AND tc.constraint_name = 'uq_ledger_transaction')
          OR (tc.table_name = 'inbox_messages' AND tc.constraint_name = 'uq_inbox_consumer_message')
        )
      UNION ALL
      SELECT 1 FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'CHECK'
        AND (
          (tc.table_name = 'wallets' AND tc.constraint_name = 'chk_wallets_balance_non_negative')
          OR (tc.table_name = 'wager_transactions' AND tc.constraint_name = 'chk_wager_transactions_reference')
          OR (tc.table_name = 'wallet_ledger_entries' AND tc.constraint_name = 'chk_ledger_arithmetic')
        )
    ) AS c;
  ")
  if [[ "$constraints" == "7" ]]; then
    log "  ✓ Constraints: 7/7"
  else
    log "  ✗ Constraints: ${constraints:-0}/7"
    errors=$((errors + 1))
  fi

  # 3. Índices-chave
  local indexes
  indexes=$(pg_exec "
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'uq_wager_transactions_provider_ext',
        'idx_wager_transactions_pending_ref',
        'idx_ledger_wallet_created',
        'idx_outbox_pending',
        'idx_outbox_aggregate'
      );
  ")
  if [[ "$indexes" == "5" ]]; then
    log "  ✓ Índices: 5/5"
  else
    log "  ✗ Índices: ${indexes:-0}/5"
    errors=$((errors + 1))
  fi

  # 4. Triggers (imutabilidade do ledger + proteção de estado terminal)
  local triggers
  triggers=$(pg_exec "
    SELECT count(*) FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND trigger_name IN (
        'ledger_block_update',
        'ledger_block_delete',
        'wager_transactions_protect_terminal',
        'wallets_set_updated_at'
      );
  ")
  if [[ "$triggers" == "4" ]]; then
    log "  ✓ Triggers: 4/4"
  else
    log "  ✗ Triggers: ${triggers:-0}/4"
    errors=$((errors + 1))
  fi

  return $errors
}

# Valida as filas SQS (via LocalStack API).
validate_sqs() {
  local errors=0
  local queues
  queues=$(docker exec wagering-localstack awslocal sqs list-queues --region us-east-1 --query 'QueueUrls[]' --output text 2>/dev/null || echo "")

  if [[ "$queues" == *"wager-transactions.fifo"* ]]; then
    log "  ✓ Fila: wager-transactions.fifo"
  else
    log "  ✗ Fila: wager-transactions.fifo NÃO encontrada"
    errors=$((errors + 1))
  fi

  if [[ "$queues" == *"wager-transactions-dlq.fifo"* ]]; then
    log "  ✓ Fila: wager-transactions-dlq.fifo"
  else
    log "  ✗ Fila: wager-transactions-dlq.fifo NÃO encontrada"
    errors=$((errors + 1))
  fi

  return $errors
}

# Valida os backends (health/ready nas 3 portas).
validate_backends() {
  local errors=0
  for port in "${BACKEND_PORTS[@]}"; do
    if curl -sf "http://localhost:${port}/health/ready" > /dev/null 2>&1; then
      log "  ✓ Backend :${port} ready"
    else
      log "  ✗ Backend :${port} NÃO ready"
      errors=$((errors + 1))
    fi
  done
  return $errors
}

# Validação completa (schema + SQS + backends).
validate_all() {
  log "validando schema do banco..."
  local schema_ok=true
  validate_schema || schema_ok=false

  log "validando filas SQS..."
  local sqs_ok=true
  validate_sqs || sqs_ok=false

  log "validando backends..."
  local backends_ok=true
  validate_backends || backends_ok=false

  if [[ "$schema_ok" == "true" && "$sqs_ok" == "true" && "$backends_ok" == "true" ]]; then
    log "✓ Validação completa: OK"
    return 0
  else
    log "✗ Validação completa: FALHOU"
    return 1
  fi
}

# ─── Status ─────────────────────────────────────────────────────────────────

status() {
  log "status da infraestrutura:"
  cd "$COMPOSE_DIR"
  docker compose ps
  echo
  validate_all
}

# ─── Reset ──────────────────────────────────────────────────────────────────

reset() {
  log "apagando volumes e recriando do zero..."
  cd "$COMPOSE_DIR"
  docker compose down -v
  log "volumes apagados"
}

# ─── Migrations ─────────────────────────────────────────────────────────────

apply_migrations() {
  log "aplicando migrations..."
  cd "$COMPOSE_DIR"

  wait_for_postgres || return 1

  # Aplica cada migration em ordem
  local applied=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f")
    log "  aplicando $name..."
    if docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < "$f"; then
      log "    ✓ $name"
      applied=$((applied + 1))
    else
      log "    ✗ $name FALHOU"
      return 1
    fi
  done

  if [[ $applied -eq 0 ]]; then
    log "  (nenhuma migration encontrada em $MIGRATIONS_DIR)"
  else
    log "  $applied migration(s) aplicada(s)"
  fi
  return 0
}

# ─── Up ─────────────────────────────────────────────────────────────────────

rebuild_backends() {
  log "rebuildando imagens do backend..."
  cd "$COMPOSE_DIR"
  docker compose build backend-1 backend-2 backend-3 backend-4
  log "imagens rebuildadas"
}

up_infra() {
  local rebuild=false
  for arg in "$@"; do
    case "$arg" in
      --rebuild) rebuild=true ;;
    esac
  done

  if [[ "$rebuild" == "true" ]]; then
    rebuild_backends || return 1
  fi

  log "subindo infraestrutura (PostgreSQL + LocalStack)..."
  cd "$COMPOSE_DIR"
  docker compose up -d

  wait_for_postgres || return 1
  wait_for_localstack || true  # warning, não bloqueia (filas podem ser recriadas)

  # Aplica migrations
  if ! apply_migrations; then
    log "ERROR: migrations falharam. Infra em estado parcial."
    return 1
  fi

  # Validação completa
  echo
  if ! validate_all; then
    log "ERROR: validação pós-init falhou. Verifique os itens acima."
    return 1
  fi

  return 0
}

# ─── Main ───────────────────────────────────────────────────────────────────

main() {
  local action="up"
  local rebuild=false
  for arg in "$@"; do
    case "$arg" in
      --reset)   action="reset" ;;
      --rebuild) rebuild=true ;;
      --status)  action="status" ;;
      --help|-h)
        echo "Uso: $0 [--reset|--rebuild|--status]"
        echo "  (sem flags)   sobe a infra + aplica migrations + valida"
        echo "  --reset       apaga volumes e recria do zero"
        echo "  --rebuild     rebuilda as imagens do backend antes de subir"
        echo "  --status      apenas verifica o status"
        exit 0
        ;;
      *) echo "Flag desconhecida: $arg"; exit 1 ;;
    esac
  done

  case "$action" in
    status)
      status
      ;;
    reset)
      reset
      # Depois do reset, sobe tudo de novo
      if ! up_infra; then
        log "ERROR: init após reset falhou. Infra em estado parcial."
        exit 1
      fi
      ;;
    up)
      if [[ "$rebuild" == "true" ]]; then
        up_infra --rebuild || exit 1
      else
        up_infra || exit 1
      fi
      ;;
  esac
}

main "$@"
