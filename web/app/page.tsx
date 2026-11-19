"use client";

import { useEffect, useRef, useState } from "react";
import { createSession, getSession, streamSession, TERMINAL, type Evidence, type Session } from "@/lib/api";
import EvidenceGraph, { stanceOf, STANCE } from "./EvidenceGraph";

const AGENTS = [
  { id: "planner", label: "Planner", icon: "🧭", color: "#a78bfa", role: "plans searches" },
  { id: "arxiv", label: "arXiv", icon: "📚", color: "#60a5fa", role: "fetches papers" },
  { id: "ranker", label: "Ranker", icon: "🧲", color: "#22d3ee", role: "Chroma embeddings" },
  { id: "reader", label: "Reader", icon: "📖", color: "#818cf8", role: "reads full text" },
  { id: "synthesis", label: "Synthesis", icon: "💡", color: "#34d399", role: "drafts hypothesis" },
  { id: "critic", label: "Critic", icon: "🔍", color: "#fbbf24", role: "challenges claims" },
  { id: "final", label: "Final", icon: "📝", color: "#f472b6", role: "writes answer" },
  { id: "verifier", label: "Verifier", icon: "🛡️", color: "#f87171", role: "checks citations" },
];
const COLOR: Record<string, string> = { system: "#94a3b8", ...Object.fromEntries(AGENTS.map((a) => [a.id, a.color])) };
const EXAMPLES = [
  "Does retrieval-augmented generation reduce hallucination in LLMs?",
  "Is chain-of-thought prompting effective for small language models?",
  "Do diffusion models outperform GANs on image fidelity?",
];
const glass = "rounded-2xl bg-white/[.04] backdrop-blur-xl ring-1 ring-white/10 shadow-2xl shadow-black/40";
const pct = (n: number) => `${Math.round(n * 100)}%`;

const Card = ({ title, children, id, delay = 0 }: { title: string; children: React.ReactNode; id?: string; delay?: number }) => (
  <section data-testid={id} className={`${glass} fade-up p-5 space-y-3`} style={{ animationDelay: `${delay}ms` }}>
    <h2 className="text-[11px] font-semibold uppercase tracking-[.2em] text-violet-300/80">{title}</h2>
    {children}
  </section>
);

