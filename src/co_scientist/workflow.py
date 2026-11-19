"""Research workflow: retrieve -> synthesize -> critique -> (<=1 re-retrieve) -> finalize -> verify citations.

Every step writes to s.events so the UI can show a live activity log.
"""

import time
from collections.abc import Callable

from . import agents
from .config import settings
from .schemas import Citation, Critique, Evidence, Hypothesis, Recommendation, SearchPlan, Session


def _clean_queries(queries: list[str], fallback: str) -> list[str]:
    # small models emit '' or whole sentences; arXiv ANDs every term, so long queries return nothing
    out = [" ".join(q.split()[:6]) for q in queries if len(q.strip()) >= 3]
    return list(dict.fromkeys(out))[:4] or [" ".join(fallback.split()[:8])]


def _retrieve(s: Session, queries: list[str]) -> list[Evidence]:
    from . import retrieval

    papers, seen = [], {e.arxiv_id for e in s.evidence}
    for q in _clean_queries(queries, s.question):
        s.log("arxiv", f'Searching arXiv: "{q}"')
        try:
            found, source = retrieval.search_arxiv(q)
        except Exception as e:  # one failed query must not kill the session
            s.log("arxiv", f"Search failed ({type(e).__name__}), skipping")
            continue
        new = [p for p in found if p.arxiv_id not in seen]
        seen.update(p.arxiv_id for p in new)
        papers += new
        note = "" if source in ("arXiv", "cache") else " (arXiv rate-limited, used fallback)"
        s.log("arxiv", f"{len(found)} papers via {source}{note}, {len(new)} new")
    if not papers:
        return []
    s.log("ranker", f"Embedding {len(papers)} abstracts into ChromaDB and ranking passages")
    ev = retrieval.rank(s.id, s.question, papers, start_index=len(s.evidence) + 1)
    s.log("ranker", f"Selected {len(ev)} passages from {len({e.arxiv_id for e in ev})} papers")
    if ev and settings.fulltext_papers:
        s.log("reader", f"Reading full text of the top {settings.fulltext_papers} papers "
                        f"(budget {settings.fulltext_budget_s:.0f}s)")
        ev += retrieval.fulltext(s.question, ev, len(s.evidence) + len(ev) + 1, lambda m: s.log("reader", m))
    return ev


def verify(rec: Recommendation, evidence: list[Evidence]) -> tuple[Recommendation, bool, int]:
    """Drop evidence ids not in the session; rebuild citations from real evidence.

    Returns (rec, sufficient, stripped_count)."""
    by_id = {e.id: e for e in evidence}
    stripped = 0
    for p in rec.evidence_backed_points:
        kept = [i for i in p.evidence_ids if i in by_id]
        stripped += len(p.evidence_ids) - len(kept)
        p.evidence_ids = kept
    rec.evidence_backed_points = [p for p in rec.evidence_backed_points if p.evidence_ids]
    cited = {by_id[i].arxiv_id: by_id[i] for p in rec.evidence_backed_points for i in p.evidence_ids}
    rec.citations = [Citation(arxiv_id=a, title=e.title, url=e.url) for a, e in cited.items()]
    return rec, len(cited) >= 2, stripped


def _finish(s: Session, rec: Recommendation) -> None:
    s.log("verifier", "Checking every cited evidence id against retrieved passages")
    s.recommendation, enough, stripped = verify(rec, s.evidence)
    known = {e.id for e in s.evidence}
    if s.hypothesis:
        h = s.hypothesis
        h.supporting_evidence_ids = [i for i in h.supporting_evidence_ids if i in known]
        h.contradicting_evidence_ids = [i for i in h.contradicting_evidence_ids
                                        if i in known and i not in h.supporting_evidence_ids]
        s.log("verifier", f"Evidence balance: {len(h.supporting_evidence_ids)} supporting, "
                          f"{len(h.contradicting_evidence_ids)} contradicting")
    s.log("verifier", f"{len(s.recommendation.citations)} papers cited, {stripped} unverifiable id(s) stripped")
    s.status = "done" if enough else "insufficient_evidence"
    s.log("system", "Done" if enough else "Fewer than 2 distinct papers support the conclusion")


