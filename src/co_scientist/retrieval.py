"""arXiv fetch (rate-limited + cached), Chroma ranking of abstracts, budgeted full-text reading."""

import io
import json
import re
import sqlite3
import threading
import xml.etree.ElementTree as ET
import time
from pathlib import Path

import chromadb
import httpx
import numpy as np
import ollama

from .config import settings
from .schemas import Evidence, Paper

Path(settings.data_dir).mkdir(parents=True, exist_ok=True)
_FULLTEXT_DIR = Path(settings.data_dir) / "fulltext"
_FULLTEXT_DIR.mkdir(exist_ok=True)

# arXiv ToS: <=1 request / 3 s, single connection, across all your machines.
# ponytail: one process-wide lock + timestamp; multi-process deploys need a shared (Redis) limiter.
_arxiv_lock = threading.Lock()
_last_call = 0.0


def _polite():
    """Call with _arxiv_lock held: wait until 3 s since the previous arXiv request."""
    global _last_call
    time.sleep(max(0.0, _last_call + 3.0 - time.time()))
    _last_call = time.time()


_db = sqlite3.connect(Path(settings.data_dir) / "cache.db", check_same_thread=False)
_db.execute("CREATE TABLE IF NOT EXISTS search_cache (query TEXT PRIMARY KEY, papers TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP)")
_db_lock = threading.Lock()

_chroma = chromadb.PersistentClient(path=str(Path(settings.data_dir) / "chroma"))
_passages = _chroma.get_or_create_collection("passages", metadata={"hnsw:space": "cosine"})


# Circuit breaker: after arXiv says 429/503, stop calling it for a while instead of burning
# 15-30 s per attempt (that is what blew the latency budget in a live run).
_ARXIV_COOLDOWN_S = 120
_arxiv_down_until = 0.0
_TIMEOUT = 10  # per request; keeps one bad call from eating the end-to-end budget


def _trip(r: httpx.Response | None = None):
    global _arxiv_down_until
    if r is None or r.status_code in (429, 503):
        _arxiv_down_until = time.time() + _ARXIV_COOLDOWN_S


def arxiv_available() -> bool:
    return time.time() >= _arxiv_down_until


# stdlib parser is fine here: py3.14 expat refuses external entities + has billion-laughs limits; source is arXiv over TLS
_ATOM = {"a": "http://www.w3.org/2005/Atom"}


def _from_arxiv(query: str) -> list[Paper]:
    with _arxiv_lock:
        _polite()
        try:
            r = httpx.get("https://export.arxiv.org/api/query", timeout=_TIMEOUT, params={
                "search_query": query, "max_results": settings.papers_per_query, "sortBy": "relevance"})
        except httpx.HTTPError:
            _trip()
            raise
    if r.status_code != 200:
        _trip(r)
        r.raise_for_status()
    papers = []
    for e in ET.fromstring(r.text).findall("a:entry", _ATOM):
        url = e.findtext("a:id", "", _ATOM)
        if "/abs/" not in url:
            continue
        txt = lambda tag: " ".join((e.findtext(f"a:{tag}", "", _ATOM)).split())  # noqa: E731
        papers.append(Paper(arxiv_id=url.split("/abs/")[-1], title=txt("title"), abstract=txt("summary"),
                            authors=[a.findtext("a:name", "", _ATOM) for a in e.findall("a:author", _ATOM)][:6],
                            published=txt("published")[:10], url=url))
    return papers


_OPENALEX_ARXIV = "S4306400194"  # OpenAlex source id of arXiv (Cornell University)


