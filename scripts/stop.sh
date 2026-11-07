#!/usr/bin/env bash
# stop.sh — Para a infraestrutura (PostgreSQL + LocalStack + backends).
#
# Uso:
#   ./scripts/stop.sh              # para tudo (dados persistem no volume)
#   ./scripts/stop.sh --volumes    # para tudo + apaga volumes (dados perdidos)
#   ./scripts/stop.sh --status     # apenas verifica o status
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/../docker-infra" && pwd)"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ─── Status ─────────────────────────────────────────────────────────────────

status() {
  log "status da infraestrutura:"
  cd "$COMPOSE_DIR"
  docker compose ps
}

# ─── Stop ───────────────────────────────────────────────────────────────────

stop_infra() {
  local remove_volumes=false
  for arg in "$@"; do
    case "$arg" in
      --volumes) remove_volumes=true ;;
    esac
  done

  cd "$COMPOSE_DIR"

  if [[ "$remove_volumes" == "true" ]]; then
    log "parando infraestrutura e apagando volumes (dados serão perdidos)..."
    docker compose down -v
  else
    log "parando infraestrutura (dados persistem no volume)..."
    docker compose down
  fi

  log "infraestrutura parada"
}

# ─── Main ───────────────────────────────────────────────────────────────────

main() {
  local action="stop"
  local extra_args=()

  for arg in "$@"; do
    case "$arg" in
      --volumes)
        action="stop"
        extra_args+=("--volumes")
        ;;
      --status)
        action="status"
        ;;
      --help|-h)
        echo "Uso: $0 [--volumes|--status]"
        echo "  (sem flags)    para a infra (dados persistem)"
        echo "  --volumes      para a infra + apaga volumes (dados perdidos)"
        echo "  --status       apenas verifica o status"
        exit 0
        ;;
      *) echo "Flag desconhecida: $arg"; exit 1 ;;
    esac
  done

  case "$action" in
    status)
      status
      ;;
    stop)
      stop_infra "${extra_args[@]}"
      ;;
  esac
}

main "$@"
