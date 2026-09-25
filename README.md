# Радио Слом — онлайн-радио с AI-ведущим

Локальный ПК (GPU) генерирует эфир: музыка из `./music` + AI-диджей Валера
(Ollama + Silero TTS), вставки и «звонки слушателей» с сайта, база знаний (RAG).
Стрим уходит на icecast, веб-управление — через frp-туннель на VPS.

## Быстрый старт (дом)

```bash
./scripts/init-env.sh                       # создать .env со случайными паролями
docker compose --profile local up -d --build
# веб-UI:  http://localhost:3000  (пароль из .env: ADMIN_PASSWORD)
# стрим:   http://localhost:3000/radio.mp3 (или :8000 напрямую)
```

Закиньте mp3/flac в `./music` — эфир подхватит сам (скан раз в 5 минут).
Папка `./music/jingles/` — короткие джинглы: будут играться перед репликами DJ.

## Что умеет

- **Ротация** без зазывания одного и того же: случайно из 30% наименее игравших
- **AI-ведущий** (Ollama): приветствие по времени суток, болтовня между треками,
  темы от слушателей; реплика готовится, пока доигрывает текущий трек
- **Голос** Silero v4 (рус.): ведущий и звонящие — разные голоса
- **Звонки с сайта**: имя + текст → LLM оформляет → голосом другого спикера в эфир
  приоритетной вставкой
- **База знаний**: заметки на сайте → чанкуются → nomic-embed-text → DJ вплетает
  релевантное в болтовню
- **Веб-UI**: пароль, плеер, now playing, история, темы, звонки, KB, вкл/выкл DJ

## Профили compose

| Профиль | Что добавляет |
|---|---|
| *(без профиля)* | station + tts |
| `local` | + icecast дома (слушать `localhost:8000/radio.mp3`) |
| `ai` | + ollama (GPU, nvidia-container-toolkit обязателен) |
| `tunnel` | + frpc (после настройки VPS) |

Полный домашний запуск:

```bash
docker compose --profile local --profile ai up -d --build
```

Первый старт с `ai`: контейнер `ollama-init` скачает модели (~5ГБ, один раз).

## Требования на хосте (WSL Ubuntu, разово)

```bash
# NVIDIA Container Toolkit — для Ollama на GPU
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

## Дроп-ин вместо Google Translate TTS

Сервис `tts` принимает тот же запрос, что `translate.google.com`, и озвучивает его локальным Silero. В Google ничего не уходит.

```text
GET http://<хост>:8001/translate_tts?ie=UTF-8&tl=ru-RU&client=tw-ob&q=привет
→ audio/mpeg
```

В чужом сервисе достаточно сменить хост с `translate.google.com` на этот. Голос — `GTTS_SPEAKER` (по умолчанию `eugene`). `format=wav` отдаёт wav вместо mp3.

## Голоса Silero (в .env)

`DJ_SPEAKER` — голос ведущего, `CALLER_SPEAKER` — голос звонящих.
Варианты: `aidar | baya | kseniya | xenia | eugene | random`.

## Дорожная карта

- [x] Этап 1: скелет контейнеров, эфир с тишиной
- [ ] Этап 2: VPS (icecast + frps), публичный URL
- [x] Этап 3: библиотека `./music`, ротация
- [x] Этап 4: AI-диджей (Ollama + Silero)
- [x] Этап 5: веб-UI v1
- [x] Этап 6: звонки слушателей
- [x] Этап 7: база знаний (RAG)
- [x] Этап 8: джинглы, приветствия по времени суток
