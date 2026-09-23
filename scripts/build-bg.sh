#!/usr/bin/env bash
# Фоновая сборка образов. Лог: build.log
set -x
cd "$(dirname "$0")/.."
exec > build.log 2>&1
docker compose --profile local build station tts icecast
echo "BUILD_EXIT_CODE=$?"
