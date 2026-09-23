#!/usr/bin/env bash
# Живучий бутстрап AI-части: образ ollama -> стек -> модели.
# Запускается systemd-юнитом radio-bootstrap.service; при рестарте WSL
# стартует заново и продолжает с того, чего не хватает.
set -u
cd /home/piggy/dev/online_radio
LOG="$HOME/.cache/radio-logs/bootstrap.log"
mkdir -p "$(dirname "$LOG")"
echo "=== $(date '+%F %T') bootstrap start ===" >>"$LOG"

# 1. образ ollama (если уже скачан — пропускаем)
if ! docker image inspect ollama/ollama:latest >/dev/null 2>&1; then
  echo "pull ollama image..." >>"$LOG"
  docker pull ollama/ollama:latest >>"$LOG" 2>&1
fi
docker image inspect ollama/ollama:latest >/dev/null 2>&1 || { echo "pull failed, retry via systemd" >>"$LOG"; exit 1; }

# 2. поднять стек (локальный эфир + ollama)
docker compose --profile local --profile ai up -d >>"$LOG" 2>&1 || exit 1

# 3. дождаться моделей (ollama-init тянет ~5ГБ в volume)
for i in $(seq 1 720); do
  if docker exec online-radio-ollama-1 ollama list 2>/dev/null | grep -q nomic-embed-text; then
    echo "=== $(date '+%F %T') MODELS_READY ===" >>"$LOG"
    exit 0
  fi
  # init-контейнер умер/не запущен — перезапустить (idempotent)
  docker compose --profile ai up -d ollama-init >>"$LOG" 2>&1
  sleep 10
done
echo "=== $(date '+%F %T') timeout waiting models ===" >>"$LOG"
exit 1
