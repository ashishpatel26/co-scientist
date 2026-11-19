"""FastAPI gateway: auth, validation, CORS, bounded job pool."""

import asyncio
import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .config import settings
from .schemas import Session
from .workflow import run_session

app = FastAPI(title="Mini Research Co-Scientist")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins.split(","),
                   allow_methods=["*"], allow_headers=["*"])

# ponytail: in-memory session store capped at MAX_SESSIONS; swap for SQLite when sessions must survive restarts.
MAX_SESSIONS = 200
TERMINAL = ("done", "failed", "insufficient_evidence")
_sessions: dict[str, Session] = {}
_queue: list[str] = []
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=settings.workers)


def auth(x_api_key: str | None = Header(default=None), key: str | None = None):
    # `key` query param exists only because browser EventSource cannot send headers
    if settings.api_key and settings.api_key not in (x_api_key, key):
        raise HTTPException(401, "invalid API key")


class Ask(BaseModel):
    question: str = Field(min_length=10, max_length=1000)


def _job(sid: str):
    with _lock:
        if sid in _queue:
            _queue.remove(sid)
    s = _sessions[sid]
    try:
        run_session(s)
    except Exception as e:  # never leave a session stuck in a running state
        s.status, s.error = "failed", f"{type(e).__name__}: {e}"
        s.log("system", f"Failed: {s.error}")


@app.post("/sessions", dependencies=[Depends(auth)])
def create(body: Ask):
    s = Session(id=uuid.uuid4().hex[:12], question=body.question.strip())
    s.log("system", "Queued")
    with _lock:
        # evict oldest finished sessions so memory stays bounded (dicts keep insertion order)
        for old in [k for k, v in _sessions.items() if v.status in TERMINAL]:
            if len(_sessions) < MAX_SESSIONS:
                break
            del _sessions[old]
        _sessions[s.id] = s
        _queue.append(s.id)
        position = len(_queue)
    _pool.submit(_job, s.id)
    return {"session_id": s.id, "status": s.status, "position": position}


def _snapshot(sid: str) -> dict:
    s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "session not found")
    with _lock:
        position = _queue.index(sid) + 1 if sid in _queue else 0
    return {**s.model_dump(), "position": position}


@app.get("/sessions/{sid}", dependencies=[Depends(auth)])
def get(sid: str):
    return _snapshot(sid)


@app.get("/sessions/{sid}/stream", dependencies=[Depends(auth)])
async def stream(sid: str):
    """Server-Sent Events: push a snapshot whenever the session changes (<=200 ms after the change)."""
    _snapshot(sid)  # 404 before opening the stream

    async def gen():
        last = None
        while True:
            snap = _snapshot(sid)
            sig = (len(snap["events"]), snap["status"], snap["position"])
            if sig != last:
                last = sig
                yield f"data: {json.dumps(snap)}\n\n"
                if snap["status"] in TERMINAL:
                    return
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/health")
def health():
    if settings.fake_llm:
        return {"ok": True, "mode": "fake"}
    try:
        host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
        host = host if host.startswith("http") else f"http://{host}"
        tags = httpx.get(f"{host}/api/tags", timeout=3).json()
        names = {m["name"].split(":")[0] for m in tags.get("models", [])}
        missing = [m for m in (settings.llm_model, settings.embed_model) if m.split(":")[0] not in names]
        return {"ok": not missing, "missing_models": missing}
    except (httpx.HTTPError, ValueError) as e:
        return {"ok": False, "error": f"ollama unreachable: {e}"}
