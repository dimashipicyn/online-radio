"""Silero TTS сервис.

Модель v4_ru (torch.package) скачивается при старте в /cache и живёт в volume.
API:
  GET  /health                      -> готовность
  POST /tts {text, speaker, rate}   -> audio/wav (48kHz mono s16)
Голоса v4_ru: aidar, baya, kseniya, xenia, eugene, random.
"""
import io
import logging
import os
import re
import struct
import wave
from pathlib import Path

import requests
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

MODEL_PATH = Path(os.environ.get("MODEL_PATH", "/cache/v4_ru.pt"))
MODEL_URLS = [
    os.environ.get("MODEL_URL", ""),
    "https://models.silero.ai/models/tts/ru/v4_ru.pt",
    "https://huggingface.co/snakers4/silero-models/resolve/main/v4_ru.pt",
]
VOICES = {"aidar", "baya", "kseniya", "xenia", "eugene", "random"}
SAMPLE_RATE = 48000

app = FastAPI(title="radio-tts", version="1.1.0")
_state = {"model": None, "ready": False, "error": None}
_accent = None


def _download_model() -> None:
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists() and MODEL_PATH.stat().st_size > 1_000_000:
        log.info("модель уже в кэше: %s", MODEL_PATH)
        return
    last_err = None
    for url in MODEL_URLS:
        if not url:
            continue
        try:
            log.info("качаю модель: %s", url)
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                tmp = MODEL_PATH.with_suffix(".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                tmp.rename(MODEL_PATH)
            log.info("модель скачана (%.1f МБ)", MODEL_PATH.stat().st_size / 1e6)
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.warning("не вышло: %s", e)
    raise RuntimeError(f"не удалось скачать модель: {last_err}")


def _load_model() -> None:
    log.info("загружаю silero v4_ru...")
    importer = torch.package.PackageImporter(str(MODEL_PATH))
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    _state["model"] = model
    _state["ready"] = True
    log.info("silero готов, голоса: %s", ", ".join(sorted(VOICES)))


def _load_accentizer() -> None:
    """Ударения + омоографы (ruaccent). Не критично: упало — синтезируем без."""
    global _accent
    try:
        from ruaccent import RUAccent
        az = RUAccent()
        try:
            # models держим в volume, чтобы не качать при каждом пересоздании
            az.load(omograph_model_size="turbo", use_dictionary=True, workdir="/cache/ruaccent")
        except TypeError:
            az.load(omograph_model_size="turbo", use_dictionary=True)
        _accent = az
        log.info("акцентуация загружена (ударения + омоографы)")
    except Exception as e:  # noqa: BLE001
        log.warning("акцентуация недоступна, синтез без ударений: %s", e)


def _accentize(text: str) -> str:
    if _accent is None:
        return text
    try:
        return _accent.process_all(text)
    except Exception as e:  # noqa: BLE001
        log.warning("акцентуация упала, отдаю текст как есть: %s", e)
        return text


@app.on_event("startup")
def startup() -> None:
    try:
        _download_model()
        _load_model()
    except Exception as e:  # noqa: BLE001
        _state["error"] = str(e)
        log.error("старт не удался: %s", e)
        return
    _load_accentizer()


class TtsRequest(BaseModel):
    text: str
    speaker: str = "eugene"
    rate: float = 1.0  # длина слогов: <1 быстрее, >1 медленнее


def _to_wav(samples: torch.Tensor) -> bytes:
    pcm = (samples * 32767).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


@app.get("/health")
def health():
    return {
        "status": "ok" if _state["ready"] else "starting",
        "engine": "silero-v4-ru",
        "ready": _state["ready"],
        "voices": sorted(VOICES),
        "error": _state["error"],
    }


MAX_SEGMENT_CHARS = 280   # длиннее — Silero v4 начинает пропускать слова и фразы
SEGMENT_GAP_SEC = 0.16    # пауза между предложениями (естественный ритм)


def _split_sentences(text: str) -> list:
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", text) if p.strip()]
    out = []
    for p in parts:
        # предложение длиннее лимита режем по запятым
        while len(p) > MAX_SEGMENT_CHARS:
            cut = p.rfind(",", 0, MAX_SEGMENT_CHARS)
            if cut < 40:
                cut = MAX_SEGMENT_CHARS
            out.append(p[:cut].rstrip(","))
            p = p[cut + 1:].lstrip()
        out.append(p)
    return out or [text]


@app.post("/tts")
def tts(req: TtsRequest):
    if not _state["ready"]:
        raise HTTPException(503, "модель ещё не готова")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "пустой текст")
    if len(text) > 1500:
        text = text[:1500]
    speaker = req.speaker if req.speaker in VOICES else "eugene"
    try:
        text = _accentize(text)
        # синтез по предложениям: одним куском Silero глотает слова на длинных текстах
        gap = torch.zeros(int(SAMPLE_RATE * SEGMENT_GAP_SEC))
        pieces = []
        with torch.no_grad():
            for seg in _split_sentences(text):
                pieces.append(
                    _state["model"].apply_tts(text=seg, speaker=speaker, sample_rate=SAMPLE_RATE)
                )
                pieces.append(gap)
        audio = torch.cat(pieces)
    except Exception as e:  # noqa: BLE001
        log.error("tts failed: %s", e)
        raise HTTPException(500, "ошибка синтеза") from e
    wav = _to_wav(audio)
    return Response(content=wav, media_type="audio/wav")