const List = ({ title, items }: { title: string; items: string[] }) =>
  items.length ? (
    <div><h3 className="text-xs font-medium text-slate-400 mb-1">{title}</h3>
      <ul className="list-disc pl-5 text-sm space-y-1 text-slate-300">{items.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
  ) : null;

const Meter = ({ value, label = "confidence" }: { value: number; label?: string }) => (
  <div className="flex items-center gap-3 text-xs text-slate-400">
    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 transition-[width] duration-1000" style={{ width: pct(value) }} />
    </div>{pct(value)} {label}
  </div>
);

/** Evidence id chip with a hover/focus card showing the passage, section, score and stance. */
function EvidenceChip({ e, id, s }: { e?: Evidence; id: string; s: Session }) {
  const st = STANCE[stanceOf(id, s.hypothesis)];
  return (
    <span className="group relative inline-block">
      <a href={e?.url} target="_blank" rel="noreferrer" data-testid="evidence-chip"
        className="ml-1 rounded px-1.5 py-0.5 font-mono text-[11px] ring-1 transition hover:brightness-125"
        style={{ color: st.color, background: `${st.color}1a`, borderColor: st.color, boxShadow: `inset 0 0 0 1px ${st.color}40` }}>{id}</a>
      {e && (
        <span role="tooltip" data-testid="evidence-card"
          className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-80 -translate-x-1/2 translate-y-1 rounded-xl bg-slate-900/95 p-3 text-left text-xs opacity-0 shadow-2xl ring-1 ring-white/15 backdrop-blur transition-all duration-200 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <span className="mb-1 flex items-center gap-2">
            <b className="font-mono" style={{ color: st.color }}>{id}</b>
            <span className="rounded bg-white/10 px-1.5 text-[10px] uppercase tracking-wider text-slate-300">{e.section}</span>
            <span className="text-[10px]" style={{ color: st.color }}>{st.label}</span>
            <span className="ml-auto text-[10px] text-slate-500">match {e.score.toFixed(2)}</span>
          </span>
          <span className="block font-medium text-slate-100">{e.title}</span>
          <span className="mt-1 block leading-relaxed text-slate-400">“{e.passage}”</span>
        </span>
      )}
    </span>
  );
}

function Balance({ s }: { s: Session }) {
  const sup = s.hypothesis?.supporting_evidence_ids.length ?? 0, con = s.hypothesis?.contradicting_evidence_ids.length ?? 0;
  if (!sup && !con) return null;
  return (
    <div data-testid="balance" className="space-y-1">
      <div className="flex h-2 overflow-hidden rounded-full bg-white/10">
        <div className="bg-emerald-400 transition-[width] duration-1000" style={{ width: `${(sup / (sup + con)) * 100}%` }} />
        <div className="bg-rose-400 transition-[width] duration-1000" style={{ width: `${(con / (sup + con)) * 100}%` }} />
      </div>
      <p className="text-[11px] text-slate-400"><span className="text-emerald-300">{sup} supporting</span> · <span className="text-rose-300">{con} contradicting</span></p>
    </div>
  );
}

function Pipeline({ s }: { s: Session }) {
  const running = !TERMINAL.has(s.status);
  const seen = new Set(s.events.map((e) => e.agent));
  const active = running ? [...s.events].reverse().find((e) => e.agent !== "system")?.agent : undefined;
  const state = (id: string) => (id === active ? "active" : seen.has(id) ? "done" : "idle");
  return (
    <div className={`${glass} p-5 overflow-x-auto`}>
      <div className="flex min-w-[740px] items-start">
        {AGENTS.map((a, i) => {
          const st = state(a.id), next = AGENTS[i + 1] && state(AGENTS[i + 1].id);
          return (
            <div key={a.id} className="flex flex-1 items-start last:flex-none">
              <div className="flex w-20 flex-col items-center gap-2 text-center" data-agent={a.id} data-state={st}>
                <div className={`relative grid h-14 w-14 place-items-center rounded-2xl text-2xl transition-all duration-500
                  ${st === "active" ? "halo scale-110" : st === "idle" ? "opacity-30 grayscale" : ""}`}
                  style={{ "--c": a.color, background: `${a.color}22`, boxShadow: st !== "idle" ? `0 0 24px ${a.color}55` : undefined,
                    border: `1px solid ${st === "idle" ? "#ffffff1a" : a.color}` } as React.CSSProperties}>
                  {st === "active" && <span className="orbit absolute -inset-1.5 rounded-[1.1rem] border-2 border-dashed" style={{ borderColor: a.color }} />}
                  {a.icon}
                  {st === "done" && <span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-[10px] text-white fade-up">✓</span>}
                </div>
                <div>
                  <div className={`text-xs font-semibold ${st === "idle" ? "text-slate-500" : "text-slate-100"}`}>{a.label}</div>
                  <div className="text-[10px] text-slate-500">{a.role}</div>
                </div>
              </div>
              {AGENTS[i + 1] && (
                <div className="mt-7 h-0.5 flex-1 overflow-hidden rounded bg-white/10">
                  <div className={`h-full ${next === "active" ? "flow w-full" : next === "done" ? "w-full bg-gradient-to-r from-violet-500 to-cyan-400" : "w-0"} transition-all duration-700`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {s.iteration > 0 && (
        <p data-testid="iteration" className="fade-up mt-4 text-center text-xs text-amber-300">
          ↺ Revision {s.iteration}: the Critic sent the loop back to arXiv for more evidence
        </p>
      )}
    </div>
  );
}

function ActivityLog({ s }: { s: Session }) {
  const end = useRef<HTMLLIElement>(null);
  const running = !TERMINAL.has(s.status);
  // braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect may only return a cleanup fn
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [s.events.length]);
  return (
    <section data-testid="activity" className={`${glass} flex max-h-[70vh] flex-col overflow-hidden`}>
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="flex gap-1.5">{["#f87171", "#fbbf24", "#34d399"].map((c) => <i key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />)}</span>
        <h2 className="ml-2 text-xs font-semibold uppercase tracking-[.2em] text-slate-400">Agent activity</h2>
        {running && <span className="ml-auto flex items-center gap-1.5 text-[10px] text-emerald-400"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />LIVE</span>}
      </header>
      <ol className="flex-1 space-y-2 overflow-y-auto p-4 font-mono text-xs">
        {s.events.map((e, i) => {
          const last = i === s.events.length - 1 && running;
          return (
            <li key={i} ref={i === s.events.length - 1 ? end : undefined} className="slide-in flex gap-2 leading-relaxed">
              <span className="w-12 shrink-0 text-right text-slate-500">+{e.t.toFixed(1)}s</span>
              <span className="w-[4.5rem] shrink-0 font-semibold" style={{ color: COLOR[e.agent] ?? "#94a3b8" }}>{e.agent}</span>
              <span className={last ? "shimmer caret" : "text-slate-300"}>{e.msg}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [s, setS] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let stop = false, fails = 0;
    // fallback when SSE is blocked (proxy, old browser): poll, tolerating transient blips
    const poll = () => getSession(id)
      .then((r) => { if (stop) return; fails = 0; setS(r); if (!TERMINAL.has(r.status)) setTimeout(poll, 800); })
      .catch((e) => { if (stop) return; if (++fails < 5) setTimeout(poll, 1500); else setError(`Lost connection: ${e.message}`); });
    // primary: server pushes each change within ~200 ms
    const close = streamSession(id, (r) => !stop && setS(r), () => !stop && poll());
    return () => { stop = true; close(); };
  }, [id]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setS(null); setId(null);
    createSession(question).then((r) => setId(r.session_id)).catch((err) => setError(`Request failed: ${err.message}`));
  };

  const running = !!s && !TERMINAL.has(s.status);
  const rec = s?.recommendation;
  const ev = Object.fromEntries((s?.evidence ?? []).map((e) => [e.id, e]));
  const elapsed = s?.events.at(-1)?.t ?? 0;

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="blob left-[-10%] top-[-10%] h-[40vw] w-[40vw] bg-violet-600" />
      <div className="blob right-[-10%] top-[20%] h-[35vw] w-[35vw] bg-cyan-500" style={{ animationDelay: "-6s" }} />
      <div className="blob bottom-[-15%] left-[30%] h-[30vw] w-[30vw] bg-fuchsia-600" style={{ animationDelay: "-12s" }} />

      <div className="relative z-10 mx-auto max-w-6xl space-y-6 px-4 py-12">
        <header className="fade-up space-y-3 text-center">
          <p className="text-[11px] uppercase tracking-[.3em] text-cyan-300/80">Multi-agent · arXiv-grounded · critic in the loop</p>
          <h1 className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-5xl font-bold tracking-tight text-transparent">Research Co-Scientist</h1>
          <p className="text-slate-400">Ask a research question. Watch eight agents find, read, argue and cite the evidence.</p>
        </header>

        <form onSubmit={submit} className={`${glass} fade-up mx-auto max-w-3xl space-y-3 p-4`} style={{ animationDelay: "100ms" }}>
          <div className="flex items-end gap-3">
            <textarea data-testid="question-input" aria-label="Research question" rows={2} value={question}
              onChange={(e) => setQuestion(e.target.value)} placeholder={EXAMPLES[0]}
              className="flex-1 resize-none bg-transparent text-lg text-slate-100 outline-none placeholder:text-slate-600" />
            <button data-testid="submit" disabled={running || !question.trim()}
              className="rounded-xl bg-gradient-to-r from-violet-600 to-cyan-500 px-6 py-3 font-semibold text-white shadow-lg shadow-violet-900/50 transition hover:scale-[1.03] hover:shadow-violet-600/40 disabled:scale-100 disabled:opacity-40">
              {running ? "Investigating…" : "Investigate →"}
            </button>
          </div>
          {!s && <div className="flex flex-wrap gap-2">{EXAMPLES.map((q) => (
            <button type="button" key={q} onClick={() => setQuestion(q)}
              className="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-400 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-slate-200">{q}</button>))}
          </div>}
        </form>

        {error && <p role="alert" data-testid="error" className="fade-up mx-auto max-w-3xl rounded-xl bg-red-500/10 p-3 text-red-300 ring-1 ring-red-500/30">{error}</p>}

        {s && (
          <>
            <div data-testid="status" data-status={s.status} className="flex items-center justify-center gap-3 text-xs text-slate-400">
              <span className={`rounded-full px-3 py-1 font-medium ring-1 ${running ? "bg-violet-500/15 text-violet-200 ring-violet-400/30" : s.status === "done" ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30" : "bg-amber-500/15 text-amber-200 ring-amber-400/30"}`}>
                {running ? "● " : ""}{s.status.replace("_", " ")}
              </span>
              <span className="font-mono">{elapsed.toFixed(1)}s</span>
              <span>· {s.evidence.length} passages</span>
              {s.position > 0 && <span>· queue #{s.position}</span>}
            </div>
            <Pipeline s={s} />
          </>
        )}

        {s && (
          <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
            <div className="space-y-6">
              {s.status === "failed" && <p role="alert" data-testid="failed" className="fade-up rounded-xl bg-red-500/10 p-3 text-red-300 ring-1 ring-red-500/30">Failed: {s.error}</p>}
              {s.status === "insufficient_evidence" && <p role="alert" data-testid="insufficient" className="fade-up rounded-xl bg-amber-500/10 p-3 text-amber-200 ring-1 ring-amber-500/30">
                ⚠ Insufficient evidence: too few distinct papers support a conclusion. {s.error}</p>}

              {rec && (
                <Card title="Recommendation" id="recommendation">
                  <p className="text-xl font-medium leading-snug text-white">{rec.conclusion}</p>
                  <Meter value={rec.confidence} />
                  <ul className="space-y-2 text-sm">{rec.evidence_backed_points.map((p, i) => (
                    <li key={i} className="fade-up flex gap-2 text-slate-200" style={{ animationDelay: `${200 + i * 120}ms` }}>
                      <span className="text-emerald-400">✓</span><span>{p.text} {p.evidence_ids.map((e) => <EvidenceChip key={e} id={e} e={ev[e]} s={s} />)}</span>
                    </li>))}
                  </ul>
                  <List title="Inference (beyond the evidence)" items={rec.inferences} />
                  <List title="Caveats" items={rec.caveats} />
                  <ol data-testid="citations" className="list-decimal space-y-1 border-t border-white/10 pt-3 pl-5 text-sm">
                    {rec.citations.map((c) => <li key={c.arxiv_id}><a href={c.url} target="_blank" rel="noreferrer" className="text-violet-200 underline decoration-violet-400/50 hover:decoration-violet-300">{c.title}</a> <span className="text-slate-500">arXiv:{c.arxiv_id}</span></li>)}
                  </ol>
                </Card>
              )}

              {rec && s.hypothesis && (
                <Card title="Evidence graph · hover a node" id="graph" delay={60}><EvidenceGraph s={s} /></Card>
              )}

              {s.hypothesis && (
                <Card title="Hypothesis" id="hypothesis" delay={100}>
                  <p className="text-slate-100">{s.hypothesis.statement}</p>
                  <p className="text-sm text-slate-400">{s.hypothesis.rationale}</p>
                  <Balance s={s} />
                  <p className="text-xs text-slate-400">
                    {[...s.hypothesis.supporting_evidence_ids, ...s.hypothesis.contradicting_evidence_ids].map((e) => <EvidenceChip key={e} id={e} e={ev[e]} s={s} />)}
                  </p>
                </Card>
              )}

              {s.critiques.map((c, i) => (
                <Card key={i} title={`Critique ${i + 1}${c.needs_more_evidence ? " · asked for more evidence" : ""}`} id="critique" delay={150 + i * 100}>
                  <Meter value={c.confidence} label="critic confidence" />
                  <List title="Unsupported claims" items={c.unsupported_claims} />
                  <List title="Contradictions" items={c.contradictions} />
                  <List title="Methodology" items={c.methodology_concerns} />
                  <List title="Missing evidence" items={c.missing_evidence} />
                </Card>
              ))}

              {!!s.evidence.length && (
                <details className={`${glass} fade-up p-5`}>
                  <summary className="cursor-pointer text-sm font-medium text-slate-300">Evidence ({s.evidence.length} passages)</summary>
                  <div className="mt-3 space-y-2">{s.evidence.map((e) => {
                    const st = STANCE[stanceOf(e.id, s.hypothesis)];
                    return (
                      <p key={e.id} className="border-l-2 pl-3 text-sm" style={{ borderColor: st.color }}>
                        <span className="font-mono" style={{ color: st.color }}>{e.id}</span>{" "}
                        <span className="rounded bg-white/10 px-1.5 text-[10px] uppercase tracking-wider text-slate-400">{e.section}</span>{" "}
                        <a href={e.url} target="_blank" rel="noreferrer" className="font-medium text-slate-200 underline decoration-white/20">{e.title}</a> <span className="text-slate-500">— {e.passage}</span>
                      </p>
                    );
                  })}</div>
                </details>
              )}
            </div>
            <div className="lg:sticky lg:top-6 lg:self-start"><ActivityLog s={s} /></div>
          </div>
        )}
      </div>
    </main>
  );
}
