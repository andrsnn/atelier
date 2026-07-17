"use client";
import React from "react";

/** A state for the graph — the subset of StateDef the diagram needs. */
export interface GraphState { id: string; name: string; tools?: string[]; gate?: boolean; rejectTo?: string; offPath?: boolean; returnTo?: string }
export interface MachineGraphProps {
  states: GraphState[];
  /** live-run overlay (omit for the static config view) */
  currentIdx?: number;        // run.state_index
  status?: string;            // run.status — "running" | "done" | …
  countFor?: (id: string) => number;  // attempts / loop-backs per state
  viewIdx?: number;           // the phase currently being viewed (highlight)
  onNode?: (idx: number) => void;     // click a node
}

const NODE_W = 158, NODE_H = 62, GAP_X = 60, PAD = 18, MAIN_Y = 16, BRANCH_DY = 108;

/** The machine as a node graph: main phases wired left→right, off-path leaves hanging
 *  below their anchor, reject loop-backs as arcs, off-path rejoin wires. Same data as the
 *  config cards / YAML — just a different (ComfyUI-style) view. Read-only; click to focus. */
export default function MachineGraph({ states, currentIdx, status, countFor, viewIdx, onNode }: MachineGraphProps) {
  const idx = states.map((s, i) => ({ s, i }));
  const main = idx.filter(x => !x.s.offPath);
  const offs = idx.filter(x => x.s.offPath);
  const nameOf = (id?: string) => states.find(s => s.id === id)?.name || id || "";
  const idOf = (id?: string) => states.findIndex(s => s.id === id);
  // anchor an off-path leaf to the main phase right before its returnTo target (its "alt-of")
  const anchorOf = (o: { s: GraphState; i: number }) => {
    const rt = idOf(o.s.returnTo);
    let a = main[0]; for (const m of main) if (m.i < (rt < 0 ? states.length : rt)) a = m; return a;
  };

  const pos: Record<number, { x: number; y: number }> = {};
  main.forEach((m, k) => { pos[m.i] = { x: PAD + k * (NODE_W + GAP_X), y: MAIN_Y }; });
  const usedByAnchor: Record<number, number> = {};
  offs.forEach(o => { const a = anchorOf(o); if (!a) return; const n = usedByAnchor[a.i] || 0; pos[o.i] = { x: pos[a.i].x + n * (NODE_W + 24), y: MAIN_Y + BRANCH_DY }; usedByAnchor[a.i] = n + 1; });

  const hasBranch = offs.some(o => pos[o.i]);
  const width = PAD * 2 + Math.max(1, main.length) * (NODE_W + GAP_X) - GAP_X;
  const height = (hasBranch ? MAIN_Y + BRANCH_DY + NODE_H : MAIN_Y + NODE_H) + 26;

  const rc = (i: number) => ({ x: pos[i].x + NODE_W, y: pos[i].y + NODE_H / 2 });
  const lc = (i: number) => ({ x: pos[i].x, y: pos[i].y + NODE_H / 2 });
  const bc = (i: number) => ({ x: pos[i].x + NODE_W / 2, y: pos[i].y + NODE_H });
  const tc = (i: number) => ({ x: pos[i].x + NODE_W / 2, y: pos[i].y });

  const nodeStatus = (i: number): "done" | "current" | "pending" | "idle" => {
    if (currentIdx == null) return "idle";
    if (states[i].offPath) return i === currentIdx && status === "running" ? "current" : "idle";
    if (status === "done") return "done";
    if (i < currentIdx) return "done";
    if (i === currentIdx) return "current";
    return "pending";
  };

  const wires: React.ReactNode[] = [];
  const wire = (key: string, d: string, color: string, dash: boolean, marker: string) =>
    wires.push(<path key={key} d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={dash ? "5 4" : undefined} markerEnd={`url(#${marker})`} opacity={0.9} />);

  // sequential main flow
  for (let k = 1; k < main.length; k++) {
    const a = main[k - 1].i, b = main[k].i;
    const p1 = rc(a), p2 = lc(b), mx = (p1.x + p2.x) / 2;
    const done = currentIdx != null && (status === "done" || b <= currentIdx);
    wire(`seq-${k}`, `M${p1.x},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x},${p2.y}`, done ? "var(--success)" : "var(--ink-dim)", false, done ? "mg-arrow-ok" : "mg-arrow");
  }
  // reject loop-backs — dashed arcs below the row
  idx.forEach(({ s, i }) => {
    const t = idOf(s.rejectTo); if (!s.rejectTo || t < 0 || !pos[i] || !pos[t]) return;
    const p1 = bc(i), p2 = bc(t), dip = 44 + Math.abs(p1.x - p2.x) * 0.05;
    wire(`rej-${i}`, `M${p1.x},${p1.y} C${p1.x},${p1.y + dip} ${p2.x},${p2.y + dip} ${p2.x},${p2.y}`, "var(--warning)", true, "mg-arrow-warn");
  });
  // off-path: anchor → leaf (down), leaf → returnTo (rejoin)
  offs.forEach(o => {
    const a = anchorOf(o); if (!a || !pos[o.i]) return;
    const p1 = bc(a.i), p2 = tc(o.i);
    wire(`off-${o.i}`, `M${p1.x},${p1.y} C${p1.x},${p1.y + 26} ${p2.x},${p2.y - 26} ${p2.x},${p2.y}`, "var(--brand)", true, "mg-arrow-brand");
    const rt = idOf(o.s.returnTo);
    if (rt >= 0 && pos[rt]) { const q1 = rc(o.i), q2 = bc(rt); wire(`ret-${o.i}`, `M${q1.x},${q1.y} C${q1.x + 44},${q1.y} ${q2.x},${q2.y + 54} ${q2.x},${q2.y}`, "var(--brand)", true, "mg-arrow-brand"); }
  });

  const arrow = (id: string, color: string) => (
    <marker id={id} key={id} markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L6.5,3 L0,6 Z" fill={color} /></marker>
  );

  return (
    <div style={{ overflowX: "auto", overflowY: "hidden", padding: "2px 0" }}>
      <div style={{ position: "relative", width, height, minWidth: width }}>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <defs>{[arrow("mg-arrow", "var(--ink-dim)"), arrow("mg-arrow-ok", "var(--success)"), arrow("mg-arrow-warn", "var(--warning)"), arrow("mg-arrow-brand", "var(--brand)")]}</defs>
          {wires}
        </svg>
        {idx.map(({ s, i }) => {
          if (!pos[i]) return null;
          const st = nodeStatus(i);
          const viewed = viewIdx === i;
          const n = countFor ? countFor(s.id) : 0;
          const border = s.offPath ? "var(--brand)" : st === "done" ? "var(--success)" : st === "current" ? "var(--brand)" : "var(--rule)";
          return (
            <div key={s.id} onClick={() => onNode?.(i)} title={`${s.name}${s.offPath ? " · off-path / on-demand" : ""}${(countFor && n > 1) ? ` · ran ${n}×` : ""}`}
              style={{ position: "absolute", left: pos[i].x, top: pos[i].y, width: NODE_W, height: NODE_H, boxSizing: "border-box",
                border: `1.5px ${s.offPath ? "dashed" : "solid"} ${border}`, borderRadius: 11, background: st === "current" ? "var(--brand-tint)" : "var(--surface)",
                padding: "8px 11px", cursor: onNode ? "pointer" : "default", display: "flex", flexDirection: "column", justifyContent: "center", gap: 3,
                outline: viewed ? "2px solid var(--brand)" : "none", outlineOffset: 2, boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 600, fontSize: 12.5, fontFamily: "var(--font-display)" }}>
                {st === "done" && <span style={{ color: "var(--success)" }}>✓</span>}
                {st === "current" && <span className="spin" />}
                {s.offPath && <span style={{ fontSize: 11 }}>🔬</span>}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                {n > 1 && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--warning)", fontWeight: 700 }}>×{n}</span>}
              </div>
              <div className="muted" style={{ fontSize: 10, display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                {s.tools ? <span>{s.tools.length} tools</span> : null}
                {s.gate && <span title="approval gate">⏸ gate</span>}
                {s.rejectTo && <span title={`rejects → ${nameOf(s.rejectTo)}`} style={{ color: "var(--warning)" }}>↩ {nameOf(s.rejectTo)}</span>}
                {s.offPath && s.returnTo && <span title={`rejoins → ${nameOf(s.returnTo)}`} style={{ color: "var(--brand)" }}>→ {nameOf(s.returnTo)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
