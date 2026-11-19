"""Latency contract: every API call and the first live agent event reach the client in < 2 s.

Run: CS_FAKE_LLM=1 uv run python tests/test_latency.py
(End-to-end research time is a separate budget: p95 < 3 min, see architecture.md.)
"""

import json
import os
import time

os.environ.setdefault("CS_FAKE_LLM", "1")
from fastapi.testclient import TestClient  # noqa: E402

from co_scientist.api import app  # noqa: E402

BUDGET = 2.0
c = TestClient(app)


def timed(fn):
    t = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - t


r, dt = timed(lambda: c.post("/sessions", json={"question": "Does retrieval reduce hallucination in LLMs?"}))
assert r.status_code == 200 and dt < BUDGET, (r.status_code, dt)
sid = r.json()["session_id"]
print(f"POST /sessions        {dt * 1000:7.1f} ms")

r, dt = timed(lambda: c.get(f"/sessions/{sid}"))
assert r.status_code == 200 and dt < BUDGET, dt
print(f"GET  /sessions/{{id}}   {dt * 1000:7.1f} ms")

t = time.perf_counter()
first, snaps = None, []
with c.stream("GET", f"/sessions/{sid}/stream") as s:
    for line in s.iter_lines():
        if line.startswith("data: "):
            first = first or time.perf_counter() - t
            snaps.append(json.loads(line[6:]))
assert first is not None and first < BUDGET, first
print(f"SSE first event       {first * 1000:7.1f} ms")
final = snaps[-1]
assert final["status"] == "done", final["status"]
assert len(snaps) > 3, "stream should push intermediate states, not just the end"
h = final["hypothesis"]
assert h["contradicting_evidence_ids"] == ["E3"] and any(e["section"] == "fulltext" for e in final["evidence"])
print(f"SSE pushed {len(snaps)} snapshots, final status done")

r, dt = timed(lambda: c.get("/health"))
assert dt < BUDGET
print(f"GET  /health          {dt * 1000:7.1f} ms")
print("LATENCY OK: all client-facing responses < 2 s")