def _from_openalex(query: str) -> list[Paper]:
    """Fallback index: OpenAlex filtered to arXiv-hosted works, so evidence stays arXiv papers."""
    r = httpx.get("https://api.openalex.org/works", timeout=_TIMEOUT, params={
        "search": query, "filter": f"primary_location.source.id:{_OPENALEX_ARXIV}",
        "per_page": settings.papers_per_query,
        "select": "title,publication_date,ids,primary_location,authorships,abstract_inverted_index"})
    r.raise_for_status()
    papers = []
    for w in r.json().get("results", []):
        links = " ".join(filter(None, [(w.get("primary_location") or {}).get("landing_page_url"),
                                       (w.get("ids") or {}).get("doi")]))
        m = re.search(r"arxiv[./](?:abs/)?(\d{4}\.\d{4,5})", links, re.I)
        inv = w.get("abstract_inverted_index") or {}
        if not m or not inv or not w.get("title"):
            continue
        words = sorted((i, word) for word, idx in inv.items() for i in idx)  # rebuild abstract text
        papers.append(Paper(arxiv_id=m.group(1), title=w["title"], abstract=" ".join(wd for _, wd in words),
                            authors=[a["author"]["display_name"] for a in w.get("authorships", [])][:6],
                            published=w.get("publication_date") or "", url=f"http://arxiv.org/abs/{m.group(1)}"))
    return papers


def search_arxiv(query: str) -> tuple[list[Paper], str]:
    """Fresh cache -> arXiv API -> OpenAlex (arXiv-hosted) -> stale cache. Returns (papers, source)."""
    key = query.strip().lower()
    with _db_lock:
        row = _db.execute("SELECT papers, fetched_at > datetime('now','-1 day') FROM search_cache WHERE query=?",
                          (key,)).fetchone()
    if row and row[1]:
        return [Paper(**p) for p in json.loads(row[0])], "cache"
    papers, source = None, ""
    for name, fetch in (("arXiv", _from_arxiv), ("OpenAlex", _from_openalex)):
        if name == "arXiv" and not arxiv_available():
            continue
        try:
            papers, source = fetch(query), name
            break
        except Exception:
            continue
    if papers is None:
        if row:  # every source failed: an old answer beats no answer
            return [Paper(**p) for p in json.loads(row[0])], "stale cache"
        raise RuntimeError("arXiv and OpenAlex both unavailable")
    with _db_lock:
        _db.execute("INSERT OR REPLACE INTO search_cache(query, papers) VALUES (?, ?)",
                    (key, json.dumps([p.model_dump() for p in papers])))
        _db.commit()
    return papers, source


def embed(texts: list[str]) -> list[list[float]]:
    """One batched Ollama call instead of one HTTP round-trip per passage."""
    vecs = ollama.embed(model=settings.embed_model, input=texts).embeddings
    if len(vecs) != len(texts) or any(len(v) != settings.embed_dim for v in vecs):
        raise RuntimeError(f"embedding failed for model {settings.embed_model}")
    return vecs


def _passages_of(text: str, window: int = 2) -> list[str]:
    sents = [s for s in re.split(r"(?<=[.!?])\s+", text) if len(s) > 20]
    return [" ".join(sents[i : i + window]) for i in range(0, len(sents), window)] or [text]


def rank(session_id: str, question: str, papers: list[Paper], start_index: int = 1) -> list[Evidence]:
    """Index abstract passages for this session and return top-K evidence across papers."""
    if not papers:
        return []
    ids, docs, metas = [], [], []
    for p in papers:
        for i, passage in enumerate(_passages_of(p.abstract)):
            ids.append(f"{session_id}:{p.arxiv_id}:{i}")
            docs.append(passage)
            metas.append({"session_id": session_id, "arxiv_id": p.arxiv_id, "title": p.title, "url": p.url})

    # nomic-embed-text expects task prefixes
    vectors = embed([f"search_document: {d}" for d in docs])
    _passages.upsert(ids=ids, documents=docs, metadatas=metas, embeddings=vectors)

    # only rank this batch, so a re-retrieval round doesn't return earlier evidence under new ids
    res = _passages.query(
        query_embeddings=embed([f"search_query: {question}"]),
        n_results=min(settings.top_k_evidence * 3, len(ids)),
        where={"$and": [{"session_id": session_id}, {"arxiv_id": {"$in": [p.arxiv_id for p in papers]}}]},
    )
    # keep top-K but at most 2 passages per paper, so evidence spans several papers
    out, per_paper = [], {}
    for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
        if per_paper.get(meta["arxiv_id"], 0) >= 2:
            continue
        per_paper[meta["arxiv_id"]] = per_paper.get(meta["arxiv_id"], 0) + 1
        out.append(Evidence(id="", arxiv_id=meta["arxiv_id"], title=meta["title"], url=meta["url"],
                            passage=doc, score=round(1 - dist, 3)))
        if len(out) >= settings.top_k_evidence:
            break
    for n, e in enumerate(out, start=start_index):
        e.id = f"E{n}"
    return out


