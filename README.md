# Радио Слом — онлайн-радио с AI-ведущим

Локальный ПК (GPU) генерирует эфир: музыка + AI-диджей (Ollama + Silero TTS),
стрим уходит на VPS (icecast), веб-управление через frp-туннель.

## Быстрый старт (дом)

```bash
./scripts/init-env.sh                       # создать .env со случайными паролями
docker compose --profile local up -d --build
# слушать: http://localhost:8000/radio.mp3
# статус:  http://localhost:3000/health
```

## Профили compose

| Профиль | Что добавляет |
|---|---|
| *(без профиля)* | station + tts |
| `local` | + icecast дома (слушать `localhost:8000/radio.mp3`) |
| `ai` | + ollama (GPU, nvidia-container-toolkit обязателен) |
| `tunnel` | + frpc (после настройки VPS, этап 2) |

Полный домашний запуск:

```bash
docker compose --profile local --profile ai --profile tunnel up -d --build
```

## Требования на хосте (WSL Ubuntu, разово)

```bash
# NVIDIA Container Toolkit — для Ollama на GPU
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

## Дорожная карта

- [ ] Этап 1: скелет контейнеров, эфир с тишиной  ← **сейчас**
- [ ] Этап 2: VPS (icecast + frps), публичный URL
- [ ] Этап 3: библиотека `./music`, ротация
- [ ] Этап 4: AI-диджей (Ollama + Silero)
- [ ] Этап 5: веб-UI v1
- [ ] Этап 6: звонки слушателей
- [ ] Этап 7: база знаний (RAG)
- [ ] Этап 8: джинглы, ducking, полировка
