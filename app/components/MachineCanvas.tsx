"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PHASE_MODEL_OPTS } from "../lib/engine/models";

export interface CanvasState { id: string; name: string; prompt?: string; tools?: string[]; gate?: boolean; rejectTo?: string; offPath?: boolean; returnTo?: string; maxTurns?: number; model?: string; x?: number; y?: number }

// A phase can pin its own model (e.g. a multimodal model to inspect a video). Blank = run's
// model. Options come from the single source of truth (app/lib/engine/models.ts).
const CANVAS_MODEL_OPTS = PHASE_MODEL_OPTS;
export interface ToolInfo { name: string; label: string; description: string }

const NODE_W = 184, NODE_H = 72;

/** Editable ComfyUI-style canvas for a machine: drag nodes to reposition (left→right order
 *  = pipeline order), draw wires from a node's ports to set reject→ / returnTo, click a node
 *  to edit it in the inspector. Edits the same `states` the cards / YAML use. */
export default function MachineCanvas({ states, tools, onChange }: { states: CanvasState[]; tools: ToolInfo[]; onChange: (next: CanvasState[]) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stRef = useRef(states); stRef.current = states;
  const [selId, setSelId] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: string; kind: "reject" | "return"; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [panning, setPanning] = useState(false);

  // auto-layout for any node missing a position (main in a row, off-path below their anchor)
  const autoPos = useMemo(() => {
    const main = states.map((s, i) => ({ s, i })).filter(x => !x.s.offPath);
    const offs = states.map((s, i) => ({ s, i })).filter(x => x.s.offPath);
    const pos: Record<string, { x: number; y: number }> = {};
    main.forEach((m, k) => { pos[m.s.id] = { x: 36 + k * (NODE_W + 56), y: 80 }; });
    const used: Record<string, number> = {};
    offs.forEach(o => {
      const rt = states.findIndex(s => s.id === o.s.returnTo);
      let a = main[0]; for (const m of main) if (m.i < (rt < 0 ? states.length : rt)) a = m;
      const ax = a ? pos[a.s.id].x : 36; const key = a?.s.id ?? "_"; const n = used[key] || 0;
      pos[o.s.id] = { x: ax + n * (NODE_W + 28), y: 80 + NODE_H + 88 }; used[key] = n + 1;
    });
    return pos;
  }, [states]);

  const nameOf = (id?: string) => states.find(s => s.id === id)?.name || "";
  const X = (s: CanvasState) => s.x ?? autoPos[s.id]?.x ?? 36, Y = (s: CanvasState) => s.y ?? autoPos[s.id]?.y ?? 80;

  // commit auto-layout positions once (in an effect — never setState during render)
  useEffect(() => {
    if (states.some(s => typeof s.x !== "number")) onChange(states.map(s => ({ ...s, x: X(s), y: Y(s) })));
  }, [states]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = (id?: string) => states.find(s => s.id === id);
  const rc = (s: CanvasState) => ({ x: X(s) + NODE_W, y: Y(s) + NODE_H / 2 });
  const lc = (s: CanvasState) => ({ x: X(s), y: Y(s) + NODE_H / 2 });
  const bl = (s: CanvasState) => ({ x: X(s) + NODE_W * 0.32, y: Y(s) + NODE_H });
  const br = (s: CanvasState) => ({ x: X(s) + NODE_W * 0.68, y: Y(s) + NODE_H });

  const mainByX = states.filter(s => !s.offPath).slice().sort((a, b) => X(a) - X(b));
  const maxX = Math.max(360, ...states.map(s => X(s) + NODE_W)) + 80;
  const maxY = Math.max(360, ...states.map(s => Y(s) + NODE_H)) + 80;

  // reorder the array so pipeline order = left→right (main by x), off-path appended; keep on drop
  const reorderByX = (arr: CanvasState[]) => {
    const main = arr.filter(s => !s.offPath).slice().sort((a, b) => X(a) - X(b));
    const off = arr.filter(s => s.offPath).slice().sort((a, b) => X(a) - X(b));
    return [...main, ...off];
  };

  function startDrag(e: React.MouseEvent, id: string) {
    e.stopPropagation(); setSelId(id);
    const s0 = stRef.current.find(s => s.id === id); if (!s0) return;
    const sx = e.clientX, sy = e.clientY, ox = X(s0), oy = Y(s0); let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true; setDragging(true);
      onChange(stRef.current.map(s => s.id === id ? { ...s, x: Math.max(0, ox + (ev.clientX - sx)), y: Math.max(0, oy + (ev.clientY - sy)) } : s));
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (moved) onChange(reorderByX(stRef.current));
      setDragging(false);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  function startWire(e: React.MouseEvent, id: string, kind: "reject" | "return") {
    e.stopPropagation();
    const rect = wrapRef.current?.getBoundingClientRect(); if (!rect) return;
    const pt = (ev: MouseEvent | React.MouseEvent) => ({ x: ev.clientX - rect.left + (wrapRef.current?.scrollLeft || 0), y: ev.clientY - rect.top + (wrapRef.current?.scrollTop || 0) });
    setWire({ from: id, kind, ...pt(e) });
    const move = (ev: MouseEvent) => setWire(w => w ? { ...w, ...pt(ev) } : w);
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      const p = pt(ev);
      const tgt = stRef.current.find(s => s.id !== id && p.x >= X(s) && p.x <= X(s) + NODE_W && p.y >= Y(s) && p.y <= Y(s) + NODE_H);
      if (tgt) onChange(stRef.current.map(s => s.id === id ? { ...s, [kind === "reject" ? "rejectTo" : "returnTo"]: tgt.id } : s));
      setWire(null);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  const upd = (id: string, patch: Partial<CanvasState>) => onChange(stRef.current.map(s => s.id === id ? { ...s, ...patch } : s));
  const toggleTool = (id: string, t: string) => { const s = node(id); if (!s) return; const has = (s.tools || []).includes(t); upd(id, { tools: has ? (s.tools || []).filter(x => x !== t) : [...(s.tools || []), t] }); };
  const addNode = () => {
    const nid = `state-${states.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
    onChange([...states, { id: nid, name: `State ${states.length + 1}`, prompt: "Do the work for this state, display_artifact your result, then request_approval.", tools: ["read_file", "write_file", "display_artifact"], x: 36 + (mainByX.length) * (NODE_W + 56), y: 80 }]);
    setSelId(nid);
  };
  const removeNode = (id: string) => { onChange(states.filter(s => s.id !== id)); if (selId === id) setSelId(null); };

  const wires: React.ReactNode[] = [];
  const linkChips: React.ReactNode[] = [];
  const arrow = (id: string, c: string) => <marker id={id} key={id} markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L6.5,3 L0,6 Z" fill={c} /></marker>;
  const wirePath = (k: string, a: { x: number; y: number }, b: { x: number; y: number }, color: string, dash: boolean, mk: string, bow = 0) => {
    const mx = (a.x + b.x) / 2;
    const d = bow ? `M${a.x},${a.y} C${a.x},${a.y + bow} ${b.x},${b.y + bow} ${b.x},${b.y}` : `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
    wires.push(<path key={k} d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={dash ? "5 4" : undefined} markerEnd={`url(#${mk})`} opacity={0.9} />);
  };
  // a removable, labeled chip sitting ON an editable link, so you can SEE what it is and delete it
  const linkChip = (key: string, srcId: string, kind: "reject" | "return", targetName: string, a: { x: number; y: number }, b: { x: number; y: number }, bow: number, color: string) => {
    linkChips.push(
      <div key={key} onMouseDown={e => e.stopPropagation()}
        title={kind === "reject" ? `On reject/fail, this phase loops back to "${targetName}". Click ✕ to remove the link, or re-drag the port to point elsewhere.` : `When this off-path phase finishes, it rejoins at "${targetName}". Click ✕ to remove.`}
        style={{ position: "absolute", left: (a.x + b.x) / 2, top: Math.max(a.y, b.y) + bow * 0.55, transform: "translate(-50%,-50%)", zIndex: 6, display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 3px 1px 7px", borderRadius: 999, background: "var(--surface)", border: `1px solid ${color}`, fontSize: 10, fontWeight: 600, color, whiteSpace: "nowrap", boxShadow: "0 1px 4px rgba(0,0,0,.1)" }}>
        <span>{kind === "reject" ? "↩ reject" : "↳ rejoin"} → {targetName}</span>
        <button onClick={() => upd(srcId, kind === "reject" ? { rejectTo: undefined } : { returnTo: undefined })} title="Remove this link"
          style={{ border: "none", background: "none", cursor: "pointer", color, fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
      </div>,
    );
  };
  // forward flow (solid) — implicit from left→right order; reorder by dragging nodes, not editable as a wire
  for (let k = 1; k < mainByX.length; k++) wirePath(`seq-${k}`, rc(mainByX[k - 1]), lc(mainByX[k]), "var(--ink-dim)", false, "cv-arrow");
  // editable links: reject (amber, back-on-fail) and off-path return (brand). Each gets a removable chip.
  states.forEach(s => { const t = node(s.rejectTo); if (t) { const bow = 46 + Math.abs(X(s) - X(t)) * 0.05; const a = bl(s), b = { x: X(t) + NODE_W / 2, y: Y(t) + NODE_H }; wirePath(`rej-${s.id}`, a, b, "var(--warning)", true, "cv-warn", bow); linkChip(`rejc-${s.id}`, s.id, "reject", t.name, a, b, bow, "var(--warning)"); } });
  states.forEach(s => { const t = node(s.returnTo); if (t) { const bow = 54; const a = br(s), b = { x: X(t) + NODE_W / 2, y: Y(t) + NODE_H }; wirePath(`ret-${s.id}`, a, b, "var(--brand)", true, "cv-brand", bow); linkChip(`retc-${s.id}`, s.id, "return", t.name, a, b, bow, "var(--brand)"); } });
  if (wire) { const s = node(wire.from); if (s) wires.push(<path key="pending" d={`M${(wire.kind === "reject" ? bl(s) : br(s)).x},${(wire.kind === "reject" ? bl(s) : br(s)).y} L${wire.x},${wire.y}`} fill="none" stroke={wire.kind === "reject" ? "var(--warning)" : "var(--brand)"} strokeWidth={2} strokeDasharray="5 4" />); }

  // Pan by dragging empty canvas (nodes/ports stopPropagation, so this only fires on the
  // background). Lets you scroll around a graph wider/taller than the viewport to reach + edit any node.
  function startPan(e: React.MouseEvent) {
    const wrap = wrapRef.current; if (!wrap) return;
    setSelId(null); setPanning(true);
    const sx = e.clientX, sy = e.clientY, sl = wrap.scrollLeft, st = wrap.scrollTop;
    const move = (ev: MouseEvent) => { if (!wrapRef.current) return; wrapRef.current.scrollLeft = sl - (ev.clientX - sx); wrapRef.current.scrollTop = st - (ev.clientY - sy); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); setPanning(false); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  const sel = selId ? node(selId) : null;

  return (
    <div className="flex flex-col gap-3.5 items-stretch sm:flex-row">
      {/* ——— canvas ——— */}
      <div ref={wrapRef} onMouseDown={startPan} className="max-sm:w-full sm:flex-1 sm:min-w-0"
        style={{ position: "relative", height: 560, overflow: "auto", border: "1px solid var(--rule)", borderRadius: 12,
          background: "var(--surface-2) radial-gradient(var(--rule) 1px, transparent 1px)", backgroundSize: "20px 20px", cursor: panning || dragging ? "grabbing" : "grab" }}>
        <div style={{ position: "relative", width: maxX, height: maxY }}>
          <svg width={maxX} height={maxY} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <defs>{[arrow("cv-arrow", "var(--ink-dim)"), arrow("cv-warn", "var(--warning)"), arrow("cv-brand", "var(--brand)")]}</defs>
            {wires}
          </svg>
          {states.map(s => {
            const selected = s.id === selId;
            return (
              <div key={s.id} onClick={e => { e.stopPropagation(); setSelId(s.id); }} onMouseDown={e => startDrag(e, s.id)}
                style={{ position: "absolute", left: X(s), top: Y(s), width: NODE_W, height: NODE_H, boxSizing: "border-box",
                  border: `1.5px ${s.offPath ? "dashed" : "solid"} ${selected ? "var(--brand)" : s.offPath ? "var(--brand)" : "var(--rule)"}`,
                  borderRadius: 11, background: "var(--surface)", padding: "8px 11px", cursor: "grab", userSelect: "none",
                  boxShadow: selected ? "0 0 0 2px var(--brand-tint), 0 4px 14px rgba(0,0,0,.10)" : "0 1px 4px rgba(0,0,0,.06)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 600, fontSize: 12.5, fontFamily: "var(--font-display)" }}>
                  {s.offPath && <span style={{ fontSize: 11 }}>🔬</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                </div>
                <div className="muted" style={{ fontSize: 10, display: "flex", gap: 7, marginTop: 3, flexWrap: "wrap" }}>
                  <span>{(s.tools || []).length} tools</span>
                  {s.gate && <span>⏸ gate</span>}
                  {s.rejectTo && <span style={{ color: "var(--warning)" }}>↩ {nameOf(s.rejectTo)}</span>}
                  {s.offPath && s.returnTo && <span style={{ color: "var(--brand)" }}>→ {nameOf(s.returnTo)}</span>}
                  {s.model && <span style={{ color: "var(--brand)", fontWeight: 600 }}>◈ {s.model.split(":")[1] || s.model}</span>}
                </div>
                {/* output ports — drag to another node to wire */}
                <span onMouseDown={e => startWire(e, s.id, "reject")} title="Drag to a node to set reject → (loop-back)"
                  style={{ position: "absolute", left: NODE_W * 0.32 - 6, bottom: -7, width: 13, height: 13, borderRadius: 999, background: "var(--warning)", border: "2px solid var(--surface)", cursor: "crosshair" }} />
                {s.offPath && <span onMouseDown={e => startWire(e, s.id, "return")} title="Drag to a node to set returnTo (rejoin)"
                  style={{ position: "absolute", left: NODE_W * 0.68 - 6, bottom: -7, width: 13, height: 13, borderRadius: 999, background: "var(--brand)", border: "2px solid var(--surface)", cursor: "crosshair" }} />}
              </div>
            );
          })}
          {linkChips}
        </div>
        <button className="btn" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); addNode(); }} style={{ position: "absolute", top: 10, left: 10, fontSize: 12, zIndex: 5 }}>+ Add state</button>
        <div className="muted" style={{ position: "absolute", bottom: 8, left: 12, fontSize: 10.5, pointerEvents: "none" }}>Solid arrows = forward flow (left→right order; drag a node to reorder). Drag a port (●) onto a node to add a reject/return link · click ✕ on a link to remove it · click a node to edit · drag the background to pan</div>
      </div>

      {/* ——— inspector ——— */}
      {sel ? (
        <div className="card card-pad max-sm:w-full sm:w-[350px] sm:flex-none" style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 540, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input className="input" style={{ fontWeight: 600, fontFamily: "var(--font-display)" }} value={sel.name} onChange={e => upd(sel.id, { name: e.target.value })} />
            <button className="btn" title="Delete this state" style={{ padding: "6px 10px", color: "var(--danger)" }} onClick={() => removeNode(sel.id)}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => upd(sel.id, { gate: !sel.gate })} style={{ padding: "5px 10px", fontSize: 11.5, background: sel.gate ? "var(--brand-tint)" : "var(--surface)", borderColor: sel.gate ? "var(--brand)" : "var(--rule)", color: sel.gate ? "var(--brand)" : "var(--ink-dim)" }}>{sel.gate ? "⏸ Approval gate" : "⏩ Auto-progress"}</button>
            <button className="btn" onClick={() => upd(sel.id, { offPath: !sel.offPath, returnTo: !sel.offPath && !sel.returnTo ? states.find(s => s.id !== sel.id)?.id : sel.returnTo })} style={{ padding: "5px 10px", fontSize: 11.5, background: sel.offPath ? "var(--brand-tint)" : "var(--surface)", borderColor: sel.offPath ? "var(--brand)" : "var(--rule)", color: sel.offPath ? "var(--brand)" : "var(--ink-dim)" }}>{sel.offPath ? "🔬 Off-path leaf" : "▢ On main path"}</button>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="muted" style={{ fontSize: 11.5 }}>reject →</label>
            <select className="input" style={{ flex: 1, minWidth: 120 }} value={sel.rejectTo || ""} onChange={e => upd(sel.id, { rejectTo: e.target.value || undefined })}>
              <option value="">(none)</option>
              {states.filter(s => s.id !== sel.id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="muted" style={{ fontSize: 11.5 }} title="Run this phase with a specific model (e.g. a multimodal model to inspect a video/image). Blank = the run's model.">model</label>
            <select className="input" style={{ flex: 1, minWidth: 120 }} value={sel.model || ""} onChange={e => upd(sel.id, { model: e.target.value || undefined })}>
              {CANVAS_MODEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {sel.offPath && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label className="muted" style={{ fontSize: 11.5 }}>rejoins →</label>
              <select className="input" style={{ flex: 1, minWidth: 120 }} value={sel.returnTo || ""} onChange={e => upd(sel.id, { returnTo: e.target.value || undefined })}>
                <option value="">(end)</option>
                {states.filter(s => s.id !== sel.id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label">Prompt</label>
            <textarea className="input" style={{ marginTop: 5, minHeight: 150, fontFamily: "var(--font-mono)", fontSize: 12 }} value={sel.prompt || ""} onChange={e => upd(sel.id, { prompt: e.target.value })} />
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Tools</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {tools.map(t => { const on = (sel.tools || []).includes(t.name); return (
                <button key={t.name} onClick={() => toggleTool(sel.id, t.name)} title={t.description} className="chip"
                  style={{ cursor: "pointer", fontSize: 11, background: on ? "var(--brand-tint)" : "var(--surface-2)", borderColor: on ? "var(--brand)" : "var(--rule)", color: on ? "var(--brand)" : "var(--ink-dim)", fontWeight: on ? 600 : 400 }}>
                  {on ? "✓ " : "+ "}{t.label}
                </button>
              ); })}
            </div>
          </div>
        </div>
      ) : (
        <div className="card card-pad muted max-sm:w-full sm:w-[350px] sm:flex-none" style={{ fontSize: 12.5, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "20px" }}>
          Click a node to edit its prompt, tools, gate, and routing.
        </div>
      )}
    </div>
  );
}
