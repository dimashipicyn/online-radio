#!/usr/bin/env bash
# Остановка VPS-стека (icecast + frps).
set -euo pipefail
cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  COMPOSE="docker compose"
fi

echo "Остановка через: $COMPOSE"
$COMPOSE -p online-radio-vps -f docker-compose.vps.yml down "$@"
