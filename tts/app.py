"""Silero TTS сервис.

Модель v5_ru (torch.package) скачивается при старте в /cache и живёт в volume.
API:
  GET  /health                      -> готовность
  POST /tts {text, speaker, rate}   -> audio/wav (48kHz mono s16)
Голоса v5_ru: aidar, baya, kseniya, eugene, xenia.

Качество речи:
  - put_accent/put_yo + различение омографов (put_stress_homo/put_yo_homo/stress_single_vowel);
  - числа переводятся в слова (num2words), чтобы не читались посимвольно;
  - синтез пофразовый с паузами 250мс — ровная просодия на длинных текстах;
  - rate != 1.0 применяется через SSML <prosody rate>.
"""
import io
import logging
import os
import re
import struct
import threading
import wave
import xml.sax.saxutils as saxutils
from pathlib import Path

import requests
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from num2words import num2words
import numpy as np
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

MODEL_PATH = Path(os.environ.get("MODEL_PATH", "/cache/v4_ru.pt"))
MODEL_URLS = [
    os.environ.get("MODEL_URL", ""),
    "https://models.silero.ai/models/tts/ru/v5_ru.pt",
]
VOICES = {"aidar", "baya", "kseniya", "eugene", "xenia"}
SAMPLE_RATE = 48000
MAX_TEXT = 4000        # текст больше не режем вслепую: синтез идёт пофразово
PHRASE_GAP_SEC = 0.25  # пауза между фразами

app = FastAPI(title="radio-tts", version="1.0.0")
_state = {"model": None, "ready": False, "error": None}


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
    log.info("загружаю silero v5_ru...")
    importer = torch.package.PackageImporter(str(MODEL_PATH))
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    _state["model"] = model
    _state["ready"] = True
    log.info("silero v5 готов, голоса: %s", ", ".join(sorted(VOICES)))


_NUM_RE = re.compile(r"(?<![\w.,:-])(\d+)(?:[.,](\d+))?(?![\w.,:-])")


def _numbers_to_words(text: str) -> str:
    """Числа -> слова, иначе TTS читает «2023» и «3.5» посимвольно."""
    def repl(m: re.Match) -> str:
        int_part, frac = m.group(1), m.group(2)
        try:
            if frac:
                return num2words(float(f"{int_part}.{frac}"), lang="ru")
            return num2words(int(int_part), lang="ru")
        except Exception:  # noqa: BLE001
            return m.group(0)

    return _NUM_RE.sub(repl, text)


def _split_phrases(text: str, max_len: int = 400) -> list[str]:
    """Делит текст на фразы: на коротких отрезках Silero держит ровную просодию."""
    phrases: list[str] = []
    for raw in re.split(r"(?<=[.!?…])\s+", text.replace("\n", " ")):
        raw = raw.strip()
        while len(raw) > max_len:
            cut = raw.rfind(", ", 0, max_len)
            if cut < max_len // 2:
                cut = raw.rfind(" ", 0, max_len)
            if cut <= 0:
                cut = max_len
            head, raw = raw[:cut].strip(" ,"), raw[cut:].strip(" ,")
            if head:
                phrases.append(head)
        if raw:
            phrases.append(raw)
    return phrases


def _apply_tts(text: str, speaker: str, rate: float) -> torch.Tensor:
    if abs(rate - 1.0) > 1e-3:
        pct = max(50, min(200, round(rate * 100)))
        ssml = f"<speak><prosody rate='{pct}%'>{saxutils.escape(text)}</prosody></speak>"
        return _state["model"].apply_tts(
            ssml_text=ssml, speaker=speaker, sample_rate=SAMPLE_RATE
        )
    return _state["model"].apply_tts(
        text=text,
        speaker=speaker,
        sample_rate=SAMPLE_RATE,
        put_accent=True,
        put_yo=True,
        put_stress_homo=True,   # различение омографов: зАмок/замОк
        put_yo_homo=True,       # «ё» в омографах: всЕ/всё
        stress_single_vowel=True,
    )


_SYNTH_LOCK = threading.Lock()  # модель одна: сериализуем доступ из threadpool uvicorn


def _is_noise_burst(audio: torch.Tensor) -> bool:
    """True, если фрагмент звучит как громкий широкополосный шум (срыв вокодера)."""
    x = audio.detach().cpu().numpy().astype(np.float32)
    if len(x) < SAMPLE_RATE // 4:
        return False
    seg = x[len(x) // 2: len(x) // 2 + SAMPLE_RATE // 4]
    rms = float(np.sqrt((seg ** 2).mean()) + 1e-10)
    if rms < 10 ** (-25 / 20):  # тихий хвост — это не срыв
        return False
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / SAMPLE_RATE)
    hf = float(spec[freqs > 8000].sum() / (spec.sum() + 1e-15))
    return hf > 0.30  # грубый срыв даёт 35-60%, лёгкая сибилянта голоса — 15-20% (её не режем)


def _synth_phrase(phrase: str, speaker: str, rate: float) -> torch.Tensor:
    """Синтез фразы с защитой: при срыве вокодера пересинтезируем, худший случай — выкидываем фразу."""
    with _SYNTH_LOCK:
        for attempt in (1, 2, 3):
            audio = _apply_tts(phrase, speaker, rate).cpu()
            if not _is_noise_burst(audio):
                return audio
            log.warning("tts: срыв вокодера, попытка %d: %.80s", attempt, phrase)
    log.error("tts: фраза вырезана после 3 шумных попыток: %.120s", phrase)
    return torch.zeros(int(SAMPLE_RATE * 0.1))


@app.on_event("startup")
def startup() -> None:
    try:
        _download_model()
        _load_model()
    except Exception as e:  # noqa: BLE001
        _state["error"] = str(e)
        log.error("старт не удался: %s", e)


class TtsRequest(BaseModel):
    text: str
    speaker: str = "eugene"
    rate: float = 1.0  # темп речи (SSML prosody rate): <1 медленнее, >1 быстрее


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
        "engine": "silero-v5-ru",
        "ready": _state["ready"],
        "voices": sorted(VOICES),
        "error": _state["error"],
    }


@app.post("/tts")
def tts(req: TtsRequest):
    if not _state["ready"]:
        raise HTTPException(503, "модель ещё не готова")
    text = _numbers_to_words(req.text.strip())
    if not text:
        raise HTTPException(400, "пустой текст")
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    speaker = req.speaker if req.speaker in VOICES else "eugene"
    phrases = _split_phrases(text) or [text]
    gap = torch.zeros(int(SAMPLE_RATE * PHRASE_GAP_SEC))
    try:
        parts: list[torch.Tensor] = []
        for i, phrase in enumerate(phrases):
            if i:
                parts.append(gap)
            parts.append(_synth_phrase(phrase, speaker, req.rate))
        audio = torch.cat(parts)
    except Exception as e:  # noqa: BLE001
        log.error("tts failed: %s", e)
        raise HTTPException(500, "ошибка синтеза") from e
    wav = _to_wav(audio)
    return Response(content=wav, media_type="audio/wav")
