#!/usr/bin/env bash
# test.sh — Roda a suíte completa de testes do desafio.
#
# Uso:
#   ./scripts/test.sh                 # tudo: unit + integration + concurrency
#   ./scripts/test.sh --unit          # apenas testes de unidade
#   ./scripts/test.sh --integration   # apenas testes de integração (Postgres + LocalStack)
#   ./scripts/test.sh --concurrency   # apenas testes de concorrência
#   ./scripts/test.sh --reset         # reseta a infra antes de rodar
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
RUN_UNIT=false
RUN_INTEGRATION=false
RUN_CONCURRENCY=false
RESET=false
REPORT_DIR="/tmp/test-reports"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)        RUN_UNIT=true ;;
    --integration) RUN_INTEGRATION=true ;;
    --concurrency) RUN_CONCURRENCY=true ;;
    --reset)       RESET=true ;;
    --help|-h)
      echo "Uso: $0 [--unit|--integration|--concurrency] [--reset]"
      echo "  (sem flags)       roda tudo (unit + integration + concurrency)"
      echo "  --unit            apenas testes de unidade (sem infra)"
      echo "  --integration     apenas testes de integração (requer infra)"
      echo "  --concurrency     apenas testes de concorrência (requer infra)"
      echo "  --reset           reseta a infra antes de rodar"
      exit 0
      ;;
    *) echo "Flag desconhecida: $1"; exit 1 ;;
  esac
  shift
done

# Sem flags = roda tudo
if [[ "$RUN_UNIT" == "false" && "$RUN_INTEGRATION" == "false" && "$RUN_CONCURRENCY" == "false" ]]; then
  RUN_UNIT=true
  RUN_INTEGRATION=true
  RUN_CONCURRENCY=true
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }
section() { echo; echo "════════════════════════════════════════════════"; echo "  $*"; echo "════════════════════════════════════════════════"; }

mkdir -p "$REPORT_DIR"
START_TIME=$(date +%s)
FAILURES=()

# ─── Pré-requisito: infra ───────────────────────────────────────────────────

ensure_infra() {
  if curl -sf http://localhost:4566/ > /dev/null 2>&1 && \
     docker exec wagering-postgres pg_isready -U wagering -d wagering > /dev/null 2>&1; then
    log "infra já está rodando"
    return 0
  fi
  log "infra não está rodando — subindo..."
  "$SCRIPT_DIR/init.sh"
}

# ─── 1. Unit tests ──────────────────────────────────────────────────────────

run_unit() {
  section "1/3 — Unit tests (bun test test/unit)"
  cd "$PROJECT_ROOT"
  if bun test test/unit; then
    log "✓ unit tests: PASS"
  else
    log "✗ unit tests: FAIL"
    FAILURES+=("unit")
    return 1
  fi
}

# ─── 2. Integration tests ───────────────────────────────────────────────────

run_integration() {
  section "2/3 — Integration tests (bun test test/integration)"
  ensure_infra
  cd "$PROJECT_ROOT"
  if bun test test/integration; then
    log "✓ integration tests: PASS"
  else
    log "✗ integration tests: FAIL"
    FAILURES+=("integration")
    return 1
  fi
}

# ─── 3. Concurrency tests ───────────────────────────────────────────────────

run_concurrency() {
  section "3/3 — Concurrency tests (bun test test/concurrency)"
  ensure_infra
  cd "$PROJECT_ROOT"
  if bun test test/concurrency; then
    log "✓ concurrency tests: PASS"
  else
    log "✗ concurrency tests: FAIL"
    FAILURES+=("concurrency")
    return 1
  fi
}

# ─── Main ───────────────────────────────────────────────────────────────────

main() {
  section "TEST SUITE — $(date)"

  if [[ "$RESET" == "true" ]]; then
    log "resetando infra..."
    "$SCRIPT_DIR/init.sh" --reset
  fi

  # Unit não precisa de infra
  if [[ "$RUN_UNIT" == "true" ]]; then
    run_unit || true
  fi

  # Integration/concurrency precisam de infra
  if [[ "$RUN_INTEGRATION" == "true" ]]; then
    run_integration || true
  fi

  if [[ "$RUN_CONCURRENCY" == "true" ]]; then
    run_concurrency || true
  fi

  # ─── Resumo ───────────────────────────────────────────────────────────────
  local elapsed=$(( $(date +%s) - START_TIME ))
  section "RESUMO"
  log "duração: ${elapsed}s"
  log "relatórios: $REPORT_DIR"

  if [[ ${#FAILURES[@]} -eq 0 ]]; then
    log "✓ TODOS OS TESTES PASSARAM"
    exit 0
  else
    log "✗ FALHAS: ${FAILURES[*]}"
    exit 1
  fi
}

main
