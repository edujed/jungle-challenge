#!/usr/bin/env bash
# apply-migrations.sh — Aplica as migrations em ordem (up ou down).
#
# Uso:
#   bash scripts/apply-migrations.sh          # aplica up migrations em ordem
#   bash scripts/apply-migrations.sh --down   # aplica down migrations em ordem inversa
#   bash scripts/apply-migrations.sh --reset  # aplica down (inverso) + up (ordem)
set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
PG_CONTAINER="wagering-postgres"
PG_USER="wagering"
PG_DB="wagering"

apply_sql() {
  local file="$1"
  local name
  name=$(basename "$file")
  echo "  Aplicando $name..."
  if docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < "$file"; then
    echo "    ✓ $name"
  else
    echo "    ✗ $name FALHOU"
    return 1
  fi
}

apply_up() {
  echo "Aplicando UP migrations em ordem..."
  for f in "$MIGRATIONS_DIR"/*.sql; do
    [[ -f "$f" ]] || continue
    # Ignora .down.sql
    if [[ "$f" == *.down.sql ]]; then
      continue
    fi
    apply_sql "$f" || return 1
  done
  echo "UP migrations aplicadas com sucesso."
}

apply_down() {
  echo "Aplicando DOWN migrations em ordem inversa..."
  # Coleta os .down.sql em ordem e inverte
  local down_files=()
  for f in "$MIGRATIONS_DIR"/*.down.sql; do
    [[ -f "$f" ]] || continue
    down_files+=("$f")
  done

  # Inverte a ordem
  local reversed=()
  for ((i=${#down_files[@]}-1; i>=0; i--)); do
    reversed+=("${down_files[$i]}")
  done

  for f in "${reversed[@]}"; do
    apply_sql "$f" || return 1
  done
  echo "DOWN migrations aplicadas com sucesso."
}

apply_reset() {
  echo "=== RESET: aplicando DOWN (ordem inversa) ==="
  apply_down
  echo
  echo "=== RESET: aplicando UP (ordem) ==="
  apply_up
}

# ─── Main ─────────────────────────────────────────────────────────────────

ACTION="up"
for arg in "$@"; do
  case "$arg" in
    --down)  ACTION="down" ;;
    --reset) ACTION="reset" ;;
    --help|-h)
      echo "Uso: $0 [--down|--reset]"
      echo "  (sem flags)   aplica up migrations em ordem"
      echo "  --down        aplica down migrations em ordem inversa"
      echo "  --reset       aplica down (inverso) + up (ordem)"
      exit 0
      ;;
    *) echo "Flag desconhecida: $arg"; exit 1 ;;
  esac
done

case "$ACTION" in
  up)
    apply_up
    ;;
  down)
    apply_down
    ;;
  reset)
    apply_reset
    ;;
esac
