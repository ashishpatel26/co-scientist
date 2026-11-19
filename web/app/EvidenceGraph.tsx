"use client";

import { useState } from "react";
import type { Hypothesis, Session } from "@/lib/api";

export type Stance = "supports" | "contradicts" | "neutral";
export const STANCE: Record<Stance, { color: string; label: string }> = {
  supports: { color: "#34d399", label: "supports" },
  contradicts: { color: "#fb7185", label: "contradicts" },
  neutral: { color: "#67e8f9", label: "cited" },
};
export const stanceOf = (id: string, h: Hypothesis | null): Stance =>
  h?.contradicting_evidence_ids.includes(id) ? "contradicts" : h?.supporting_evidence_ids.includes(id) ? "supports" : "neutral";

type Node = { id: string; col: number; label: string; full: string; color: string };
type Edge = { from: string; to: string; color: string; dashed?: boolean };

const ROW = 46, W = 1000;
const COLS = [{ x: 0, w: 190 }, { x: 250, w: 250 }, { x: 570, w: 90 }, { x: 730, w: 270 }];
const HEAD = ["Hypothesis", "Claims", "Evidence", "Papers"];
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** Question-to-source reasoning map: hypothesis → claims → evidence passages → papers. */
export default function EvidenceGraph({ s }: { s: Session }) {
  const [hover, setHover] = useState<string | null>(null);
  const rec = s.recommendation, h = s.hypothesis;
  if (!rec || !h) return null;
  const byId = Object.fromEntries(s.evidence.map((e) => [e.id, e]));

  const nodes: Node[] = [{ id: "H", col: 0, label: cut(h.statement, 26), full: h.statement, color: "#a78bfa" }];
  const edges: Edge[] = [];
  rec.evidence_backed_points.forEach((p, i) => {
    nodes.push({ id: `C${i}`, col: 1, label: cut(p.text, 34), full: p.text, color: "#e879f9" });
    edges.push({ from: "H", to: `C${i}`, color: "#a78bfa" });
    p.evidence_ids.forEach((e) => edges.push({ from: `C${i}`, to: e, color: STANCE[stanceOf(e, h)].color }));
  });
  const claimed = new Set(edges.map((e) => e.to));
  // contradicting evidence that no claim uses still belongs on the map: it argues against the hypothesis
  h.contradicting_evidence_ids.filter((e) => !claimed.has(e)).forEach((e) =>
    edges.push({ from: "H", to: e, color: STANCE.contradicts.color, dashed: true }));
  const evIds = [...new Set(edges.map((e) => e.to).filter((t) => byId[t]))];
  evIds.forEach((e) => nodes.push({ id: e, col: 2, label: e, full: byId[e].passage, color: STANCE[stanceOf(e, h)].color }));
  [...new Set(evIds.map((e) => byId[e].arxiv_id))].forEach((a) => {
    const ev = evIds.find((e) => byId[e].arxiv_id === a)!;
    nodes.push({ id: `P${a}`, col: 3, label: cut(byId[ev].title, 38), full: `${byId[ev].title} (arXiv:${a})`, color: "#94a3b8" });
  });
  evIds.forEach((e) => edges.push({ from: e, to: `P${byId[e].arxiv_id}`, color: "#64748b" }));
  const valid = edges.filter((e) => nodes.some((n) => n.id === e.to));

  const rows = Math.max(...[0, 1, 2, 3].map((c) => nodes.filter((n) => n.col === c).length));
  const H = rows * ROW + 40;
  const pos: Record<string, { x: number; y: number; w: number }> = {};
  [0, 1, 2, 3].forEach((c) => {
    const col = nodes.filter((n) => n.col === c);
    col.forEach((n, i) => (pos[n.id] = { x: COLS[c].x, w: COLS[c].w, y: 30 + (H - 30 - col.length * ROW) / 2 + i * ROW + ROW / 2 }));
  });
  const linked = (n: string) => !hover || n === hover || valid.some((e) => (e.from === hover && e.to === n) || (e.to === hover && e.from === n));
  const path = (e: Edge) => {
    const a = pos[e.from], b = pos[e.to], x1 = a.x + a.w, x2 = b.x, mx = (x1 + x2) / 2;
    return `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
  };

  return (
    <svg data-testid="evidence-graph" viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img"
      aria-label="Evidence graph linking hypothesis, claims, evidence passages and papers">
      {HEAD.map((t, c) => (
        <text key={t} x={COLS[c].x + 4} y={14} className="fill-slate-500 text-[11px] uppercase tracking-[.2em]">{t}</text>
      ))}
      {valid.map((e, i) => {
        const d = path(e), on = !hover || e.from === hover || e.to === hover;
        return (
          <g key={i} style={{ opacity: on ? 1 : 0.12, transition: "opacity .3s" }}>
            <path d={d} pathLength={1} fill="none" stroke={e.color} strokeWidth={on && hover ? 2.4 : 1.4}
              strokeDasharray={e.dashed ? "0.02 0.015" : "1"} className={e.dashed ? "" : "draw"} style={{ animationDelay: `${pos[e.from].x / 900}s` }} />
            <circle r={2.6} fill={e.color}>
              <animateMotion dur={`${2.2 + (i % 5) * 0.35}s`} repeatCount="indefinite" path={d} />
            </circle>
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = pos[n.id], on = linked(n.id);
        return (
          <g key={n.id} data-node={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
            className="fade-up cursor-default" style={{ opacity: on ? 1 : 0.25, transition: "opacity .3s", animationDelay: `${n.col * 150}ms` }}>
            <title>{n.full}</title>
            <rect x={p.x} y={p.y - 16} width={p.w} height={32} rx={9} fill={`${n.color}1f`} stroke={n.color}
              strokeWidth={hover === n.id ? 2 : 1} />
            <text x={p.x + (n.col === 2 ? p.w / 2 : 10)} y={p.y + 4} textAnchor={n.col === 2 ? "middle" : "start"}
              className={`text-[12px] ${n.col === 2 ? "font-mono font-semibold" : ""}`} fill={n.col === 2 ? n.color : "#e2e8f0"}>{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
