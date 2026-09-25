#!/usr/bin/env bash
# Одна команда на VPS: icecast + frps.
# Перед этим положи сюда тот же .env, что дома (пароли и FRP_TOKEN должны совпасть).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Нет .env. Скопируй домашний .env на VPS и запусти снова." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD пуст в .env}"
: "${FRP_TOKEN:?FRP_TOKEN пуст в .env}"

umask 077
cat > frp/frps.toml <<EOF
bindPort = ${FRP_SERVER_PORT:-7000}
auth.method = "token"
auth.token = "${FRP_TOKEN}"

allowPorts = [
  { start = ${WEB_PORT:-3000}, end = ${WEB_PORT:-3000} },
  { start = ${TTS_PUBLIC_PORT:-8001}, end = ${TTS_PUBLIC_PORT:-8001} },
]
EOF

docker compose -f docker-compose.vps.yml up -d --build

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
ip="${ip:-<IP-VPS>}"
echo
echo "VPS готов."
echo "  стрим:  http://${ip}:${ICECAST_PUBLIC_PORT:-8000}/${ICECAST_MOUNT:-radio.mp3}"
echo "  панель: http://${ip}:${WEB_PORT:-3000}   (после запуска frpc дома)"
echo "  tts:    http://${ip}:${TTS_PUBLIC_PORT:-8001}/translate_tts"
echo
echo "Дома в .env: ICECAST_HOST=${ip}"
echo "Дома в frp/frpc.toml: serverAddr = \"${ip}\" и auth.token из FRP_TOKEN"
echo "Дома: docker compose --profile tunnel up -d frpc"
