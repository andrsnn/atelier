"use client";
/**
 * RawActivityLog — the raw agent output for a run, phase-grouped, newest-first.
 *
 * This is the SAME "Activity" panel the Studio run page shows (raw agent output ·
 * this phase). It's an observability layer over the run's event stream — no
 * stage-specific logic. Extracted so the Studio builder and the calm Live view
 * render identical raw activity from one place instead of drifting copies.
 */
import { type ReactNode } from "react";

type Ev = { id: string; state: string; type: string; content: string; created_at: number };
type Machine = { states: { id: string; name: string }[] };

export const ICON: Record<string, string> = { html: "🖼", image: "📷", video: "🎬", markdown: "📄", json: "{ }", text: "📄", file: "📦" };

export function humanBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

// A human-readable, plain-language line for a tool call (used by the live banner + history).
export function toolLine(name: string, args: any): string {
  const base = (p?: string) => (p ? String(p).split("/").pop() : "") || "";
  if (name === "Read") return `📖 Reading ${base(args?.file_path)}`;
  if (name === "Grep") return `🔎 Searching ${args?.pattern ? `"${String(args.pattern).slice(0, 36)}"` : "the code"}`;
  if (name === "Glob") return `📁 Finding ${args?.pattern || "files"}`;
  if (name === "Bash") return `💻 ${String(args?.command || "").replace(/\s+/g, " ").slice(0, 64)}`;
  if (name === "Edit" || name === "Write") return `✏️ Editing ${base(args?.file_path)}`;
  if (name === "display_artifact" || name === "display") return `📄 Showing ${args?.name || "a deliverable"}`;
  if (name === "return_file") return `⬇ Returning file ${base(args?.path) || args?.filename || ""}`;
  if (name === "screenshot_page" || name === "screenshot") return `📸 Taking a screenshot`;
  if (name === "record_walkthrough" || name === "record") return `🎥 Recording a walkthrough`;
  if (name === "start_dev_server" || name === "dev_server") return `🚀 Booting the dev server`;
  if (name === "authenticate") return `🔑 Logging in`;
  return `🔧 ${name}`;
}

export function fmtTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function argSummary(args: any): string {
  if (!args || typeof args !== "object") return "";
  const first = args.path || args.command || args.pattern || args.name || args[Object.keys(args)[0]];
  let s = typeof first === "string" ? first : JSON.stringify(first);
  if (s && s.length > 80) s = s.slice(0, 80) + "…";
  return s || "";
}

export type ItemKind =
  | { t: "say"; text: string; state: string }
  | { t: "tool_call"; name: string; args: any; state: string }
  | { t: "tool_result"; name: string; result: string; state: string }
  | { t: "artifact"; name: string; kind: string; state: string }
  | { t: "deliverable"; id: string; filename: string; size: number; mime: string; state: string }
  | { t: "screenshot"; name: string; path: string; state: string }
  | { t: "enter"; name: string; state: string }
  | { t: "approved" | "feedback" | "done" | "error" | "reject" | "reflect"; message: string; state: string };
export type Item = ItemKind & { ts: number };

export function groupEvents(events: Ev[]): Item[] {
  const out: Item[] = []; let buf = ""; let bufState = ""; let bufTs = 0;
  const flush = () => { if (buf.trim()) out.push({ t: "say", text: buf.trim(), state: bufState, ts: bufTs }); buf = ""; };
  for (const e of events) {
    let c: any = {}; try { c = JSON.parse(e.content); } catch {}
    const ts = e.created_at;
    if (e.type === "progress") continue; // narrator summaries drive the live banner, not the log
    if (e.type === "text") { if (bufState && bufState !== e.state) flush(); if (!buf) bufTs = ts; bufState = e.state; buf += c.text || ""; continue; }
    flush();
    if (e.type === "state_enter") out.push({ t: "enter", name: c.name || e.state, state: e.state, ts });
    else if (e.type === "tool_call") out.push({ t: "tool_call", name: c.name, args: c.args, state: e.state, ts });
    else if (e.type === "tool_result") out.push({ t: "tool_result", name: c.name, result: c.result || "", state: e.state, ts });
    else if (e.type === "artifact") out.push({ t: "artifact", name: c.name, kind: c.kind, state: e.state, ts });
    else if (e.type === "deliverable") out.push({ t: "deliverable", id: c.id, filename: c.filename, size: c.size, mime: c.mime, state: e.state, ts });
    else if (e.type === "screenshot") out.push({ t: "screenshot", name: c.name, path: c.path, state: e.state, ts });
    else if (e.type === "approved") out.push({ t: "approved", message: c.message || "Approved", state: e.state, ts });
    else if (e.type === "reject") out.push({ t: "reject", message: (c.reasons || c.summary || "Sent back") + (c.to ? ` → ${c.to}` : ""), state: e.state, ts });
    else if (e.type === "feedback") out.push({ t: "feedback", message: c.message || "", state: e.state, ts });
    else if (e.type === "reflect") out.push({ t: "reflect", message: c.message || "", state: e.state, ts });
    else if (e.type === "done") out.push({ t: "done", message: c.message || c.summary || "Done", state: e.state, ts });
    else if (e.type === "error") out.push({ t: "error", message: c.message || "Error", state: e.state, ts });
  }
  flush();
  return out;
}

