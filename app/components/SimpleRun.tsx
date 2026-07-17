"use client";
/**
 * SimpleRun — the "Live" view of a run (the calm counterpart to the Studio builder).
 *
 * Think of it as a better, higher-level view of the agent at work: a streaming, plain-language
 * feed (not raw logs) you can scroll up and down, with a timeline rail and sticky phase headers
 * so you can see when it shifts phase, the images/mocks it produces shown inline, and the
 * feedback ask right at the live edge. Run tabs up top switch between your active/in-review runs.
 * A Conductor chat is pinned at the bottom at all times, and expands to a full conversation.
 *
 * Same data as the Studio run page — no builder machinery. Design direction: "Ledger".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { InlineMD, Markdown } from "./ui";
import DeliverableFiles from "./DeliverableFiles";
import RawActivityLog from "./RawActivityLog";

type Art = { id: string; state: string; name: string; kind: string; body: string; created_at?: number };
type Deliverable = { id: string; filename: string; size: number; mime: string; label: string | null; description: string | null; is_final?: number; loop?: number; created_at?: number };
type Ev = { id: string; state: string; type: string; content: string; created_at: number };
type CMsg = { id: string; role: "you" | "conductor" | "system"; body: string; directive?: string | null; status?: string; image?: string | null; created_at: number };
type StateDef = { id: string; name: string; offPath?: boolean };
type Machine = { name: string; states: StateDef[] };
type Todo = { task: string; status: "done" | "active" | "pending" };
type Progress = { current: string; todos: Todo[] } | null;
type RunLite = { id: string; title: string; status: string; state_index: number; updated_at?: number };

function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function ago(tsIn: number): string {
  const ts = tsIn < 1e12 ? tsIn * 1000 : tsIn; // tolerate seconds or ms
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function parse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function cap(s: string, n: number): string { s = String(s || "").trim(); return s.length > n ? s.slice(0, n).trimEnd() + "…" : s; }
// Infra/system noise that must never render as a feed/chat message: whole-line bracketed system
// logs (e.g. "[Starting a fresh session from the on-disk state]") and model-call/ollama connection
// errors. Kept conservative: only clear system noise, never genuine agent/Conductor content.
function isInfraNoise(s: string): boolean {
  const t = String(s || "").trim();
  if (!t) return false;
  if (/^\[[^\]]*\]$/.test(t)) return true;
  return /could not connect to ollama|ollama serve|the model call produced no answer/i.test(t);
}

// A feed row's category → glyph + colors (mirrors the Activity Log's marker language).
const CAT: Record<string, { g: string; fg: string; bg: string; bd: string }> = {
  made:  { g: "✎", fg: "var(--ink-soft)", bg: "var(--surface-3, #f3ecdd)", bd: "var(--rule)" },
  tool:  { g: "↳", fg: "var(--ink-dim)",  bg: "var(--surface-2)", bd: "var(--rule-soft)" },
  ready: { g: "●", fg: "#7a4fb0", bg: "#f1ebf9", bd: "#e0d3f0" },
  pass:  { g: "✓", fg: "var(--success)", bg: "var(--success-tint)", bd: "var(--success-tint)" },
  warn:  { g: "↻", fg: "var(--warning)", bg: "var(--warning-tint)", bd: "var(--warning-tint)" },
  cond:  { g: "◆", fg: "var(--cond, #5848a0)", bg: "var(--cond-tint, #efe8fb)", bd: "var(--cond-rule, #d8ccf2)" },
  err:   { g: "✕", fg: "var(--danger)", bg: "var(--danger-tint)", bd: "var(--danger-tint)" },
  sys:   { g: "•", fg: "var(--ink-dim)", bg: "var(--surface-2)", bd: "var(--rule-soft)" },
};

type Row = { cat: keyof typeof CAT; tag: string; text: string; ts: number; receipt?: boolean };
type Group = { state: string; name: string; rows: Row[] };

/** Turn the raw event stream into phase-grouped, high-level narration rows. */
function buildFeed(events: Ev[], machine: Machine, curId?: string): Group[] {
  const nameOf = (sid: string) => machine.states.find(s => s.id === sid)?.name || sid;
  const idx = (sid: string) => { const i = machine.states.findIndex(s => s.id === sid); return i < 0 ? 999 : i; };
  const byState = new Map<string, Ev[]>();
  const order: string[] = [];
  for (const e of events) {
    if (!byState.has(e.state)) { byState.set(e.state, []); order.push(e.state); }
    byState.get(e.state)!.push(e);
  }
  // Order phases by machine position, but keep the CURRENTLY-active phase at the live edge
  // (the bottom, where the feed auto-scrolls). Otherwise a cross-phase "system" group
  // (reflect/learned events, which sort last) sits below the running phase and hides its
  // live notes — so the Live feed looks empty even though the Conductor activity shows them.
  order.sort((a, b) => {
    if (a === curId) return 1;
    if (b === curId) return -1;
    return (idx(a) - idx(b)) || 0;
  });

  const groups: Group[] = [];
  for (const state of order) {
    const evs = byState.get(state)!;
    const rows: Row[] = [];
    for (const e of evs) {
      const c = parse(e.content); const ts = e.created_at;
      switch (e.type) {
        // High-level MILESTONES only — the same signal as the Conductor activity log.
        // Tool calls, shell/Bash, tool results, progress and screenshots are dropped.
        case "text": {
          if (c.channel === "log") break; // system log line, not the model's words
          const t = String(c.text || "").replace(/\s+/g, " ").trim();
          if (isInfraNoise(t)) break; // drop bracketed system logs / connection noise
          if (t.length > 24) rows.push({ cat: "made", tag: "note", text: t.slice(0, 260), ts });
          break;
        }
        case "artifact": rows.push({ cat: "made", tag: "made", text: `Produced “${c.name}”.`, ts }); break;
        case "approval_request": rows.push({ cat: "ready", tag: "ready", text: cap(c.summary || "Finished this step — ready for your review.", 420), ts }); break;
        case "approved": rows.push({ cat: "pass", tag: "approved", text: cap(c.message || "You approved this.", 240), ts, receipt: true }); break;
        case "reject": rows.push({ cat: "warn", tag: "sent back", text: cap(c.reasons || c.summary || "Sent back for changes.", 420), ts }); break;
        case "feedback": rows.push({ cat: "warn", tag: "changes", text: cap(c.message || "Changes requested.", 420), ts }); break;
        case "reflect": { // only the substantive "learned N principle(s)" — not the
          // "Reflect & Record — learning…/no durable lesson" status markers (pure noise).
          const m = String(c.message || ""); if (!/new principle/i.test(m)) break;
          rows.push({ cat: "cond", tag: "learned", text: cap(m, 400), ts }); break;
        }
        case "deliverable": rows.push({ cat: "pass", tag: "file", text: `Returned ${c.filename || "a file"}.`, ts }); break;
        case "done": rows.push({ cat: "pass", tag: "done", text: cap(c.summary || c.message || "All done.", 420), ts }); break;
        case "error": { const msg = String(c.message || "Something went wrong."); if (isInfraNoise(msg)) break; rows.push({ cat: "err", tag: "error", text: cap(msg, 300), ts }); break; }
      }
    }
    if (rows.length) groups.push({ state, name: nameOf(state), rows });
  }
  return groups;
}

