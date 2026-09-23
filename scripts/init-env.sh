#!/usr/bin/env bash
# Создаёт .env из .env.example, подставляя случайные пароли/токены.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env уже существует — не трогаю. Удалите вручную, если нужен новый."
  exit 0
fi

gen() { openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 32; }

sed \
  -e "s/CHANGE_ME_source_pass/$(gen)/" \
  -e "s/CHANGE_ME_admin_pass/$(gen)/" \
  -e "s/CHANGE_ME_admin/$(gen)/" \
  -e "s/CHANGE_ME_frp_token/$(gen)/" \
  .env.example > .env

echo ".env создан. Проверьте и при желании поменяйте DJ_NAME/RADIO_NAME."