def run_session(s: Session, on_update: Callable[[Session], None] = lambda s: None) -> Session:
    s.started = time.time()  # measure from job start, not queue entry
    if settings.fake_llm:
        return _fake_run(s, on_update)

    def step(status: str):
        s.status = status
        on_update(s)

    try:
        step("retrieving")
        s.log("planner", "Turning the question into arXiv searches")
        plan: SearchPlan = agents.run(agents.planner(), s.question)
        s.log("planner", "Planned: " + "; ".join(plan.queries or [s.question]))
        s.evidence = _retrieve(s, plan.queries or [s.question])
        feedback = ""
        while s.evidence:
            step("synthesizing")
            s.log("synthesis", f"Drafting a hypothesis from {len(s.evidence)} passages")
            ev = agents.evidence_block(s.evidence)
            s.hypothesis = agents.run(agents.synthesizer(),
                                      f"Question: {s.question}\n\nEvidence:\n{ev}\n\n{feedback}")
            s.log("synthesis", s.hypothesis.statement)
            step("critiquing")
            s.log("critic", "Checking each claim against its cited evidence")
            crit: Critique = agents.run(agents.critic(),
                                        f"Question: {s.question}\n\nHypothesis:\n{s.hypothesis.model_dump_json()}"
                                        f"\n\nEvidence:\n{ev}")
            s.critiques.append(crit)
            s.log("critic", f"Confidence {crit.confidence:.0%}, {len(crit.unsupported_claims)} unsupported claim(s)"
                  + (f"; wants: {', '.join(crit.missing_evidence[:3])}" if crit.needs_more_evidence else ""))
            # loop cap enforced in code, not by the model
            if not (crit.needs_more_evidence and s.iteration < settings.max_revisions and crit.missing_evidence):
                break
            s.iteration += 1
            step("retrieving")
            s.log("system", f"Revision {s.iteration}: critic asked for more evidence")
            s.evidence += _retrieve(s, crit.missing_evidence)
            feedback = f"Previous critique to address:\n{crit.model_dump_json()}"

        if not s.evidence or s.hypothesis is None:
            s.status = "insufficient_evidence"
            s.error = "No relevant arXiv papers found for this question."
            s.log("system", s.error)
            on_update(s)
            return s
        step("finalizing")
        s.log("final", "Writing the evidence-grounded recommendation")
        rec = agents.run(agents.finalizer(),
                         f"Question: {s.question}\n\nHypothesis:\n{s.hypothesis.model_dump_json()}\n\n"
                         f"Critique:\n{s.critiques[-1].model_dump_json()}\n\nEvidence:\n{agents.evidence_block(s.evidence)}")
        _finish(s, rec)
    except Exception as e:  # surface failure instead of hanging
        s.status, s.error = "failed", f"{type(e).__name__}: {e}"
        s.log("system", f"Failed: {s.error}")
    on_update(s)
    return s


def _fake_run(s: Session, on_update) -> Session:
    """Deterministic canned run for Playwright/API tests (CS_FAKE_LLM=1). No Ollama, no arXiv."""
    def beat(status: str, agent: str, msg: str):
        s.status = status
        s.log(agent, msg)
        on_update(s)
        time.sleep(0.35)  # ponytail: lets the UI animation play in demos/tests; ~4 s total

    beat("retrieving", "planner", "Turning the question into arXiv searches")
    beat("retrieving", "planner", "Planned: retrieval augmented generation; hallucination LLM")
    beat("retrieving", "arxiv", 'Searching arXiv: "retrieval augmented generation"')
    s.evidence = [
        Evidence(id="E1", arxiv_id="1706.03762", title="Attention Is All You Need",
                 url="http://arxiv.org/abs/1706.03762v7", passage="The Transformer relies entirely on attention.", score=0.9),
        Evidence(id="E2", arxiv_id="2005.11401", title="Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
                 url="http://arxiv.org/abs/2005.11401v4", passage="RAG combines parametric and non-parametric memory.", score=0.8),
    ]
    beat("retrieving", "ranker", "Selected 2 passages from 2 papers")
    s.evidence.append(Evidence(id="E3", arxiv_id="2005.11401", section="fulltext", score=0.74,
                               title="Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
                               url="http://arxiv.org/abs/2005.11401v4",
                               passage="Retrieval can surface irrelevant documents that mislead generation."))
    beat("retrieving", "reader", "Read full text of 'Retrieval-Augmented Generation for Knowledge': 61 sections")
    beat("synthesizing", "synthesis", "Drafting a hypothesis from 2 passages")
    s.hypothesis = Hypothesis(statement="Retrieval augmentation improves factuality of transformer LMs.",
                              rationale="E1 introduces transformers; E2 shows retrieval helps knowledge tasks.",
                              supporting_evidence_ids=["E1", "E2"], contradicting_evidence_ids=["E3"])
    beat("critiquing", "critic", "Checking each claim against its cited evidence")
    s.critiques = [Critique(missing_evidence=[], confidence=0.7, needs_more_evidence=False,
                            methodology_concerns=["Benchmarks are mostly open-domain QA."])]
    beat("finalizing", "final", "Writing the evidence-grounded recommendation")
    rec = Recommendation(
        conclusion="Use retrieval augmentation for knowledge-intensive tasks.",
        evidence_backed_points=[{"text": "RAG improves knowledge-intensive tasks.", "evidence_ids": ["E2", "E99"]},
                                {"text": "Transformers are attention-based.", "evidence_ids": ["E1"]}],
        inferences=["Gains likely transfer to scientific QA."], caveats=["Fake mode output."], confidence=0.7)
    _finish(s, rec)
    on_update(s)
    return s
