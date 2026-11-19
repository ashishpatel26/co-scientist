import time

from pydantic import BaseModel, Field


class SearchPlan(BaseModel):
    queries: list[str] = Field(description="2-4 short arXiv keyword search strings")


class Paper(BaseModel):
    arxiv_id: str
    title: str
    authors: list[str]
    abstract: str
    published: str
    url: str


class Evidence(BaseModel):
    id: str  # E1, E2, ... stable within a session
    arxiv_id: str
    title: str
    url: str
    passage: str
    score: float
    section: str = "abstract"  # abstract | fulltext


class Hypothesis(BaseModel):
    statement: str
    rationale: str
    supporting_evidence_ids: list[str] = Field(description="Evidence ids like E1, E3 that support the hypothesis")
    contradicting_evidence_ids: list[str] = Field(
        default=[], description="Evidence ids that contradict or weaken the hypothesis")
    assumptions: list[str] = []


class Critique(BaseModel):
    unsupported_claims: list[str] = []
    contradictions: list[str] = []
    methodology_concerns: list[str] = []
    missing_evidence: list[str] = Field(default=[], description="Topics to search for if evidence is weak")
    confidence: float = Field(ge=0, le=1)
    needs_more_evidence: bool


class EvidencePoint(BaseModel):
    text: str
    evidence_ids: list[str]


class Citation(BaseModel):
    arxiv_id: str
    title: str
    url: str


class Recommendation(BaseModel):
    conclusion: str
    evidence_backed_points: list[EvidencePoint]
    inferences: list[str] = Field(default=[], description="Conclusions NOT directly stated in the evidence")
    caveats: list[str] = []
    confidence: float = Field(ge=0, le=1)
    citations: list[Citation] = []


class Event(BaseModel):
    t: float  # seconds since session start
    agent: str  # planner|arxiv|ranker|synthesis|critic|final|verifier|system
    msg: str


class Session(BaseModel):
    id: str
    question: str
    status: str = "queued"  # queued|retrieving|synthesizing|critiquing|finalizing|done|insufficient_evidence|failed
    iteration: int = 0
    evidence: list[Evidence] = []
    hypothesis: Hypothesis | None = None
    critiques: list[Critique] = []
    recommendation: Recommendation | None = None
    error: str | None = None
    events: list[Event] = []
    started: float = Field(default_factory=time.time)

    def log(self, agent: str, msg: str) -> None:
        self.events.append(Event(t=round(time.time() - self.started, 1), agent=agent, msg=msg))
