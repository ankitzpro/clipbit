"""Tiny speech-to-text service wrapping faster-whisper.

POST /transcribe  (body: raw audio bytes, any format ffmpeg can read)
  query: language=auto|en|hi|...
returns: {"language": "en", "segments": [{"start", "end", "text", "words": [{"start","end","word","prob"}]}]}

The model is loaded in a background thread at start-up (it downloads on first run), so /health always
answers immediately and reports whether the model is ready. Transcription runs in a worker thread so it
never blocks the event loop.
"""
import os
import tempfile
import threading
import time
import traceback

from fastapi import FastAPI, Request, HTTPException
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

app = FastAPI(title="clipbit-whisper")
_model = None
_load_error = None
_load_started = None
_run_lock = threading.Lock()


def _load():
    global _model, _load_error, _load_started
    _load_started = time.time()
    try:
        print(f"[whisper] loading model {MODEL_NAME} on {DEVICE}/{COMPUTE} (downloads on first run)...", flush=True)
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE, download_root="/models")
        print(f"[whisper] model ready in {time.time() - _load_started:.0f}s", flush=True)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        print(f"[whisper] model load FAILED: {_load_error}", flush=True)
        traceback.print_exc()


@app.on_event("startup")
def startup():
    threading.Thread(target=_load, daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "loaded": _model is not None,
        "loading": _model is None and _load_error is None,
        "loadingSeconds": round(time.time() - _load_started) if _load_started and _model is None else None,
        "error": _load_error,
        "model": MODEL_NAME,
        "device": DEVICE,
        "busy": _run_lock.locked(),
    }


def _transcribe_file(path: str, language: str):
    with _run_lock:  # one transcription at a time keeps CPU/memory predictable
        segments, info = _model.transcribe(
            path,
            language=None if language in ("", "auto") else language,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
        )
        out = []
        for s in segments:
            out.append({
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "prob": round(w.probability, 3)}
                    for w in (s.words or [])
                ],
            })
        return {"language": info.language, "segments": out}


@app.post("/transcribe")
async def transcribe(request: Request, language: str = "auto"):
    if _model is None:
        raise HTTPException(503, _load_error or "model still loading")
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty body")
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        f.write(body)
        path = f.name
    try:
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(_transcribe_file, path, language)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