# ---------- full text ----------

def _pdf_text(arxiv_id: str) -> str:
    """Body text of the paper (references dropped), cached on disk so repeats cost ~0 ms."""
    cache = _FULLTEXT_DIR / f"{arxiv_id.replace('/', '_')}.txt"
    if cache.exists():
        return cache.read_text(encoding="utf-8")
    from pypdf import PdfReader

    if not arxiv_available():
        raise RuntimeError("arXiv rate-limited (circuit open)")
    with _arxiv_lock:
        _polite()
        r = httpx.get(f"https://export.arxiv.org/pdf/{arxiv_id}", follow_redirects=True, timeout=_TIMEOUT,
                      headers={"User-Agent": "co-scientist/0.1 (research assistant)"})
    if r.status_code != 200:
        _trip(r)
        r.raise_for_status()
    pages = PdfReader(io.BytesIO(r.content)).pages[:15]  # ponytail: first 15 pages hold the findings
    text = " ".join(" ".join((p.extract_text() or "").split()) for p in pages)
    text = re.split(r"\bReferences\b|\bREFERENCES\b|\bBibliography\b", text)[0]
    cache.write_text(text, encoding="utf-8")
    return text


def _chunks(text: str, size: int = 600, limit: int = 80) -> list[str]:
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text):
        if len(cur) + len(s) > size and cur:
            out.append(cur)
            cur = ""
        cur += s + " "
    return [c.strip() for c in (out + [cur]) if len(c) > 80][:limit]


def fulltext(question: str, evidence: list[Evidence], start_index: int, log) -> list[Evidence]:
    """Read PDFs of the top-ranked papers within a hard time budget; return their best body passages."""
    deadline = time.time() + settings.fulltext_budget_s
    by_score = sorted(evidence, key=lambda e: -e.score)
    top = list(dict.fromkeys(e.arxiv_id for e in by_score))[: settings.fulltext_papers]
    meta = {e.arxiv_id: e for e in evidence}
    qv = np.array(embed([f"search_query: {question}"])[0])
    out: list[Evidence] = []
    for aid in top:
        if time.time() > deadline:
            log("Time budget reached, skipping remaining PDFs")
            break
        try:
            chunks = _chunks(_pdf_text(aid))
        except Exception as e:  # missing / unparsable PDF: abstract evidence still stands
            log(f"Could not read PDF {aid} ({type(e).__name__})")
            continue
        if not chunks:
            continue
        m = np.array(embed([f"search_document: {c}" for c in chunks]))
        scores = m @ qv / (np.linalg.norm(m, axis=1) * np.linalg.norm(qv))
        best = np.argsort(-scores)[:2]
        out += [Evidence(id="", arxiv_id=aid, title=meta[aid].title, url=meta[aid].url, passage=chunks[i],
                         score=round(float(scores[i]), 3), section="fulltext") for i in best]
        log(f"Read full text of '{meta[aid].title[:50]}': {len(chunks)} sections, best match {scores[best[0]]:.2f}")
    for n, e in enumerate(out, start=start_index):
        e.id = f"E{n}"
    return out
