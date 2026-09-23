"""Silero TTS сервис. Этап 1: каркас с health. Голос появится на этапе 4."""
from fastapi import FastAPI

app = FastAPI(title="radio-tts", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "engine": "stub", "voices": []}