export function TimelineItem({ it, machine, runId }: { it: Item; machine: Machine; runId: string }): ReactNode {
  const stateName = machine.states.find(s => s.id === it.state)?.name || it.state;
  if (it.t === "screenshot")
    return <a href={`/api/runs/${runId}/file?p=${encodeURIComponent(it.path)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <img src={`/api/runs/${runId}/file?p=${encodeURIComponent(it.path)}`} alt={it.name} style={{ height: 56, borderRadius: 6, border: "1px solid var(--rule)" }} />
      <span className="muted" style={{ fontSize: 12 }}>📷 {it.name} <span style={{ opacity: .6 }}>(self-check)</span></span>
    </a>;
  if (it.t === "enter")
    return <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 2px", color: "var(--brand)", fontFamily: "var(--font-display)", fontWeight: 600 }}>
      <span style={{ flex: "0 0 auto" }}>▶ {it.name}</span><span style={{ flex: 1, height: 1, background: "var(--rule)" }} /></div>;
  if (it.t === "say")
    return <div className="soft" style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, borderLeft: "2px solid var(--rule)", paddingLeft: 10 }}>{it.text}</div>;
  if (it.t === "tool_call")
    return <div className="mono" style={{ fontSize: 12.5 }}><span style={{ color: "var(--brand)" }}>🔧 {it.name}</span> <span className="muted">{argSummary(it.args)}</span></div>;
  if (it.t === "tool_result")
    return <details style={{ fontSize: 12 }}><summary className="muted mono" style={{ cursor: "pointer" }}>↳ {it.name} result</summary><pre className="mono" style={{ margin: "4px 0 0", padding: 8, fontSize: 11.5, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", background: "var(--surface-2)", borderRadius: 6 }}>{it.result}</pre></details>;
  if (it.t === "artifact")
    return <div style={{ color: "var(--success)" }}>{ICON[it.kind] || "📄"} Displayed <b>{it.name}</b> <span className="muted">({it.kind})</span></div>;
  if (it.t === "deliverable")
    return <div style={{ color: "var(--success)" }}>⬇ Returned file <a href={`/api/runs/${runId}/deliverables/${it.id}`} download={it.filename} className="mono" style={{ fontWeight: 600 }}>{it.filename}</a> <span className="muted">({humanBytes(it.size)} · {it.mime}) — added to Downloads</span></div>;
  if (it.t === "reject") return <div style={{ color: "var(--danger)", fontWeight: 600 }}>↩ {stateName} sent it back: {it.message}</div>;
  if (it.t === "approved") return <div style={{ color: "var(--success)" }}>✓ {stateName}: {it.message}</div>;
  if (it.t === "feedback") return <div style={{ color: "var(--warning)" }}>↻ Changes requested: {it.message}</div>;
  if (it.t === "done") return <div style={{ color: "var(--success)" }}>● {it.message}</div>;
  if (it.t === "reflect") return <div style={{ color: "var(--brand)", whiteSpace: "pre-wrap" }}>{it.message}</div>;
  if (it.t === "error") return <div style={{ color: "var(--danger)" }}>✕ {it.message}</div>;
  return null;
}

/** The raw activity list — the exact Studio "Activity" panel body. Filters to one
 *  phase when `stateId` is given (matching Studio's "raw agent output · this phase"),
 *  newest-first so the latest action sits at the top. */
export default function RawActivityLog({
  events, machine, runId, stateId, max = 600,
}: {
  events: Ev[]; machine: Machine; runId: string; stateId?: string; max?: number;
}) {
  const all = groupEvents(events);
  const items = (stateId ? all.filter(it => it.state === stateId) : all).slice(-max).reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
      {items.length === 0 && <span className="muted">Waiting for the agent…</span>}
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span className="mono muted" title={new Date(it.ts).toLocaleString()} style={{ flex: "0 0 auto", minWidth: 66, textAlign: "right", fontSize: 10.5, opacity: 0.55, paddingTop: 2, userSelect: "none" }}>{fmtTime(it.ts)}</span>
          <div style={{ flex: 1, minWidth: 0 }}><TimelineItem it={it} machine={machine} runId={runId} /></div>
        </div>
      ))}
    </div>
  );
}
