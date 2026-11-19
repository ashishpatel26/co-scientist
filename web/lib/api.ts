// Typed client for the FastAPI gateway (mirrors src/co_scientist/schemas.py).
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Evidence = { id: string; arxiv_id: string; title: string; url: string; passage: string; score: number; section: "abstract" | "fulltext" };
export type Hypothesis = {
  statement: string; rationale: string; supporting_evidence_ids: string[]; contradicting_evidence_ids: string[]; assumptions: string[];
};
export type Critique = {
  unsupported_claims: string[];
  contradictions: string[];
  methodology_concerns: string[];
  missing_evidence: string[];
  confidence: number;
  needs_more_evidence: boolean;
};
export type Recommendation = {
  conclusion: string;
  evidence_backed_points: { text: string; evidence_ids: string[] }[];
  inferences: string[];
  caveats: string[];
  confidence: number;
  citations: { arxiv_id: string; title: string; url: string }[];
};
export type Session = {
  id: string;
  question: string;
  status: string;
  iteration: number;
  position: number;
  evidence: Evidence[];
  hypothesis: Hypothesis | null;
  critiques: Critique[];
  recommendation: Recommendation | null;
  error: string | null;
  events: AgentEvent[];
};
export type AgentEvent = { t: number; agent: string; msg: string };

const headers = (): HeadersInit => {
  const key = process.env.NEXT_PUBLIC_API_KEY;
  return { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}) };
};

async function check(r: Response) {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join("; ") : body.detail;
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function createSession(question: string): Promise<{ session_id: string }> {
  return check(await fetch(`${API_URL}/sessions`, { method: "POST", headers: headers(), body: JSON.stringify({ question }) }));
}

export async function getSession(id: string): Promise<Session> {
  return check(await fetch(`${API_URL}/sessions/${id}`, { headers: headers(), cache: "no-store" }));
}

export const TERMINAL = new Set(["done", "insufficient_evidence", "failed"]);

/** Live session updates over Server-Sent Events. Returns a close() function. */
export function streamSession(id: string, onSnap: (s: Session) => void, onError: () => void): () => void {
  const key = process.env.NEXT_PUBLIC_API_KEY;
  const es = new EventSource(`${API_URL}/sessions/${id}/stream${key ? `?key=${encodeURIComponent(key)}` : ""}`);
  es.onmessage = (m) => {
    const s: Session = JSON.parse(m.data);
    onSnap(s);
    if (TERMINAL.has(s.status)) es.close();
  };
  es.onerror = () => { es.close(); onError(); };
  return () => es.close();
}