export default function SimpleRun({
  run, progress, artifacts, deliverables = [], events = [], conductor = [], machine,
  awaiting, busy, synthing = false, runId, onApprove, onChanges, onTalk,
}: {
  run: any; progress: Progress; artifacts: Art[]; deliverables?: Deliverable[]; events?: Ev[]; conductor?: CMsg[];
  machine: Machine; awaiting: boolean; busy: boolean; synthing?: boolean; runId: string; loopName?: string;
  onApprove: (note?: string) => void; onChanges: (msg: string) => void; onTalk: (text: string) => void; onChanged?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [chat, setChat] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [rawOpen, setRawOpen] = useState(false); // peek at the raw agent log (same as Studio's Activity panel)
  const [catchup, setCatchup] = useState("");
  const [catchupLoading, setCatchupLoading] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [catchOpen, setCatchOpen] = useState(true);   // "since you last checked in" collapsible (open by default)
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [closed, setClosed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem("atelier-live-closed") || "[]")); } catch { return new Set(); }
  });
  const persistClosed = (s: Set<string>) => { try { localStorage.setItem("atelier-live-closed", JSON.stringify([...s])); } catch {} };
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const didInitScroll = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const status: string = run.status;
  const goal = String(run.goal || run.title || "").split("\n").find((l: string) => l.trim()) || "Your project";
  // The page's biggest type: prefer the run TITLE; fall back to the first goal line only when the
  // title is empty. The full goal already lives in the North Star panel below, so don't repeat it.
  const heading = String(run.title || "").trim() || goal;
  const fileUrl = (a: Art) => `/api/runs/${runId}/file?p=${encodeURIComponent(a.body)}`;
  const curId = machine?.states?.[run.state_index]?.id;
  const currentName = machine?.states?.[run.state_index]?.name || "";

  // Run tabs: your active / in-review runs, switchable like terminal tabs.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const d = await (await fetch("/api/runs", { cache: "no-store" })).json();
        if (alive && Array.isArray(d.runs)) setRuns(d.runs);
      } catch {}
    };
    pull(); const t = setInterval(pull, 3000); return () => { alive = false; clearInterval(t); };
  }, []);
  // opening a run un-dismisses its tab
  useEffect(() => {
    setClosed(prev => { if (!prev.has(runId)) return prev; const n = new Set(prev); n.delete(runId); persistClosed(n); return n; });
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Since you last checked in": on opening the Live view, ask the Conductor to summarise
  // what changed since your last visit — the same catch-up it gives in the pop-up. Cheap when
  // nothing's new (the API short-circuits without an LLM call). Fires once per run you open.
  useEffect(() => {
    let alive = true;
    const KEY = `atelier:live-seen:${runId}`;
    let seen = 0; try { seen = Number(localStorage.getItem(KEY) || 0); } catch {}
    setCatchupLoading(true); setCatchup(""); setNewCount(0);
    (async () => {
      try {
        const r = await fetch(`/api/runs/${runId}/conductor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "catchUp", sinceTs: seen }) });
        const d = await r.json().catch(() => ({}));
        if (alive) { const n = Number(d.newCount || 0); setNewCount(n); setCatchup(n > 0 ? String(d.summary || "") : ""); setCatchOpen(n > 0); }
      } catch { /* ignore */ } finally { if (alive) setCatchupLoading(false); }
    })();
    try { localStorage.setItem(KEY, String(Date.now())); } catch {}
    return () => { alive = false; };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ACTIVE = new Set(["running", "awaiting_approval", "paused", "queued"]);
  const tabs = (() => {
    let list = runs.filter(r => ACTIVE.has(r.status) || r.id === runId);
    if (!list.some(r => r.id === runId)) list.unshift({ id: runId, title: run.title || goal, status, state_index: run.state_index });
    list = list.filter(r => r.id === runId || !closed.has(r.id));
    const rank: Record<string, number> = { awaiting_approval: 0, running: 1, queued: 2, paused: 3 };
    return list.sort((a, b) => {
      if (a.id === runId) return -1;   // the run you're viewing is always the first tab
      if (b.id === runId) return 1;
      return (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || ((b.updated_at || 0) - (a.updated_at || 0));
    }).slice(0, 14);
  })();
  function closeTab(id: string) {
    const n = new Set(closed); n.add(id); setClosed(n); persistClosed(n);
    if (id === runId) { const nxt = tabs.find(t => t.id !== id); window.location.href = nxt ? `/runs/${nxt.id}` : "/"; }
  }
  const tabDot = (s: string) => s === "awaiting_approval" ? "var(--cond, #5848a0)" : s === "running" ? "var(--brand)" : s === "done" ? "var(--success)" : s === "failed" ? "var(--danger)" : "var(--ink-dim)";

  const feed = useMemo(() => buildFeed(events, machine || { name: "", states: [] }, curId), [events, machine, curId]);

  // keep the feed pinned to the live edge unless the reader scrolls up
  // Feed position. A live/streaming run pins to the newest line (the live edge). But a paused/done
  // run opened cold used to slam to the absolute bottom, landing MID-message so the top of the view
  // was an orphaned, clipped fragment. Instead, on first load of a non-streaming run, land on the
  // newest PHASE HEADER so the feed reads cleanly from a boundary (deliverables are just below).
  useEffect(() => {
    const el = feedRef.current; if (!el) return;
    const streaming = status === "running" || awaiting;
    if (!didInitScroll.current) {
      if (!feed.length) return;               // wait for the feed to actually render
      didInitScroll.current = true;
      // Jump instantly (the feed uses smooth scrolling, which would otherwise animate a huge jump).
      const prev = el.style.scrollBehavior; el.style.scrollBehavior = "auto";
      if (streaming) { stick.current = true; el.scrollTop = el.scrollHeight; }
      else {
        const heads = el.querySelectorAll<HTMLElement>(".lv-phase-h");
        const last = heads[heads.length - 1];
        if (last) { el.scrollTop = Math.max(0, el.scrollTop + last.getBoundingClientRect().top - el.getBoundingClientRect().top - 8); stick.current = false; }
        else el.scrollTop = el.scrollHeight;
      }
      requestAnimationFrame(() => { const e = feedRef.current; if (e) e.style.scrollBehavior = prev; });
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [feed, awaiting, status]);
  useEffect(() => { if (expanded) chatEndRef.current?.scrollIntoView({ block: "end" }); }, [expanded, conductor.length, synthing]);
  const onFeedScroll = () => { const el = feedRef.current; if (!el) return; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  const jumpLatest = () => { const el = feedRef.current; if (el) { stick.current = true; el.scrollTop = el.scrollHeight; } };

  // artifacts shown inline under their phase
  const artsFor = (state: string) => artifacts.filter(a => a.state === state);
  const htmlOpts = artifacts.filter(a => a.state === curId && a.kind === "html");
  const isPick = awaiting && htmlOpts.length > 1;
  const chosen = pick || htmlOpts[0]?.id || null;

  const chipText = status === "running" ? "Working on it" : status === "awaiting_approval" ? "Needs you"
    : status === "done" ? "All done" : status === "failed" ? "Stopped" : status === "paused" ? "Paused" : status;
  const chipCol = status === "awaiting_approval" ? "#7a4fb0" : status === "running" ? "var(--brand)"
    : status === "done" ? "var(--success)" : status === "failed" ? "var(--danger)" : status === "paused" ? "#b5791f" : "var(--ink-dim)";

  function renderArt(a: Art) {
    const selectable = isPick && a.kind === "html";
    const sel = selectable && a.id === chosen;
    return (
      <div key={a.id} className={`lv-art${selectable ? " sel-able" : ""}${sel ? " sel" : ""}`}
        onClick={selectable ? () => setPick(a.id) : undefined}>
        <div className="lv-art-frame">
          {a.kind === "video" ? <video src={fileUrl(a)} muted loop playsInline autoPlay />
            : a.kind === "image" ? <img src={fileUrl(a)} alt={a.name} />
            : a.kind === "html" ? <iframe srcDoc={a.body} sandbox="allow-scripts allow-same-origin" title={a.name} scrolling="no" />
            : <div className="lv-art-doc">{a.kind === "markdown" ? "📄" : a.kind === "json" ? "{ }" : "📄"}</div>}
          {selectable && <span className="lv-art-check">{sel ? "✓" : ""}</span>}
        </div>
        <div className="lv-art-cap">{a.name}</div>
      </div>
    );
  }

  // Sending from the slim bar must OPEN the conversation — otherwise the message
  // clears the input and lands in a closed panel, so you never see it or the reply.
  function sendChat() { const t = chat.trim(); if (!t || busy) return; onTalk(t); setChat(""); setExpanded(true); }

  return (
    <div className="lv-wrap">
      {/* A · run tabs */}
      <div className="lv-tabs" role="tablist" aria-label="Runs">
        {tabs.map(t => (
          <a key={t.id} href={`/runs/${t.id}`} className={`lv-tab${t.id === runId ? " on" : ""}`} role="tab" aria-selected={t.id === runId}>
            <span className="lv-tab-dot" style={{ background: tabDot(t.status) }} />
            <span className="lv-tab-name">{t.title || "Untitled run"}</span>
            <button className="lv-tab-x" type="button" aria-label="Close tab" title="Close tab"
              onClick={e => { e.preventDefault(); e.stopPropagation(); closeTab(t.id); }}>✕</button>
          </a>
        ))}
        <a href="/" className="lv-tab add" aria-label="New run" title="Start a new run">＋</a>
      </div>

      {/* B · run header */}
      <div className="lv-head">
        <div className="lv-head-top">
          <h1 className="lv-goal">{heading}</h1>
          {/* Tap the status to peek at the raw agent log — the exact feed Studio's Activity panel
              shows — so you can confirm it's actually working. The chip is always present, so it's
              the reliable way in from any state. */}
          <button type="button" className="lv-chip" onClick={() => setRawOpen(true)}
            title="Tap for raw activity — the exact agent log (same as the Studio Activity panel)"
            style={{ color: chipCol, background: status === "awaiting_approval" ? "#f1ebf9" : status === "paused" ? "#faf1dc" : "var(--surface-2)", borderColor: status === "paused" ? "#e6d2a3" : "var(--rule-soft)" }}>
            {status === "paused"
              ? <span className="lv-chip-pause" aria-hidden />
              : (status === "running" || status === "awaiting_approval") && <span className="lv-chip-dot" style={{ background: chipCol }} />}
            {chipText}
          </button>
        </div>
        {status === "running" && (progress?.current || currentName) && (
          <button type="button" className="lv-now" onClick={() => setRawOpen(true)}
            title="Tap for raw activity — the exact agent log">
            <span className="lv-now-dot" />
            <span className="lv-now-text">Working on <b>{currentName || "it"}</b>{progress?.current ? <> — {progress.current}</> : null}</span>
          </button>
        )}
        {/* "Since you last checked in" — ALWAYS present and collapsible, so it never just vanishes
            once opening the run marks things seen. Opens with a summary when there is new activity;
            sits as a quiet collapsed bar ("You're all caught up") when there is nothing new. */}
        <div className={`lv-catchup${catchOpen ? " open" : ""}`}>
          <button type="button" className="lv-catchup-h" onClick={() => setCatchOpen(v => !v)} aria-expanded={catchOpen}>
            <span>◆ {newCount > 0 ? `Since you last checked in · ${newCount.toLocaleString()} new` : "You're all caught up"}</span>
            <span className="lv-catchup-chev">{catchOpen ? "▾" : "▸"}</span>
          </button>
          {catchOpen && (
            <>
              <div className="lv-catchup-p">{catchupLoading ? "Catching up on what happened while you were away…" : (catchup || "Nothing new since your last visit.")}</div>
              {!catchupLoading && newCount > 0 && (
                <button type="button" className="lv-catchup-f" onClick={() => setExpanded(true)}>{newCount.toLocaleString()} new event{newCount === 1 ? "" : "s"} · tap to open the Conductor</button>
              )}
            </>
          )}
        </div>
      </div>

      {/* C · the feed */}
      <div className="lv-feed" ref={feedRef} onScroll={onFeedScroll}>
        {feed.length === 0 && (
          <div className="lv-empty">{status === "running" ? "Getting started…" : "No activity yet."}</div>
        )}
        {feed.map((g, gi) => {
          const isNow = g.state === curId;
          const arts = artsFor(g.state);
          return (
            <section key={g.state + gi} className={`lv-phase${isNow ? " now" : ""}`}>
              <header className="lv-phase-h">
                <span className="lv-node" />{g.name}
                <span className="lv-phase-meta">{isNow ? (status === "awaiting_approval" ? "now · needs you" : status === "running" ? "now" : "now") : "done"}</span>
              </header>
              {g.rows.map((r, ri) => {
                const m = CAT[r.cat];
                return (
                  <div key={ri} className={`lv-row${r.receipt ? " receipt" : ""}`}>
                    <span className="lv-badge" style={{ color: m.fg, background: m.bg, borderColor: m.bd }}>{m.g}</span>
                    <div className="lv-row-body">
                      <div className="lv-row-top"><span className="lv-tag">{r.tag}</span><span className="lv-when">{ago(r.ts)}</span></div>
                      <div className="lv-text"><InlineMD>{r.text}</InlineMD></div>
                    </div>
                  </div>
                );
              })}
              {arts.length > 0 && <div className="lv-arts">{arts.map(renderArt)}</div>}
            </section>
          );
        })}

        {/* live edge: the feedback ask */}
        {awaiting && (
          <div className="lv-ask">
            <div className="lv-ask-title">{isPick ? "Pick one to build — or ask for a change." : "Finished this step. Keep going, or ask for a change?"}</div>
            {!asking ? (
              <div className="lv-ask-btns">
                {isPick
                  ? <button className="lv-btn primary" disabled={busy || !chosen} onClick={() => onApprove(`Build the mock option the human chose: "${htmlOpts.find(a => a.id === chosen)?.name}".`)}>Build “{htmlOpts.find(a => a.id === chosen)?.name}”</button>
                  : <button className="lv-btn primary" disabled={busy} onClick={() => onApprove()}>Looks good — keep going ✓</button>}
                <button className="lv-btn ghost" disabled={busy} onClick={() => setAsking(true)}>Ask for a change</button>
              </div>
            ) : (
              <div className="lv-ask-box">
                <textarea className="lv-ask-input" autoFocus value={note} placeholder="What would you like changed?" onChange={e => setNote(e.target.value)} />
                <div className="lv-ask-btns">
                  <button className="lv-btn ghost" onClick={() => { setAsking(false); setNote(""); }}>Cancel</button>
                  <button className="lv-btn primary" disabled={busy || !note.trim()} onClick={() => { onChanges(note.trim()); setAsking(false); setNote(""); }}>Send</button>
                </div>
              </div>
            )}
          </div>
        )}

        {status === "running" && <div className="lv-live"><span className="lv-live-dot" />live · updating as it works</div>}
        {status === "done" && <div className="lv-done">✓ Done{deliverables.length ? " — your files are below" : "."}</div>}
        {status === "failed" && run.last_error && <div className="lv-err-banner">Stopped: {cap(run.last_error, 200)}</div>}

        {deliverables.length > 0 && <DeliverableFiles deliverables={deliverables} runId={runId} />}
      </div>

      {!stick.current && <button className="lv-jump" onClick={jumpLatest}>↓ Jump to latest</button>}

      {/* D · slim Conductor bar — one line; tap ⤢ (or type + send) to open the full chat.
         Hidden while the full chat is open so there is only ONE composer (no doubled input). */}
      {!expanded && (
      <div className="lv-cond">
        {synthing && <button type="button" className="lv-cond-think" onClick={() => setExpanded(true)}><i className="lv-cb">◆</i> <span className="lv-dots">Conductor is thinking</span></button>}
        <div className="lv-cond-input">
          <span className="lv-cond-prompt">◆</span>
          <input value={chat} onChange={e => setChat(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendChat(); } }} placeholder="Message the Conductor…" />
          {chat.trim()
            ? <button className="lv-cond-send" aria-label="Send" disabled={busy} onClick={sendChat}>↑</button>
            : <button className="lv-cond-open" aria-label="Open Conductor chat" title="Open the full Conductor chat" onClick={() => setExpanded(true)}>⤢</button>}
        </div>
      </div>
      )}

      {/* raw activity — the exact per-phase agent log Studio shows, in a modal you can dip into
         to verify progress, then dismiss. Reuses the chat-modal chrome for a consistent look. */}
      {rawOpen && (
        <div className="lv-chatx">
          <div className="lv-chatx-scrim" onClick={() => setRawOpen(false)} />
          <div className="lv-chatx-panel">
            <div className="lv-chatx-head">
              <span className="lv-chatx-title">⚙ Raw activity</span>
              <span className="lv-chatx-sub">{currentName ? `${currentName} · ` : ""}the exact agent log</span>
              <button className="lv-chatx-close" onClick={() => setRawOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="lv-chatx-body">
              <RawActivityLog events={events} machine={machine} runId={runId} stateId={curId} />
            </div>
          </div>
        </div>
      )}

      {/* expanded Conductor chat */}
      {expanded && (
        <div className="lv-chatx">
          <div className="lv-chatx-scrim" onClick={() => setExpanded(false)} />
          <div className="lv-chatx-panel">
            <div className="lv-chatx-head">
              <span className="lv-chatx-title"><i className="lv-cb">◆</i> Conductor{synthing && <span className="lv-chatx-think"> · <span className="lv-dots">thinking</span></span>}</span>
              <span className="lv-chatx-sub">{goal}{curId ? ` · ${machine?.states?.[run.state_index]?.name || ""}` : ""}</span>
              <button className="lv-chatx-close" onClick={() => setExpanded(false)} aria-label="Close">✕</button>
            </div>
            <div className="lv-chatx-body">
              {conductor.length === 0 && !synthing && <div className="lv-empty">No messages yet — say hello to the Conductor.</div>}
              {conductor.map(m => (
                <div key={m.id} className={`lv-msg ${m.role}`}>{m.role !== "you" && <i className="lv-cb">◆</i>}<span>{m.role === "you" ? m.body : <Markdown>{m.body}</Markdown>}</span></div>
              ))}
              {synthing && <div className="lv-msg conductor"><i className="lv-cb">◆</i><span className="lv-thinking"><span className="lv-dots">looking things over</span></span></div>}
              <div ref={chatEndRef} />
            </div>
            <div className="lv-chatx-foot">
              <div className="lv-cond-input">
                <span className="lv-cond-prompt">◆</span>
                <input value={chat} onChange={e => setChat(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendChat(); } }} placeholder="Message the Conductor…" autoFocus />
                <button className="lv-cond-send" aria-label="Send" disabled={busy || !chat.trim()} onClick={sendChat}>↑</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
