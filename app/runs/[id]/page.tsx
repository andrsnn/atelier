"use client";
import { Fragment, use, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { Markdown, StatusChip, timeAgo, autopilotOf, type Autopilot } from "../../components/ui";
import MachineGraph from "../../components/MachineGraph";
import { getMyName, setMyName as persistMyName, colorFor, initials } from "../../lib/identity";
import { useSimpleMode } from "../../components/SimpleMode";
import SimpleRun from "../../components/SimpleRun";
import NorthStar from "../../components/NorthStar";
import DeliverableFiles from "../../components/DeliverableFiles";
import { PRIMARY_MODELS, VISION_MODELS } from "../../lib/engine/models";
import ConductorInspector from "../../components/ConductorInspector";
import { groupEvents, TimelineItem, fmtTime, toolLine, ICON, type Item } from "../../components/RawActivityLog";

// Avatar chip for a comment author / present teammate.
function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <span title={name} style={{ flex: "0 0 auto", width: size, height: size, borderRadius: 999, background: colorFor(name), color: "#fff", fontSize: size * 0.46, fontWeight: 700, display: "grid", placeItems: "center", lineHeight: 1 }}>
      {initials(name)}
    </span>
  );
}

// "Who's on this run right now" — overlapping avatars of present teammates.
function PresenceBar({ presence, myName }: { presence: { name: string; lastSeen: number }[]; myName: string }) {
  if (!presence.length) return null;
  const others = presence.filter(p => p.name !== myName).length;
  const label = others === 0 ? "just you" : presence.length === others ? `${others} here` : `you + ${others}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }} title={presence.map(p => p.name).join(", ") + " — here now"}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--success, #16a34a)", flex: "0 0 auto" }} />
      <div style={{ display: "flex" }}>
        {presence.slice(0, 5).map((p, i) => (
          <span key={p.name} style={{ marginLeft: i ? -6 : 0, borderRadius: 999, boxShadow: "0 0 0 2px var(--surface)", display: "inline-flex" }}>
            <Avatar name={p.name} size={21} />
          </span>
        ))}
      </div>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
    </div>
  );
}

// Render a comment body with @mentions highlighted.
function MentionBody({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z][\w-]*)/g);
  return <span style={{ whiteSpace: "pre-wrap" }}>{parts.map((p, i) =>
    /^@[A-Za-z][\w-]*$/.test(p)
      ? <span key={i} style={{ color: "var(--brand)", fontWeight: 600 }}>{p}</span>
      : <Fragment key={i}>{p}</Fragment>
  )}</span>;
}

interface StateDef { id: string; name: string; offPath?: boolean; returnTo?: string; tools?: string[]; gate?: boolean; rejectTo?: string; caseInput?: { label: string; placeholder?: string }; output?: { file: string; label?: string }; watchable?: { label: string; icon?: string; note?: string } }
interface MachineMode { id: string; label: string; icon?: string; hint?: string; default?: boolean }
interface Machine { id: string; name: string; states: StateDef[]; settings?: { modes?: MachineMode[] } }
interface Run { id: string; title: string; goal: string; status: string; state_index: number; approval_summary: string | null; last_error: string | null; machine_id: string; workspace: string; repo_path: string | null; base_branch: string | null; branch_name: string | null; pr_url: string | null; primary_model: string | null; vision_model: string | null; agent_state: string | null; loop_count: number; gate_mode: "all" | "machine" | "none"; disabled_states: string | null; conductor_mode: "propose" | "auto" | null; conductor_model: string | null; conductor_react: "auto" | "manual" | null; conductor_revert: string | null; mode: string | null; criteria: string | null; learnings: string | null; created_at: number; updated_at: number }
// Model rosters come from the single source of truth (app/lib/engine/models.ts),
// so the run-page dropdowns never drift from the create page or the machine editor.
const PRIMARY_OPTS = PRIMARY_MODELS;
const VISION_OPTS = VISION_MODELS;
interface Ev { id: string; state: string; type: string; content: string; created_at: number }
interface Art { id: string; state: string; name: string; kind: string; body: string; created_at: number }
interface Deliverable { id: string; state: string; filename: string; size: number; mime: string; label: string | null; description: string | null; is_final: number; loop: number; created_at: number }
interface Cmt { id: string; state: string; artifact_id: string | null; artifact_name: string | null; anchor: string; body: string; image: string | null; author: string | null; parent_id: string | null; status: "open" | "sent"; created_at: number }
interface Present { name: string; lastSeen: number }
interface CMsg { id: string; role: "you" | "conductor" | "system"; body: string; directive: string | null; status: "" | "proposed" | "applied" | "dismissed"; image: string | null; created_at: number }

const anchorOf = (c: Cmt) => { try { return JSON.parse(c.anchor); } catch { return { type: "note" }; } };
const fmtClock = (s: number) => { const m = Math.floor(s / 60), sec = Math.floor(s % 60); return `${m}:${String(sec).padStart(2, "0")}`; };

// ——— Deliverable scannability: derive a verdict + a category from an artifact name ———
const verdictOf = (name: string): "pass" | "fail" | null =>
  /\bfail(ed|s|ing)?\b/i.test(name) ? "fail" : /\bpass(ed|es|ing)?\b/i.test(name) ? "pass" : null;
const catOf = (name: string): string =>
  /^\s*case\s+\d+/i.test(name) ? "Cases"
    : /\bsmoke\b/i.test(name) ? "Smoke tests"
    : /\b(reports?|plans?|summary|review|acceptance|scenarios?|notes?)\b/i.test(name) ? "Reports & plans"
    : "Other";
const CAT_ORDER = ["Reports & plans", "Cases", "Smoke tests", "Other"];
const verdictRank = (n: string) => { const v = verdictOf(n); return v === "fail" ? 0 : v === "pass" ? 2 : 1; }; // fails first, neutral, then passes
const VERDICT_STYLE: Record<string, { fg: string; bd: string; bg: string; glyph: string }> = {
  fail: { fg: "var(--danger)", bd: "var(--danger)", bg: "var(--danger-tint)", glyph: "✗" },
  pass: { fg: "var(--success)", bd: "var(--success-soft)", bg: "var(--success-tint)", glyph: "✓" },
  none: { fg: "var(--ink-soft)", bd: "var(--rule)", bg: "var(--surface-2)", glyph: "" },
};

// The Claude Code session id is stored on the run as agent_state; primary_model decides
// HOW to resume it in a terminal — `claude --resume` for claude-native (opus/sonnet),
// or `ollama launch claude --model <tag> -- --resume` for an Ollama-driven session.
function resumeInfo(run: Run): { sessionId: string | null; provider: string; cmd: string | null } {
  const sid = run.agent_state;
  const pm = run.primary_model || "claude:default";
  const ci = pm.indexOf(":");
  const provider = ci >= 0 ? pm.slice(0, ci) : "claude";
  const model = ci >= 0 ? pm.slice(ci + 1) : pm;
  if (!sid) return { sessionId: null, provider, cmd: null };
  const cd = `cd ${JSON.stringify(run.workspace)} && `;
  if (provider === "ollama") {
    const tag = model.includes(":cloud") ? model : `${model}:cloud`;
    return { sessionId: sid, provider, cmd: `${cd}ollama launch claude --model ${tag} -- --resume ${sid}` };
  }
  const modelFlag = model && model !== "default" ? ` --model ${model}` : "";
  return { sessionId: sid, provider, cmd: `${cd}claude --resume ${sid}${modelFlag}` };
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { simple } = useSimpleMode();
  const [run, setRun] = useState<Run | null>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [artifacts, setArtifacts] = useState<Art[]>([]);
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [comments, setComments] = useState<Cmt[]>([]);
  const [conductor, setConductor] = useState<CMsg[]>([]);
  const [openArt, setOpenArt] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showEarlier, setShowEarlier] = useState(false); // expand a phase's earlier (non-latest) loop iterations
  const [showLoops, setShowLoops] = useState(false);      // expand the small loop-count badge into a per-phase breakdown
  const [focusTs, setFocusTs] = useState<number | null>(null); // jump History to a specific iteration's start
  const [rerunModal, setRerunModal] = useState<{ stateId: string; idx: number; name: string } | null>(null); // "send back to a phase with notes" modal
  const [rerunNote, setRerunNote] = useState("");
  const [caseText, setCaseText] = useState("");            // ad-hoc case/scenario for the phase you're viewing (if it declares caseInput)
  const [routeOpen, setRouteOpen] = useState(false);       // "route directly to any phase" override modal
  const [routeTarget, setRouteTarget] = useState("");
  const [routeNote, setRouteNote] = useState("");
  const routeAtt = useImageAttach();
  const [editingModels, setEditingModels] = useState(false);
  const [mPrimary, setMPrimary] = useState(""); const [mVision, setMVision] = useState(""); const [mGov, setMGov] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [viewPhase, setViewPhase] = useState<number | null>(null);
  const [graphView, setGraphView] = useState(false);      // toggle the phase rail into a node-graph diagram
  const [moreOpen, setMoreOpen] = useState(false);        // header overflow menu — tucks secondary controls (approvals, view, mode, name)
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const bootRef = useRef<string | null>(null);  // server build id seen on first poll; reload if it changes
  // Fixed, viewport-CLAMPED position for the Options menu so it never runs off the left edge on
  // mobile (the trigger can sit mid-row on a phone; a right-anchored menu would overflow left).
  const [morePos, setMorePos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  function openMore() {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) {
      const W = Math.min(280, window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8);
      const top = r.bottom + 6;
      setMorePos({ top, left, width: W, maxH: Math.max(160, window.innerHeight - top - 12) });
    }
    setMoreOpen(true);
  }
  const [tab, setTab] = useState<"activity" | "history">("activity");
  // The per-phase raw agent output is a detail — collapsed by default so it doesn't clutter
  // the page (or a screen recording). Expand it when you actually want to inspect the log.
  const [activityOpen, setActivityOpen] = useState(false);
  // The live progress banner: by default shows just the current task; click to expand the todos.
  const [progressOpen, setProgressOpen] = useState(false);
  const [driving, setDriving] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  const [testInfo, setTestInfo] = useState<{ localUrl?: string; lanUrl?: string; creds?: { email: string; password: string } | null } | null>(null);
  const [showCreds, setShowCreds] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [synthing, setSynthing] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false); // the Conductor chat + activity view — opened from the panel's "Chat & activity" button
  const autoSynthRef = useRef(false);
  // Collaboration: who I am (display name) + who else is on this run right now.
  const [myName, setMyName] = useState("");
  const [presence, setPresence] = useState<Present[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  useEffect(() => { const n = getMyName(); setMyName(n); if (!n) setEditingName(true); }, []);
  function saveName() { const n = persistMyName(nameDraft); setMyName(n); setEditingName(false); }

  async function load() {
    const r = await fetch(`/api/runs/${id}`, { cache: "no-store", headers: { "x-atelier-user": getMyName() } });
    if (!r.ok) return;
    const d = await r.json();
    // Self-heal a stale/suspended tab: if the server was rebuilt (its version changed since we
    // booted), hard-reload so we run the new build instead of showing old cached JS + data.
    if (d.serverVersion) {
      if (bootRef.current && bootRef.current !== d.serverVersion) { window.location.reload(); return; }
      bootRef.current = d.serverVersion;
    }
    setRun(d.run); setMachine(d.machine); setEvents(d.events); setArtifacts(d.artifacts);
    setDeliverables(Array.isArray(d.deliverables) ? d.deliverables : []);
    setComments(d.comments || []); setConductor(d.conductor || []);
    setSynthing(!!d.conductorWorking); // the Conductor's "thinking" state is server-driven, so background work shows
    setActivity(Array.isArray(d.conductorActivity) ? d.conductorActivity : []);
    setPresence(Array.isArray(d.presence) ? d.presence : []);
    setOpenArt(prev => (prev && d.artifacts.some((a: Art) => a.id === prev) ? prev : null));
  }
  useEffect(() => { load(); const t = setInterval(load, 1500); return () => clearInterval(t); }, [id]); // eslint-disable-line
  // A phone tab that was backgrounded suspends its timers; when it comes back (foreground or a
  // bfcache restore) poll immediately so it re-syncs (and reloads if the build changed) instead of
  // showing a frozen stale page.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) load(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onShow);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pageshow", onShow); };
  }, []); // eslint-disable-line
  // The log is newest-first, so "stick" means stay pinned to the TOP (where new items land).
  useEffect(() => { const el = logRef.current; if (el && stick.current) el.scrollTop = 0; }, [events]);
  // "Conductor proposes on its own": when open comments aren't yet covered by a
  // proposal/decision, auto-synthesize after a short settle (Propose waits for
  // your approval; Auto routes itself). Keyed on stable strings so the 1.5s poll
  // doesn't keep resetting the debounce.
  // Signature of the OPEN comments by id + text. When it differs from what the
  // Conductor last weighed in on (stored on its latest directive), re-synthesize
  // after a short settle: a burst of comments collapses into ONE pass, and editing
  // a comment triggers a fresh one. Deleting one re-evaluates with the rest.
  const openSig = comments.filter(c => c.status === "open").map(c => `${c.id}:${c.body}`).sort().join("");
  const lastDirSig = (() => { for (let i = conductor.length - 1; i >= 0; i--) { const dir = conductor[i].directive; if (dir) { try { return JSON.parse(dir).commentSig || ""; } catch {} } } return ""; })();
  useEffect(() => {
    if (!openSig || autoSynthRef.current || openSig === lastDirSig) return;
    if ((run?.conductor_react || "auto") === "manual") return; // manual: batch comments until "Review comments"
    const t = setTimeout(async () => {
      autoSynthRef.current = true;
      try { await conductorDo("synthesize"); } finally { autoSynthRef.current = false; }
    }, 5000); // debounce: wait for a lull so several comments become ONE pass (saves Conductor calls)
    return () => clearTimeout(t);
  }, [openSig, lastDirSig, run?.conductor_react]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: string, message?: string) {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, message }) });
    setBusy(false); load();
  }
  async function setGateMode(gateMode: "all" | "machine" | "none") {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setGateMode", gateMode }) });
    setBusy(false); load();
  }
  // ONE "how hands-on?" control: a preset sets BOTH the phase-pause mode (gate) AND how the
  // Conductor handles comments (autopilot), so autonomy lives in one place, not three.
  async function setAutonomy(gate: "all" | "machine" | "none", autopilot: Autopilot) {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setGateMode", gateMode: gate }) });
    await fetch(`/api/runs/${id}/conductor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setAutopilot", autopilot }) });
    setBusy(false); load();
  }
  async function setMode(mode: string) {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setMode", mode }) });
    setBusy(false); load();
  }
  async function toggleStep(stateId: string, disabled: Set<string>) {
    const next = new Set(disabled); next.has(stateId) ? next.delete(stateId) : next.add(stateId);
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setDisabledSteps", steps: [...next] }) });
    setBusy(false); load();
  }
  // Send the phase you're viewing an extra ad-hoc case/scenario to handle this run — generic,
  // shown only when that phase declares `caseInput` (e.g. QA's smoke-test). Routes to that phase.
  async function runCase(stateId: string) {
    const s = caseText.trim(); if (!s || !stateId) return;
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "addCase", state: stateId, message: s }) });
    setCaseText(""); setBusy(false); load();
  }
  // Override the Conductor: route DIRECTLY to a chosen phase, carrying the open comments
  // (+ their images) plus any extra instructions/images the human adds in the modal.
  async function routeDirect() {
    const target = routeTarget || machine?.states[0]?.id;
    if (!target) return;
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "routeTo", state: target, message: routeNote, images: routeAtt.images }) });
    setRouteOpen(false); setRouteNote(""); routeAtt.reset(); setBusy(false); load();
  }
  async function revise(phase: number) {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revise", phase, message: "" }) });
    setBusy(false); load();
  }
  // Re-run a WATCHABLE terminal phase to re-check its still-moving external state (e.g. a PR:
  // rebase onto latest base, confirm CI). Generic — the phase's own watchable.note is the brief.
  async function recheck(phase: number) {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recheck", phase }) });
    setBusy(false); load();
  }
  // Mode-aware "go back to here": Auto re-runs forward; Machine/All rewinds & pauses so you can review first.
  async function goBack(phase: number) {
    const auto = (run?.gate_mode || "machine") === "none";
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: auto ? "revise" : "goto", phase, message: "" }) });
    setBusy(false); load();
  }
  // Send a phase back to re-run it. With a note (and/or pending comments on that phase),
  // it re-runs to ADDRESS them — revising the existing deliverable in place, like the
  // Conductor does, but you pick the phase. With nothing, it's a plain rewind.
  async function sendBackToPhase(stateId: string, idx: number, note: string) {
    setBusy(true);
    const trimmed = note.trim();
    if (trimmed) {
      await fetch(`/api/runs/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: stateId, anchor: { type: "note" }, body: trimmed }) });
    }
    const hasFeedback = !!trimmed || comments.some(c => c.state === stateId && c.status === "open");
    if (hasFeedback) {
      await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sendComments", state: stateId }) });
    } else {
      const auto = (run?.gate_mode || "machine") === "none";
      await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: auto ? "revise" : "goto", phase: idx, message: "" }) });
    }
    setBusy(false); load();
  }
  // jump the view to the artifact a Conductor-cited comment lives on
  function jumpToComment(c: Cmt) {
    const idx = machine?.states.findIndex(s => s.id === c.state) ?? -1;
    if (idx >= 0) { setViewPhase(idx); setOpenArt(c.artifact_id); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }
  async function addComment(art: Art, anchor: any, body: string, images?: string[]) {
    await fetch(`/api/runs/${id}/comments`, { method: "POST", headers: { "content-type": "application/json", "x-atelier-user": getMyName() },
      body: JSON.stringify({ state: art.state, artifactId: art.id, artifactName: art.name, anchor, body, images: images || [], author: getMyName() }) });
    load();
  }
  // Threaded reply: a comment that hangs off a parent (same artifact), so the team
  // can discuss a point rather than only leaving parallel notes.
  async function replyToComment(parent: Cmt, body: string) {
    await fetch(`/api/runs/${id}/comments`, { method: "POST", headers: { "content-type": "application/json", "x-atelier-user": getMyName() },
      body: JSON.stringify({ state: parent.state, artifactId: parent.artifact_id, artifactName: parent.artifact_name, anchor: { type: "reply" }, body, parentId: parent.id, author: getMyName() }) });
    load();
  }
  async function deleteComment(commentId: string) {
    await fetch(`/api/runs/${id}/comments?commentId=${commentId}`, { method: "DELETE" });
    load();
  }
  async function clearComments(scope: "all" | "handled") {
    if (scope === "all" && !confirm("Clear ALL comments on this loop?")) return;
    await fetch(`/api/runs/${id}/comments?scope=${scope}`, { method: "DELETE" });
    load();
  }
  async function editComment(commentId: string, body: string) {
    await fetch(`/api/runs/${id}/comments`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ commentId, body }) });
    load();
  }
  // ——— Conductor ———
  async function conductorDo(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await fetch(`/api/runs/${id}/conductor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const d = await r.json().catch(() => null);
    if (d?.conductor) setConductor(d.conductor);
    if (d?.run) setRun(d.run);
    if ("working" in (d || {})) setSynthing(!!d.working); // reflect the Conductor's state instantly (no poll lag)
    setBusy(false); load();
  }
  async function saveModels() {
    setBusy(true);
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setModels", primaryModel: mPrimary, visionModel: mVision, conductorModel: mGov }) });
    setEditingModels(false); setBusy(false); load();
  }
  async function saveTitle() {
    const t = titleDraft.trim();
    setEditingTitle(false);
    if (t && t !== run?.title) {
      await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rename", title: t }) });
      load();
    }
  }
  async function testDrive() {
    setDriving(true); setTestMsg("Booting the app & opening Chrome…"); setTestInfo(null);
    try {
      const r = await fetch(`/api/runs/${id}/test-drive`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setTestMsg(d.message || (r.ok ? "Opened." : "Could not open."));
      if (r.ok && (d.localUrl || d.lanUrl)) { setTestInfo({ localUrl: d.localUrl, lanUrl: d.lanUrl, creds: d.creds }); setShowCreds(false); }
    } catch { setTestMsg("Could not reach the server."); }
    setDriving(false); load();
  }
  async function stopTest() {
    setDriving(true);
    await fetch(`/api/runs/${id}/test-drive`, { method: "DELETE" }).catch(() => {});
    setTestInfo(null); setTestMsg("Stopped the test server."); setDriving(false); load();
  }

  if (!run || !machine) return <div className="muted">Loading…</div>;
  const lastRealIdx = (() => { for (let i = machine.states.length - 1; i >= 0; i--) if (!machine.states[i].offPath) return i; return Math.max(0, machine.states.length - 1); })();
  // A finished run can land its index on (or past) an OFF-PATH leaf it never entered
  // (e.g. Deep-dive). Show its last REAL phase instead — unless it's actively running the leaf.
  const effectiveIdx = run.status === "running"
    ? Math.min(run.state_index, machine.states.length - 1)
    : (machine.states[run.state_index] && !machine.states[run.state_index].offPath ? run.state_index : lastRealIdx);
  const currentName = machine.states[effectiveIdx]?.name || (run.status === "done" ? "done" : "—");
  const disabledSteps = (() => { try { return new Set<string>(JSON.parse(run.disabled_states || "[]")); } catch { return new Set<string>(); } })();
  const viewIdx = Math.min(viewPhase ?? effectiveIdx, machine.states.length - 1);
  const viewState = machine.states[viewIdx];
  const viewingCurrent = viewIdx === effectiveIdx;
  const isLast = viewIdx === machine.states.length - 1;
  const phaseArts = artifacts.filter(a => a.state === viewState?.id);
  const shownArt = phaseArts.find(a => a.id === openArt) || phaseArts[phaseArts.length - 1];
  // How many times each phase has run = its state_enter count (for the loop badges + bounce summary).
  const runCountFor = (sid: string) => events.reduce((n, e) => n + (e.type === "state_enter" && e.state === sid ? 1 : 0), 0);
  // Split the viewed phase's deliverables into loop iterations: the timestamps of each
  // state_enter are the run boundaries; an artifact belongs to the latest enter at/under it.
  const viewEnters = events.filter(e => e.type === "state_enter" && e.state === viewState?.id).map(e => e.created_at).sort((a, b) => a - b);
  const runOfArt = (a: Art) => { let k = 0; for (let j = 0; j < viewEnters.length; j++) if (a.created_at >= viewEnters[j]) k = j; return k; };
  const totalRuns = Math.max(viewEnters.length, 1);
  const openCount = comments.filter(c => c.status === "open").length;
  const handledCount = comments.filter(c => c.status === "sent").length;
  const phaseCommentCount = (sid: string) => comments.filter(c => c.state === sid && c.status === "open").length;
  const allItems = groupEvents(events);
  // Newest-first so the latest activity is at the TOP of the log — no scrolling to the bottom
  // to see what's going on. (HistoryView below still uses the chronological allItems.)
  const items = allItems.filter(it => it.state === viewState?.id).reverse();
  // What the agent is doing RIGHT NOW — the latest action in the current phase (for the live banner).
  const liveActivity = (() => {
    if (run.status !== "running") return null;
    const curId = machine.states[run.state_index]?.id;
    for (let i = allItems.length - 1; i >= 0; i--) {
      const it = allItems[i];
      if (curId && it.state !== curId) continue;
      if (it.t === "tool_call") return toolLine(it.name, it.args);
      if (it.t === "say" && it.text.trim()) return "💭 " + it.text.trim().replace(/\s+/g, " ").slice(0, 130);
    }
    return null;
  })();
  // The narrator's plain-language progress for the current phase — a "current task" + an
  // evolving todo checklist (Haiku summarizes the raw activity). Latest one wins.
  const progress = (() => {
    if (run.status !== "running") return null as null | { current: string; todos: { task: string; status: "done" | "active" | "pending" }[] };
    const curId = machine.states[run.state_index]?.id;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "progress" || (curId && e.state !== curId)) continue;
      try { const p = JSON.parse(e.content); return { current: String(p.current || ""), todos: (Array.isArray(p.todos) ? p.todos : []) as { task: string; status: "done" | "active" | "pending" }[] }; } catch { return null; }
    }
    return null;
  })();
  // "Pick & build" is the MOCK flow only: choose among multiple HTML mock OPTIONS to
  // build one. Key on the artifacts being mock options (html) — NOT the phase name — so
  // phases like QA (reports/videos/images) get a plain "Approve & continue" instead of a
  // nonsensical "Build …" button, and their deliverables render in the per-attempt view.
  const mockOptions = phaseArts.filter(a => a.kind === "html");
  const isPick = viewingCurrent && run.status === "awaiting_approval" && mockOptions.length > 1 && !!shownArt;
  // mocks selected to build — explicit selection, falling back to the one on screen
  const picks = isPick ? (picked.size > 0 ? mockOptions.filter(a => picked.has(a.id)) : (shownArt && shownArt.kind === "html" ? [shownArt] : [mockOptions[0]])) : [];
  const canTest = (isLast || run.status === "done") && !!run.repo_path;

  // Simple mode: same run, calm mobile-first view — no builder machinery.
  if (simple) return (
    <SimpleRun
      run={run}
      progress={progress}
      artifacts={artifacts}
      deliverables={deliverables}
      events={events}
      conductor={conductor}
      machine={machine}
      awaiting={viewingCurrent && run.status === "awaiting_approval"}
      busy={busy}
      synthing={synthing}
      runId={id}
      loopName={machine.name}
      onApprove={(note) => act("approve", note)}
      onChanges={(m) => act("changes", m)}
      onTalk={(t) => conductorDo("talk", { text: t })}
      onChanged={load}
    />
  );

  return (
    <div>
      {inspectorOpen && (
        <ConductorInspector
          runId={id}
          run={run}
          events={events}
          conductor={conductor}
          machine={machine}
          working={synthing}
          onClose={() => setInspectorOpen(false)}
          onChanged={load}
        />
      )}
      {editingName && (
        <div onClick={() => myName && setEditingName(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 60, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} className="card card-pad" style={{ width: "min(420px, calc(100vw - 48px))" }}>
            <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Your name on this board</h2>
            <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>Shown on your comments and to teammates viewing the same run. No account — just a display name, stored in this browser.</p>
            <input className="input" autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)} placeholder="e.g. Maya"
              onKeyDown={e => { if (e.key === "Enter" && nameDraft.trim()) saveName(); }} style={{ width: "100%" }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              {myName && <button className="btn" onClick={() => setEditingName(false)}>Cancel</button>}
              <button className="btn btn-primary" onClick={saveName} disabled={!nameDraft.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-[13px] gap-y-2 mb-3.5">
        <Link href="/" className="muted" style={{ fontSize: 18 }}>←</Link>
        {editingTitle ? (
          <input className="input max-sm:w-full max-sm:!min-w-0" autoFocus value={titleDraft} onChange={e => setTitleDraft(e.target.value)}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }} onBlur={saveTitle}
            style={{ fontSize: 22, fontWeight: 600, padding: "3px 9px", minWidth: 360, fontFamily: "var(--font-display)" }} />
        ) : (
          <h1 className="min-w-0" style={{ fontSize: 25, margin: 0, cursor: "text", overflowWrap: "anywhere" }} title="Click to rename"
            onClick={() => { setTitleDraft(run.title); setEditingTitle(true); }}>{run.title}</h1>
        )}
        <StatusChip status={run.status} />
        {/* loop-back badge — inline next to the status chip, with a per-phase breakdown popover */}
        {(() => {
          const looped = machine.states.filter(s => runCountFor(s.id) > 1);
          if (!looped.length) return null;
          const totalBounces = looped.reduce((n, s) => n + (runCountFor(s.id) - 1), 0);
          return (
            <div style={{ position: "relative" }}>
              <button className="chip" onClick={() => setShowLoops(v => !v)} title={`${totalBounces} loop-backs total across all phases. Click for the per-phase breakdown.`}
                style={{ cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: "var(--warning)", borderColor: "var(--warning)", background: "var(--warning-tint)" }}>
                ↻ {totalBounces} loops {showLoops ? "▾" : "▸"}
              </button>
              {showLoops && (
                <div className="card card-pad" style={{ position: "absolute", left: 0, top: "calc(100% + 6px)", zIndex: 20, minWidth: 210, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, boxShadow: "0 6px 24px rgba(0,0,0,.14)" }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>Loops by phase — click to view</div>
                  {looped.map(s => (
                    <button key={s.id} className="chip" onClick={() => { setViewPhase(machine.states.indexOf(s)); setOpenArt(null); setShowEarlier(true); setShowLoops(false); }}
                      style={{ cursor: "pointer", fontSize: 11.5, display: "flex", justifyContent: "space-between", width: "100%" }} title={`View ${s.name} deliverables (ran ${runCountFor(s.id)}×)`}>
                      <span>{s.name}</span> <b style={{ color: "var(--brand)" }}>×{runCountFor(s.id)}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {run.status === "failed" && <button className="btn max-sm:min-h-[44px]" onClick={() => act("start")} disabled={busy}>↻ Retry</button>}
        <div className="flex items-center gap-2 flex-wrap max-sm:w-full max-sm:mt-1 sm:ml-auto">
          <PresenceBar presence={presence} myName={myName} />
          {openCount > 0 && <span className="pill-conductor">💬 {openCount} open · Conductor</span>}
          {run.status === "running" && <button className="btn" onClick={() => act("pause")} disabled={busy}>⏸ Pause</button>}
          {run.status === "paused" && <button className="btn btn-run" onClick={() => act("resume")} disabled={busy}>▶ Resume</button>}
          {/* Secondary controls — approvals, run mode, view, identity — one click away instead of always on screen. */}
          <div className="max-sm:ml-auto" style={{ position: "relative" }}>
            <button ref={moreBtnRef} className="btn max-sm:min-h-[44px]" aria-haspopup="menu" aria-expanded={moreOpen} title="Run options — approvals, view, your name"
              onClick={() => (moreOpen ? setMoreOpen(false) : openMore())} style={{ padding: "6px 11px", fontSize: 12.5 }}>⋯ Options</button>
            {moreOpen && (<>
              <div onClick={() => setMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
              <div className="card card-pad" role="menu" style={{ position: "fixed", top: morePos?.top ?? 60, left: morePos?.left ?? 8, zIndex: 41, width: morePos?.width ?? 270, maxHeight: morePos?.maxH, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 28px rgba(0,0,0,.16)" }}>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Actions</div>
                  <button className="btn" title="Override the Conductor — route directly to any phase, sending your open comments + images straight to it."
                    onClick={() => { setRouteTarget((machine.states.find(s => /build/i.test(s.name)) || machine.states.find(s => !s.offPath) || machine.states[0])?.id || ""); setRouteOpen(true); setMoreOpen(false); }}
                    style={{ width: "100%", justifyContent: "flex-start", padding: "6px 10px", fontSize: 12.5 }}>↪ Route directly to a phase…</button>
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 2 }}>How hands-on?</div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 7, lineHeight: 1.35 }}>How often the run stops for you, and whether the Conductor acts on your comments on its own.</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {([
                      { icon: "⏸", label: "Pause at every step", sub: "You approve each phase; the Conductor asks before acting.", gate: "all", pilot: "propose" },
                      { icon: "◐", label: "Pause at key points", sub: "Stops only where the loop marks a checkpoint.", gate: "machine", pilot: "propose" },
                      { icon: "⏩", label: "Run on its own", sub: "No pauses; the Conductor routes itself.", gate: "none", pilot: "auto" },
                    ] as const).map(o => {
                      const on = (run.gate_mode || "machine") === o.gate;
                      return (
                        <button key={o.gate} onClick={() => setAutonomy(o.gate, o.pilot)} disabled={busy}
                          style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, textAlign: "left", padding: "7px 10px", border: `1px solid ${on ? "var(--brand)" : "var(--rule)"}`, borderRadius: 9, cursor: "pointer", background: on ? "var(--brand-tint)" : "var(--surface)" }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? "var(--brand)" : "var(--ink)" }}>{o.icon} {o.label}</span>
                          <span style={{ fontSize: 11, color: "var(--ink-dim)", lineHeight: 1.35 }}>{o.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(() => {
                  // Generic: render whatever run modes THIS machine declares (settings.modes).
                  // No machine modes ⇒ no selector. Plus an "off" entry that SKIPS the test
                  // phase (QA/smoke) entirely on this loop — saves tokens when you don't need it.
                  const modes = machine.settings?.modes || [];
                  if (!modes.length) return null;
                  const qaState = machine.states.find(s => /\bqa\b|smoke|test/i.test(s.name));
                  const qaOff = qaState ? disabledSteps.has(qaState.id) : false;
                  const OFF = "__skip__";
                  const current = run.mode || (modes.find(m => m.default) || modes[0]).id;
                  const cur = modes.find(m => m.id === current);
                  return (
                    <div>
                      <div className="label" style={{ marginBottom: 6 }}>Run mode</div>
                      <select value={qaOff ? OFF : current} disabled={busy}
                        onChange={async e => {
                          const v = e.target.value;
                          if (v === OFF) { if (qaState) await toggleStep(qaState.id, disabledSteps); }
                          else { if (qaState && disabledSteps.has(qaState.id)) await toggleStep(qaState.id, disabledSteps); await setMode(v); }
                        }}
                        title={qaOff ? `${qaState?.name} is OFF — skipped on this loop to save tokens` : (cur?.hint || "Run mode")}
                        style={{ width: "100%", border: `1px ${qaOff ? "dashed" : "solid"} ${qaOff ? "var(--warning)" : "var(--rule)"}`, borderRadius: 9, padding: "7px 10px", fontSize: 12.5, background: "var(--surface)", color: qaOff ? "var(--ink-dim)" : "var(--ink)", cursor: "pointer", fontWeight: 500 }}>
                        {modes.map(m => <option key={m.id} value={m.id} title={m.hint}>{m.icon ? m.icon + " " : ""}{m.label}</option>)}
                        {qaState && <option value={OFF}>🚫 {qaState.name} off — skip</option>}
                      </select>
                    </div>
                  );
                })()}
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>View</div>
                  <div style={{ display: "flex", border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden", fontSize: 12 }}>
                    <button onClick={() => setGraphView(false)} style={{ flex: 1, padding: "6px 10px", border: "none", cursor: "pointer", background: !graphView ? "var(--brand-tint)" : "var(--surface)", color: !graphView ? "var(--brand)" : "var(--ink-dim)", fontWeight: !graphView ? 600 : 400 }}>≡ Rail</button>
                    <button onClick={() => setGraphView(true)} style={{ flex: 1, padding: "6px 10px", border: "none", borderLeft: "1px solid var(--rule)", cursor: "pointer", background: graphView ? "var(--brand-tint)" : "var(--surface)", color: graphView ? "var(--brand)" : "var(--ink-dim)", fontWeight: graphView ? 600 : 400 }}>◇ Graph</button>
                  </div>
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Your name</div>
                  <button className="btn" onClick={() => { setNameDraft(myName); setEditingName(true); setMoreOpen(false); }} title="Set the name your comments are signed with"
                    style={{ width: "100%", justifyContent: "flex-start", padding: "6px 10px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 7 }}>
                    {myName ? <><Avatar name={myName} size={16} /> {myName}</> : "👤 Set your name"}
                  </button>
                </div>
              </div>
            </>)}
          </div>
        </div>
      </div>

      {graphView && (
        <div className="card card-pad" style={{ marginBottom: 22 }}>
          <MachineGraph states={machine.states} currentIdx={run.state_index} status={run.status} countFor={runCountFor} viewIdx={viewIdx} onNode={i => { setViewPhase(i); setOpenArt(null); }} />
        </div>
      )}
      {/* horizontal stepper — main phases in a line; off-path leaves (Deep-dive) hang as a
          dashed branch under their "alt-of" phase (e.g. Build). Click any node to VIEW it. */}
      {!graphView && <div className="stepper" style={{ marginBottom: 22, alignItems: "flex-start" }}>
        {(() => {
          const indexed = machine.states.map((s, i) => ({ s, i }));
          const main = indexed.filter(x => !x.s.offPath);
          const offs = indexed.filter(x => x.s.offPath);
          // anchor each off-path leaf to the main phase right before its returnTo target (its "alt-of")
          const anchorOf = (o: { s: StateDef; i: number }) => {
            const rt = machine.states.findIndex(st => st.id === o.s.returnTo);
            let a = main[0]?.i ?? 0;
            for (const m of main) if (m.i < (rt < 0 ? machine.states.length : rt)) a = m.i;
            return a;
          };
          const renderStep = (s: StateDef, i: number, withLine: boolean) => {
            const done = i < run.state_index || run.status === "done";
            const current = i === run.state_index && run.status !== "done";
            const viewed = i === viewIdx;
            const off = disabledSteps.has(s.id);
            const cc = phaseCommentCount(s.id);
            return (
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                {withLine && <span className={`step-line ${i <= run.state_index || run.status === "done" ? "done" : ""}`} />}
                <span className={`step ${done ? "done" : ""} ${current ? "current" : ""}`} onClick={() => { setViewPhase(i); setOpenArt(null); }}
                  title={`View ${s.name}${(s as any).gate && !off ? " · approval gate" : ""}${off ? " · skipped this run" : ""}`}
                  style={{ cursor: "pointer", position: "relative", outline: viewed && !current ? "2px solid var(--brand)" : "none", outlineOffset: 1, opacity: off ? 0.45 : 1, textDecoration: off ? "line-through" : "none" }}>
                  <span className="num">{off ? "⏭" : done ? "✓" : i + 1}</span>{s.name}
                  {current && run.status === "running" && <span className="spin" style={{ marginLeft: 2 }} />}
                  {cc > 0 && <span className="cbadge" title={`${cc} open comment(s)`}>{cc}</span>}
                </span>
              </span>
            );
          };
          return main.map(({ s, i }, k) => {
            const branches = offs.filter(o => anchorOf(o) === i);
            return (
              <span key={s.id} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                {renderStep(s, i, k > 0)}
                {branches.length > 0 && <span style={{ width: 2, height: 9, background: "var(--brand)", opacity: 0.4, borderRadius: 2 }} />}
                {branches.map(b => {
                  const ran = runCountFor(b.s.id);
                  const bviewed = b.i === viewIdx;
                  const bcur = b.i === run.state_index && run.status !== "done";
                  return (
                    <button key={b.s.id} onClick={() => { setViewPhase(b.i); setOpenArt(null); }}
                      title={`${b.s.name} — off-path / on-demand (an alternative to ${s.name}). Click to view; launch one via ↪ Route → ${b.s.name}.`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, border: "1px dashed var(--brand)", background: bcur ? "var(--brand-tint)" : "transparent", color: "var(--brand)", outline: bviewed ? "2px solid var(--brand)" : "none", outlineOffset: 1 }}>
                      🔬 {b.s.name}{ran > 0 ? (ran > 1 ? ` ×${ran}` : " ✓") : ""}
                      {bcur && run.status === "running" && <span className="spin" style={{ marginLeft: 2 }} />}
                    </button>
                  );
                })}
              </span>
            );
          });
        })()}
      </div>}

      {/* Mobile: a clean vertical phase list (the horizontal stepper above is hidden on phones). */}
      {!graphView && <div className="stepper-mobile">
        {machine.states.filter(s => !s.offPath).map((s) => {
          const i = machine.states.indexOf(s);
          const done = i < run.state_index || run.status === "done";
          const current = i === run.state_index && run.status !== "done";
          const viewed = i === viewIdx;
          const off = disabledSteps.has(s.id);
          const cc = phaseCommentCount(s.id);
          return (
            <button key={s.id} onClick={() => { setViewPhase(i); setOpenArt(null); }}
              style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left", padding: "9px 11px", borderRadius: 10, border: "none", cursor: "pointer", minHeight: 44,
                background: current ? "var(--ink)" : viewed ? "var(--brand-tint)" : "transparent",
                color: current ? "#f4efe6" : "var(--ink)", opacity: off ? 0.5 : 1, textDecoration: off ? "line-through" : "none" }}>
              <span style={{ flex: "none", width: 24, height: 24, borderRadius: 999, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
                background: done ? "var(--success)" : current ? "#f4efe6" : "var(--surface-2)", color: done ? "#fff" : current ? "var(--ink)" : "var(--ink-dim)", border: (done || current) ? "none" : "1px solid var(--rule)" }}>
                {off ? "⏭" : done ? "✓" : i + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: current ? 700 : 500, fontSize: 14.5, lineHeight: 1.3 }}>{s.name}</span>
              {current && run.status === "running" && <span className="spin" style={{ flex: "none" }} />}
              {cc > 0 && <span style={{ flex: "none", fontSize: 11, fontWeight: 700, color: "#fff", background: "var(--brand)", borderRadius: 999, minWidth: 18, height: 18, display: "grid", placeItems: "center", padding: "0 5px" }}>{cc}</span>}
            </button>
          );
        })}
      </div>}

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_340px] gap-[22px] items-start">
        {/* ——— main column ——— */}
        <div className="max-sm:order-3" style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          {run.status === "done"
            ? <div className="card card-pad s-done" style={{ borderColor: "var(--success-soft)", color: "var(--success)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <b style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>✓ Goal complete — every phase passed.</b>
                {run.pr_url && <a href={run.pr_url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, marginLeft: "auto", color: "var(--success)" }}>🔗 {run.pr_url.replace("https://github.com/", "")}</a>}
              </div>
            : run.pr_url
              ? <a href={run.pr_url} target="_blank" rel="noreferrer" className="card card-pad" style={{ borderColor: "var(--success-soft)", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15 }}>🔗</span><b style={{ color: "var(--success)" }}>Pull request opened</b>
                  <span className="mono muted" style={{ fontSize: 12, marginLeft: "auto" }}>{run.pr_url.replace("https://github.com/", "")}</span>
                </a>
              : null}
          {run.last_error && <div className="card card-pad" style={{ borderColor: "var(--danger)", color: "var(--danger)", fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{run.last_error}</div>}
          {run.status === "running" && (() => {
            const attemptN = runCountFor(machine.states[run.state_index]?.id || "");
            const todos = progress?.todos || [];
            const doneN = todos.filter(t => t.status === "done").length;
            const activeIdx = todos.findIndex(t => t.status === "active");
            const activeTodo = activeIdx >= 0 ? todos[activeIdx] : null;
            const canExpand = todos.length > 0;
            return (
              <div className="card card-pad" style={{ borderColor: "var(--brand)", background: "var(--brand-tint)", padding: canExpand && progressOpen ? undefined : "10px 14px" }}>
                <div onClick={() => canExpand && setProgressOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: canExpand ? "pointer" : "default" }}>
                  <span className="spin" style={{ flex: "0 0 auto" }} />
                  <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Working on <b style={{ color: "var(--brand)" }}>{currentName}</b>{attemptN > 1 ? <span className="muted" style={{ fontWeight: 400 }}> · attempt {attemptN}</span> : null}</span>
                  {/* Anchor the fine-grained "current task" under its NUMBERED active milestone, so it's
                      clear which todo the sub-action belongs to (else the two read as a mismatch).
                      Falls back to just the current line, then the raw activity, until the checklist lands. */}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {activeTodo
                      ? <>· <b>{activeIdx + 1}/{todos.length} {activeTodo.task}</b>{progress?.current ? <span className="muted" style={{ fontWeight: 400 }}> — {progress.current}</span> : null}</>
                      : progress?.current
                        ? <span style={{ fontWeight: 500 }}>· {progress.current}</span>
                        : liveActivity ? <span className="muted mono" style={{ fontSize: 12 }}>· {liveActivity}</span> : null}
                  </span>
                  {canExpand && <span className="muted" style={{ flex: "0 0 auto", fontSize: 12, userSelect: "none" }}>{doneN}/{todos.length} done · {progressOpen ? "▾" : "▸"}</span>}
                </div>
                {canExpand && progressOpen && (
                  <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--rule)", display: "flex", flexDirection: "column", gap: 7 }}>
                    {todos.map((t, i) => (
                      <div key={i}>
                        <div style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13, opacity: t.status === "pending" ? 0.65 : 1 }}>
                          <span style={{ flex: "0 0 auto", width: 15, textAlign: "center", color: t.status === "done" ? "var(--success)" : "var(--brand)" }}>{t.status === "done" ? "✓" : t.status === "active" ? "●" : "○"}</span>
                          <span style={{ flex: "0 0 auto", width: 16, textAlign: "right", fontSize: 12, color: "var(--ink-dim)", fontVariantNumeric: "tabular-nums" }}>{i + 1}.</span>
                          <span style={{ textDecoration: t.status === "done" ? "line-through" : "none", color: t.status === "done" ? "var(--ink-dim)" : "var(--ink)", fontWeight: t.status === "active" ? 600 : 400 }}>{t.task}</span>
                        </div>
                        {/* The narrator's fine-grained current step, shown UNDER its active milestone. */}
                        {t.status === "active" && progress?.current && (
                          <div className="muted" style={{ fontSize: 12, marginLeft: 49, marginTop: 3 }}>↳ {progress.current}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* per-phase ad-hoc case input — only when the phase you're viewing declares one (generic, config-driven) */}
          {viewState?.caseInput && (
            <form onSubmit={e => { e.preventDefault(); if (viewState) runCase(viewState.id); }}
              title={`Send ${viewState.name} an extra case/scenario to handle this run.`}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "1px solid var(--rule)", borderRadius: 10, background: "var(--surface)" }}>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{viewState.caseInput.label}</span>
              <input className="input" value={caseText} onChange={e => setCaseText(e.target.value)} disabled={busy}
                placeholder={viewState.caseInput.placeholder || `Add a case for ${viewState.name}…`} style={{ flex: 1, fontSize: 13 }} />
              <button type="submit" className="btn btn-brand" disabled={busy || !caseText.trim()} style={{ whiteSpace: "nowrap", padding: "8px 14px" }}>Run →</button>
            </form>
          )}

          {/* per-phase downloadable OUTPUT — config-driven (state.output), shown once the phase has run */}
          {viewState?.output && runCountFor(viewState.id) > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", border: "1px solid var(--success-soft)", borderRadius: 10, background: "var(--surface)" }}>
              <span style={{ fontSize: 18 }}>📦</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{viewState.output.label || viewState.output.file}</span>
              <a href={`/api/runs/${id}/file?p=${encodeURIComponent(viewState.output.file)}`} download className="btn btn-run" style={{ marginLeft: "auto", textDecoration: "none", fontSize: 13, whiteSpace: "nowrap" }}>⬇ Download</a>
            </div>
          )}

          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--rule)", background: "var(--surface-2)", alignItems: "center", flexWrap: "wrap" }}>
              <span className="label" style={{ marginRight: 2 }}>Deliverables</span>
              {!viewingCurrent && <button className="btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => { setViewPhase(null); setOpenArt(null); }}>→ current ({currentName})</button>}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {viewingCurrent && run.status === "awaiting_approval" && (
                  isPick
                    ? <button className="btn btn-run" disabled={busy || picks.length === 0} onClick={() => act("approve", picks.length > 1
                        ? `The human approved MULTIPLE mock options — build ONE implementation that combines them, taking the strongest ideas from each: ${picks.map(p => `"${p.name}"`).join(", ")}.`
                        : `Build the mock option the human chose: "${picks[0]?.name}".`)}>✓ Build {picks.length > 1 ? `${picks.length} selected` : `“${picks[0]?.name}”`} &amp; continue</button>
                    : <button className="btn btn-run" disabled={busy} onClick={() => act("approve")}>✓ Approve &amp; continue</button>
                )}
                {canTest && (testInfo
                  ? <button className="btn" disabled={driving} onClick={stopTest} title="Close the test browser, the LAN link, and the dev server">■ {driving ? "Stopping…" : "Stop testing"}</button>
                  : <button className={"btn" + (run.status === "running" || run.status === "awaiting_approval" ? " btn-brand" : "")} disabled={driving} onClick={testDrive} title="Boot the app, log in, open it in Chrome + share on your network">▶ {driving ? "Starting…" : "Test it"}</button>)}
                {/* Generic re-check for a WATCHABLE terminal phase (e.g. Open PR: rebase onto latest base, confirm CI).
                    Config-driven off state.watchable — no PR-specific logic here. Shown once the run has settled. */}
                {viewState?.watchable && run.status !== "running" && run.status !== "queued" && (
                  <button className="btn btn-brand" disabled={busy} onClick={() => recheck(viewIdx)}
                    title={`Re-run ${viewState.name} to re-check it${run.status === "done" ? " (the run is done — this restarts this phase)" : ""}`}>
                    {viewState.watchable.icon || "🔄"} {viewState.watchable.label || "Re-check"}
                  </button>
                )}
                {!viewingCurrent && viewIdx <= run.state_index && ((run.gate_mode || "machine") === "none"
                  ? <button className="btn" disabled={busy} onClick={() => goBack(viewIdx)} title={`Re-run ${viewState?.name} from here (Auto runs forward)`}>↻ Re-run</button>
                  : <button className="btn" disabled={busy} onClick={() => goBack(viewIdx)} title={`Rewind to ${viewState?.name} — pauses so you can review, then Resume`}>↩ Rewind here</button>)}
              </div>
            </div>
            {(testMsg || testInfo) && (
              <div style={{ padding: "10px 14px", fontSize: 12.5, borderBottom: "1px solid var(--rule)", background: "var(--surface-2)" }}>
                {testMsg && <div style={{ color: "var(--ink-soft)" }}>{testMsg}</div>}
                {testInfo && (
                  <div style={{ display: "flex", gap: 18, marginTop: testMsg ? 8 : 0, flexWrap: "wrap", alignItems: "center" }}>
                    {testInfo.localUrl && <span><span className="muted" style={{ fontSize: 11 }}>this computer: </span><a href={testInfo.localUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--brand)", textDecoration: "underline" }}>{testInfo.localUrl.replace(/^https?:\/\//, "")}</a></span>}
                    {testInfo.lanUrl && <span><span className="muted" style={{ fontSize: 11 }}>on your network: </span><a href={testInfo.lanUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--brand)", textDecoration: "underline" }}>{testInfo.lanUrl.replace(/^https?:\/\//, "")}</a> <span className="muted" style={{ fontSize: 11 }}>(open from another computer)</span></span>}
                    {testInfo.creds && (
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <button className="btn" style={{ padding: "3px 9px", fontSize: 11.5 }} onClick={() => setShowCreds(s => !s)} title="The test login the QA agent used to sign in">🔑 {showCreds ? "Hide login" : "Show login"}</button>
                        {showCreds && <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-soft)", cursor: "pointer" }} title="Click to copy email + password"
                          onClick={() => navigator.clipboard?.writeText(`${testInfo.creds!.email}\t${testInfo.creds!.password}`)}>
                          {testInfo.creds.email} · {testInfo.creds.password} <span className="muted">(click to copy)</span>
                        </span>}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {phaseArts.length > 0 ? (
              <>
                {(() => {
                  // Shared chip — preserves click/pick/open behavior, adds verdict color + glyph.
                  const renderChip = (a: Art) => {
                    const cc = comments.filter(c => c.artifact_id === a.id && c.status === "open").length;
                    const sel = isPick && picked.has(a.id);
                    const open = a.id === shownArt?.id;
                    const vs = VERDICT_STYLE[verdictOf(a.name) || "none"];
                    return (
                      <button key={a.id} className="chip"
                        onClick={() => { if (isPick) setPicked(prev => { const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; }); setOpenArt(a.id); }}
                        style={{ cursor: "pointer",
                          borderColor: sel ? "var(--success)" : open ? "var(--brand)" : vs.bd,
                          color: sel ? "var(--success)" : open ? "var(--brand)" : vs.fg,
                          background: sel ? "var(--success-soft)" : open ? "var(--brand-tint)" : vs.bg }}>
                        {isPick && (picked.has(a.id) ? "☑ " : "☐ ")}{vs.glyph ? vs.glyph + " " : ""}{ICON[a.kind] || "📄"} {a.name}{cc > 0 ? ` · 💬${cc}` : ""}
                      </button>
                    );
                  };
                  // Visual deliverable (screenshot / video capture): show an ACTUAL thumbnail so
                  // you can spot-check QA's output at a glance — videos play on hover. Click opens full.
                  const renderVisual = (a: Art) => {
                    const open = a.id === shownArt?.id;
                    const v = verdictOf(a.name);
                    const vs = VERDICT_STYLE[v || "none"];
                    const cc = comments.filter(c => c.artifact_id === a.id && c.status === "open").length;
                    const fileUrl = `/api/runs/${id}/file?p=${encodeURIComponent(a.body)}`;
                    return (
                      <button key={a.id} onClick={() => setOpenArt(a.id)} title={a.name}
                        style={{ width: 152, padding: 0, border: `2px solid ${open ? "var(--brand)" : v ? vs.bd : "var(--rule)"}`, borderRadius: 8, overflow: "hidden", background: "var(--surface)", cursor: "pointer", textAlign: "left", display: "flex", flexDirection: "column" }}>
                        <div style={{ position: "relative", height: 92, background: "#1a1814", display: "grid", placeItems: "center" }}>
                          {a.kind === "video"
                            ? <video src={fileUrl} muted loop playsInline preload="metadata"
                                onMouseEnter={e => { e.currentTarget.play().catch(() => {}); }}
                                onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                                style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : <img src={fileUrl} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                          {a.kind === "video" && <span style={{ position: "absolute", fontSize: 22, color: "#fff", textShadow: "0 1px 5px #000", pointerEvents: "none" }}>▶</span>}
                          {v && <span style={{ position: "absolute", top: 4, right: 4, fontSize: 10.5, fontWeight: 700, color: "#fff", background: v === "fail" ? "var(--danger)" : "var(--success)", borderRadius: 4, padding: "0 4px" }}>{vs.glyph} {v.toUpperCase()}</span>}
                          {cc > 0 && <span style={{ position: "absolute", bottom: 4, right: 4, fontSize: 10, background: "rgba(0,0,0,.6)", color: "#fff", borderRadius: 4, padding: "0 4px" }}>💬{cc}</span>}
                        </div>
                        <div style={{ padding: "4px 6px", fontSize: 10.5, lineHeight: 1.25, color: open ? "var(--brand)" : "var(--ink-soft)", maxHeight: 40, overflow: "hidden" }}>{a.name}</div>
                      </button>
                    );
                  };
                  const isVisual = (a: Art) => a.kind === "image" || a.kind === "video";
                  // Mock options: keep the simple flat row — nothing to segment or score.
                  if (isPick) return (
                    <div style={{ display: "flex", gap: 6, padding: "10px 14px", borderBottom: "1px solid var(--rule)", flexWrap: "wrap", alignItems: "center" }}>
                      <span className="muted" style={{ fontSize: 11, marginRight: 2 }}>select one or more to build →</span>
                      {phaseArts.map(renderChip)}
                    </div>
                  );
                  // One run's artifacts, grouped by category, failures surfaced first.
                  const renderRun = (arts: Art[]) => CAT_ORDER.filter(cat => arts.some(a => catOf(a.name) === cat)).map(cat => {
                    const inCat = arts.filter(a => catOf(a.name) === cat).slice().sort((x, y) => verdictRank(x.name) - verdictRank(y.name));
                    const vis = inCat.filter(isVisual);
                    const docs = inCat.filter(a => !isVisual(a));
                    const fails = inCat.filter(a => verdictOf(a.name) === "fail").length;
                    return (
                      <div key={cat} style={{ marginTop: 6 }}>
                        <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>
                          {cat} <span style={{ opacity: .7 }}>({inCat.length})</span>{vis.length > 0 && <span style={{ opacity: .7 }}> · {vis.length} 🎬</span>}{fails > 0 && <span style={{ color: "var(--danger)", fontWeight: 700 }}> · {fails} failing</span>}
                        </div>
                        {vis.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: docs.length ? 8 : 0 }}>{vis.map(renderVisual)}</div>}
                        {docs.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{docs.map(renderChip)}</div>}
                      </div>
                    );
                  });
                  // Segment deliverables by attempt: each state_enter starts a new attempt;
                  // an artifact belongs to the latest attempt entered at/before it.
                  const byRun: Art[][] = Array.from({ length: totalRuns }, () => []);
                  phaseArts.forEach(a => { byRun[Math.min(runOfArt(a), totalRuns - 1)].push(a); });
                  const latestIdx = totalRuns - 1;
                  const fmtStamp = (ts?: number) => ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
                  const savedAt = (arts: Art[]) => arts.length ? Math.max(...arts.map(a => a.created_at)) : undefined;
                  // Is the phase you're viewing the one the agent is running RIGHT NOW?
                  const liveHere = viewingCurrent && run.status === "running";
                  // The newest attempt that has actually saved a deliverable (the running attempt may not have yet).
                  let lastSavedIdx = -1; for (let k = latestIdx; k >= 0; k--) if (byRun[k].length) { lastSavedIdx = k; break; }
                  // Headline shows the running attempt if it has output; otherwise the last attempt that saved.
                  const headlineIdx = byRun[latestIdx].length ? latestIdx : (lastSavedIdx >= 0 ? lastSavedIdx : latestIdx);
                  const showingLive = liveHere && byRun[latestIdx].length > 0;          // headline IS the running attempt, and it has output
                  const liveNotSavedYet = liveHere && byRun[latestIdx].length === 0;    // running attempt hasn't saved anything yet
                  const earlier = byRun.map((arts, k) => ({ arts, k })).filter(r => r.k < headlineIdx && r.arts.length > 0);
                  // One earlier attempt's header (in the collapsed list below).
                  const attemptHeader = (k: number) => (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)" }}>Deliverables for attempt {k + 1}</span>
                      <span className="muted" style={{ fontWeight: 400, fontSize: 10.5 }}>{savedAt(byRun[k]) ? `· ${fmtStamp(savedAt(byRun[k]))}` : viewEnters[k] ? `· ${fmtStamp(viewEnters[k])}` : ""}</span>
                      {viewEnters[k] != null && <button className="btn" style={{ padding: "1px 7px", fontSize: 10.5 }} onClick={() => { setTab("history"); setActivityOpen(true); setFocusTs(viewEnters[k]); }} title="Jump to where this attempt started in History — the feedback that triggered it + what happened">→ history</button>}
                    </div>
                  );
                  return (
                    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}>
                      {/* Headline — which attempt you're reading, and whether it's live or finished. */}
                      {(totalRuns > 1 || liveHere) && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                            {totalRuns > 1
                              ? <span style={{ fontSize: 12, fontWeight: 700 }}>Deliverables <span className="muted" style={{ fontWeight: 400 }}>for attempt {headlineIdx + 1}</span></span>
                              : <span style={{ fontSize: 12, fontWeight: 700 }}>Deliverables</span>}
                            {showingLive && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand)", display: "inline-flex", alignItems: "center", gap: 4 }}><span className="spin" style={{ width: 9, height: 9 }} /> running now</span>}
                            <span className="muted" style={{ fontSize: 10.5 }}>{savedAt(byRun[headlineIdx]) ? `· last saved ${fmtStamp(savedAt(byRun[headlineIdx]))}` : ""}</span>
                            {viewEnters[headlineIdx] != null && <button className="btn" style={{ padding: "1px 7px", fontSize: 10.5 }} onClick={() => { setTab("history"); setActivityOpen(true); setFocusTs(viewEnters[headlineIdx]); }} title="Jump to where this attempt started in History">→ history</button>}
                          </div>
                          {showingLive && <div className="muted" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>This is the attempt running right now — you're seeing its latest <b>saved</b> work, which may still change. What it's doing this second is in the banner up top.</div>}
                          {liveNotSavedYet && <div style={{ fontSize: 11, marginTop: 3, lineHeight: 1.45, color: "var(--brand)", fontWeight: 600 }}>⟳ Attempt {totalRuns} is in progress; deliverable pending.</div>}
                        </div>
                      )}
                      {byRun[headlineIdx].length ? renderRun(byRun[headlineIdx]) : <div className="muted" style={{ fontSize: 12 }}>No deliverables saved yet for this phase.</div>}
                      {earlier.length > 0 && (
                        <div style={{ marginTop: 12, borderTop: "1px dashed var(--rule)", paddingTop: 8 }}>
                          <button className="btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setShowEarlier(v => !v)}>
                            {showEarlier ? "▾ Hide" : "▸ Show"} {earlier.length} earlier attempt{earlier.length > 1 ? "s" : ""}
                          </button>
                          {showEarlier && earlier.slice().reverse().map(({ arts, k }) => (
                            <div key={k} style={{ marginTop: 10, opacity: .85 }}>
                              {attemptHeader(k)}
                              {renderRun(arts)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {shownArt && <Annotator key={shownArt.id} art={shownArt} runId={id} comments={comments.filter(c => c.artifact_id === shownArt.id)}
                  onAdd={(anchor, body, images) => addComment(shownArt, anchor, body, images)} onDelete={deleteComment} onEdit={editComment} onReply={replyToComment} />}
              </>
            ) : (
              <div className="muted" style={{ padding: 20, fontSize: 13 }}>No deliverables for {viewState?.name} yet.</div>
            )}
          </div>

          {/* Run-level OUTPUT — the final deliverable files, shown BELOW the per-phase write-up */}
          {deliverables.length > 0 && (
            <div className="card" style={{ overflow: "hidden", padding: "14px 14px 6px" }}>
              <DeliverableFiles deliverables={deliverables} runId={id} />
            </div>
          )}

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 12px", borderBottom: activityOpen ? "1px solid var(--rule)" : "none" }}>
              <button onClick={() => setActivityOpen(o => !o)} title={activityOpen ? "Collapse the raw agent log" : "Expand the raw agent log"}
                style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-dim)", fontSize: 11, padding: "0 4px", userSelect: "none" }}>{activityOpen ? "▾" : "▸"}</button>
              {([["activity", "Activity"], ["history", "History"]] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => { setTab(k); setActivityOpen(true); }} className="label"
                  style={{ border: "none", cursor: "pointer", padding: "5px 10px", borderRadius: 7, background: activityOpen && tab === k ? "var(--brand-tint)" : "transparent", color: activityOpen && tab === k ? "var(--brand)" : "var(--ink-dim)", fontWeight: activityOpen && tab === k ? 600 : 500 }}>{lbl}</button>
              ))}
              <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{!activityOpen ? "raw agent output — collapsed" : tab === "activity" ? "raw agent output · this phase" : "every phase move · jump back to any point"}</span>
            </div>
            {activityOpen && (tab === "activity" ? (
              <div ref={logRef} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollTop < 60; }}
                style={{ maxHeight: 440, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                {items.length === 0 && <span className="muted">Waiting for the agent…</span>}
                {items.map((it, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span className="mono muted" title={new Date(it.ts).toLocaleString()} style={{ flex: "0 0 auto", minWidth: 66, textAlign: "right", fontSize: 10.5, opacity: 0.55, paddingTop: 2, userSelect: "none" }}>{fmtTime(it.ts)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}><TimelineItem it={it} machine={machine} runId={id} /></div>
                  </div>
                ))}
              </div>
            ) : (
              <HistoryView items={allItems} comments={comments} machine={machine} run={run} busy={busy} focusTs={focusTs} onRerun={(idx, stateId, name) => { setRerunNote(""); setRerunModal({ idx, stateId, name }); }} />
            ))}
          </div>
        </div>

        {/* ——— sidebar ——— */}
        {/* On phones the rail flattens into the grid (max-sm:contents) so its cards can be
            re-ordered around the main column: North Star + Conductor rise above the log + Setup. */}
        <div className="flex flex-col gap-4 sm:sticky sm:top-[76px] min-w-0 max-sm:contents">
          <div className="card card-pad max-sm:order-1">
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <div className="label">Loop</div>
              <Link href={`/machines/${machine.id}`} className="btn max-sm:min-h-[44px]" style={{ marginLeft: "auto", padding: "3px 9px", fontSize: 11.5, textDecoration: "none" }} title="Open the underlying loop: edit its phases, prompts, and tools (affects every run of this loop)">↗ Edit loop</Link>
            </div>
            <NorthStar mode="studio" runId={id} run={run} machine={machine as any} onChanged={load} busy={busy} />
            {/* Per-run step toggles — turn phases off to move faster. Sets run.disabled_states, which
                the driver already skips when advancing AND the Conductor is told never to route into.
                Off-path leaves aren't part of the linear flow, so they're not listed. Any step can be
                toggled at any time: a factory run LOOPS back and re-runs phases (route/revise), so a
                "done" phase isn't permanently done — turning it off means the driver skips it the next
                time it would advance into it. */}
            {(() => {
              const mains = machine.states.map((s, i) => ({ s, i })).filter(x => !x.s.offPath);
              const offN = mains.filter(x => disabledSteps.has(x.s.id)).length;
              return (
                <details className="steps-toggle" style={{ marginTop: 10, borderTop: "1px solid var(--rule-soft)", paddingTop: 10 }}>
                  <summary style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6, listStyle: "none" }}>
                    <span className="label">Steps</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: offN ? "var(--warning)" : "var(--ink-dim)" }}>{offN ? `${offN} off · faster` : "all on"}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-dim)" }}>toggle ▾</span>
                  </summary>
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 1 }}>
                    {mains.map(({ s, i }) => {
                      const done = i < run.state_index || run.status === "done";
                      const running = i === run.state_index && run.status === "running";
                      const off = disabledSteps.has(s.id);
                      return (
                        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 2px" }}>
                          <button type="button" role="switch" aria-checked={!off} aria-label={`${off ? "Enable" : "Skip"} ${s.name}`} disabled={busy}
                            onClick={() => toggleStep(s.id, disabledSteps)}
                            title={off ? `Turn ${s.name} back on` : `Skip ${s.name} (the driver won't run it next time it advances here)`}
                            style={{ flex: "none", width: 34, height: 20, borderRadius: 999, border: "none", position: "relative", padding: 0, cursor: busy ? "default" : "pointer",
                              background: off ? "var(--rule)" : "var(--success)", opacity: busy ? 0.6 : 1, transition: "background .15s" }}>
                            <span style={{ position: "absolute", top: 2, left: off ? 2 : 16, width: 16, height: 16, borderRadius: 999, background: "#fff", transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,.25)" }} />
                          </button>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: off ? "var(--ink-dim)" : "var(--ink)", textDecoration: off ? "line-through" : "none" }}>{s.name}</span>
                          <span style={{ flex: "none", fontSize: 10, fontWeight: 600, color: off ? "var(--warning)" : "var(--ink-dim)" }}>{off ? "off" : done ? "done" : running ? "now" : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })()}
          </div>

          <ConductorPanel run={run} messages={conductor} comments={comments} openCount={openCount} handledCount={handledCount} busy={busy} synthing={synthing} activity={activity}
            onTalk={(t, imgs) => conductorDo("talk", { text: t, images: imgs })}
            onApply={(mid) => conductorDo("apply", { messageId: mid })} onDismiss={(mid) => conductorDo("dismiss", { messageId: mid })}
            onAutopilot={(a) => conductorDo("setAutopilot", { autopilot: a })} onClear={clearComments} onJumpComment={jumpToComment}
            onStop={() => conductorDo("stop")}
            onReview={() => conductorDo("synthesize")} onClearChat={() => conductorDo("clear")} onRevert={() => conductorDo("revert")}
            onOpenInspector={() => setInspectorOpen(true)} />
          {/* Setup — repo, agent/models, and run metadata, collapsed by default so the rail
              rests on just Conductor + Loop. Everything stays reachable when expanded. */}
          <details className="card card-pad meta-details max-sm:order-4">
            <summary className="label" style={{ cursor: "pointer", userSelect: "none" }}>Setup</summary>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 18 }}>
              {run.repo_path && (
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>Repository</div>
                  <div className="mono" style={{ fontSize: 12, lineHeight: 1.7, overflowWrap: "anywhere", minWidth: 0 }}>
                    <div>{run.repo_path.split("/").pop()}</div>
                    <div className="muted">base: {run.base_branch}</div>
                    {run.branch_name && <div className="muted">branch: {run.branch_name}</div>}
                  </div>
                </div>
              )}
              <div>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
                  <div className="label">Agent</div>
                  {!editingModels && <button className="btn" style={{ marginLeft: "auto", padding: "3px 9px", fontSize: 11.5 }} onClick={() => { setMPrimary(run.primary_model || PRIMARY_OPTS[0].value); setMVision(run.vision_model || VISION_OPTS[0].value); setMGov(run.conductor_model || ""); setEditingModels(true); }}>✎ Change</button>}
                </div>
                {editingModels ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <label className="muted" style={{ fontSize: 11 }}>Agent — runs the work
                      <select className="input" style={{ marginTop: 3, fontSize: 12 }} value={mPrimary} onChange={e => setMPrimary(e.target.value)}>{PRIMARY_OPTS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
                    <label className="muted" style={{ fontSize: 11 }}>Vision helper — QA / judging images
                      <select className="input" style={{ marginTop: 3, fontSize: 12 }} value={mVision} onChange={e => setMVision(e.target.value)}>{VISION_OPTS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
                    <label className="muted" style={{ fontSize: 11 }}>Governor — the Conductor
                      <select className="input" style={{ marginTop: 3, fontSize: 12 }} value={mGov} onChange={e => setMGov(e.target.value)}><option value="">Same as agent</option>{PRIMARY_OPTS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-primary" style={{ padding: "4px 11px", fontSize: 12 }} disabled={busy} onClick={saveModels}>Save</button>
                      <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEditingModels(false)}>Cancel</button>
                    </div>
                    <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>Applies to the next phase / Conductor call — switch here if you hit a provider limit.</div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13 }}>{(run.primary_model || "").replace("ollama:", "") || "—"}</div>
                    {run.vision_model && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>vision: {run.vision_model.replace("ollama:", "")}</div>}
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>governor: {run.conductor_model ? run.conductor_model.replace("ollama:", "") : "same as agent"}</div>
                    {run.loop_count > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>↩ {run.loop_count} fix loop{run.loop_count > 1 ? "s" : ""}</div>}
                  </>
                )}
              </div>

              <div>
                <div className="label" style={{ marginBottom: 8 }}>Metadata</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", columnGap: 16, rowGap: 8, fontSize: 12, alignItems: "baseline" }}>
                  {([
                    ["Created", `${timeAgo(run.created_at)} · ${new Date(run.created_at).toLocaleString()}`, false],
                    ["Updated", `${timeAgo(run.updated_at)} · ${new Date(run.updated_at).toLocaleString()}`, false],
                    ["Run ID", run.id, true],
                    ["Loop", machine.name, false],
                    ["Model", run.primary_model || "—", true],
                    ["Gate mode", run.gate_mode || "—", false],
                    ["Status", run.status, false],
                  ] as [string, string, boolean][]).map(([k, v, mono]) => (
                    <Fragment key={k}>
                      <span className="muted" style={{ whiteSpace: "nowrap" }}>{k}</span>
                      <span className={mono ? "mono" : ""} style={{ color: "var(--ink-soft)", wordBreak: "break-word", minWidth: 0 }}>{v}</span>
                    </Fragment>
                  ))}
                  {(() => {
                    const r = resumeInfo(run);
                    if (!r.sessionId) return (<><span className="muted" style={{ whiteSpace: "nowrap" }}>Session</span><span className="muted">— (no agent session yet)</span></>);
                    return (
                      <>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>Session</span>
                        <span className="mono" title="Click to copy the session id" onClick={() => navigator.clipboard?.writeText(r.sessionId!)}
                          style={{ color: "var(--ink-soft)", cursor: "pointer", wordBreak: "break-all" }}>{r.sessionId} <span className="muted">({r.provider})</span></span>
                        <span className="muted" style={{ whiteSpace: "nowrap" }}>Resume</span>
                        <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                          <code className="mono" title={r.cmd!} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "var(--surface-2)", border: "1px solid var(--rule-soft)", borderRadius: 5, padding: "2px 6px", fontSize: 11 }}>{r.cmd}</code>
                          <button className="btn" style={{ flex: "0 0 auto", padding: "2px 8px", fontSize: 11 }} onClick={() => navigator.clipboard?.writeText(r.cmd!)} title="Copy the claude resume command">⧉ copy</button>
                        </span>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* OVERRIDE THE CONDUCTOR — route the loop directly to any phase, carrying the open
          comments + their images, plus extra instructions/images the human adds here. */}
      {routeOpen && (() => {
        const open = comments.filter(c => c.status === "open");
        const target = machine.states.find(s => s.id === routeTarget);
        return (
          <div onClick={() => setRouteOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 100, display: "grid", placeItems: "center", padding: 20 }}>
            <div onClick={e => e.stopPropagation()} className="card card-pad" style={{ width: 560, maxWidth: "calc(100vw - 40px)", maxHeight: "86vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 16 }}>↪ Route directly to a phase</div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>Override the Conductor and send the loop straight to the phase you pick. Your open comments (and their images) go with it, plus anything you add below — the agent reads it all.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{open.length} open comment{open.length === 1 ? "" : "s"} — sent with this route</span>
                {open.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No open comments — you can still route with the instructions below.</div>}
                {open.map(c => (
                  <div key={c.id} style={{ fontSize: 12, background: "var(--surface-2)", borderRadius: 8, padding: "8px 10px", display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, lineHeight: 1.4 }}>{c.artifact_name ? <span className="muted">{c.artifact_name} — </span> : null}{c.body}</div>
                    {imagesOf(c).slice(0, 2).map((src, i) => <img key={i} src={src} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 4, border: "1px solid var(--rule)", flex: "0 0 auto" }} />)}
                  </div>
                ))}
              </div>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Send to phase
                <select className="input" style={{ marginTop: 5 }} value={routeTarget} onChange={e => setRouteTarget(e.target.value)}>
                  {machine.states.map(s => <option key={s.id} value={s.id}>{s.name}{s.offPath ? " — off-path / on-demand" : ""}</option>)}
                </select>
              </label>
              <textarea className="input" value={routeNote} onChange={e => setRouteNote(e.target.value)} onPaste={routeAtt.onPaste}
                placeholder={`Optional extra instructions for ${target?.name || "this phase"} — paste an image too…`} style={{ minHeight: 90, fontSize: 13 }} />
              <ImageBar images={routeAtt.images} addFile={routeAtt.addFile} removeAt={routeAtt.removeAt} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" disabled={busy} onClick={() => setRouteOpen(false)}>Cancel</button>
                <button className="btn btn-run" disabled={busy || !routeTarget} onClick={routeDirect}>↪ Route to {target?.name || "phase"} →</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* "send a phase back to re-run with notes" — add instructions, then the phase
          re-runs to address them (revises in place), like the Conductor's suggest flow. */}
      {rerunModal && (() => {
        const m = rerunModal;
        const open = comments.filter(c => c.state === m.stateId && c.status === "open");
        return (
          <div onClick={() => setRerunModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 100, display: "grid", placeItems: "center", padding: 20 }}>
            <div onClick={e => e.stopPropagation()} className="card card-pad" style={{ width: 460, maxWidth: "calc(100vw - 40px)", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 16 }}>↩ Send <b>{m.name}</b> back to re-run</div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>Add instructions and the phase re-runs to ADDRESS them — revising its existing deliverable in place (like the Conductor, but you pick the phase). Leave blank to just rewind.</div>
              {open.length > 0 && (
                <div style={{ fontSize: 12, background: "var(--surface-2)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{open.length} pending comment(s) on this phase — included too</span>
                  {open.slice(0, 4).map(c => <div key={c.id} style={{ lineHeight: 1.4 }}>• {c.body.slice(0, 120)}{c.body.length > 120 ? "…" : ""}</div>)}
                </div>
              )}
              <textarea className="input" autoFocus value={rerunNote} onChange={e => setRerunNote(e.target.value)} placeholder={`What should ${m.name} fix or do differently?`} style={{ minHeight: 110, fontSize: 13 }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" disabled={busy} onClick={() => setRerunModal(null)}>Cancel</button>
                <button className="btn btn-run" disabled={busy} onClick={() => { setRerunModal(null); sendBackToPhase(m.stateId, m.idx, rerunNote); }}>↩ Send back &amp; re-run</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}


// ═══════════ The Conductor panel ═══════════
function ConductorPanel({ run, messages, comments, openCount, handledCount, busy, synthing, activity, onTalk, onApply, onDismiss, onAutopilot, onClear, onJumpComment, onStop, onReview, onClearChat, onRevert, onOpenInspector }:
  { run: Run; messages: CMsg[]; comments: Cmt[]; openCount: number; handledCount: number; busy: boolean; synthing: boolean; activity: string[]; onTalk: (t: string, images?: string[]) => void; onApply: (id: string) => void; onDismiss: (id: string) => void; onAutopilot: (a: Autopilot) => void; onClear: (scope: "all" | "handled") => void; onJumpComment: (c: Cmt) => void; onStop: () => void; onReview: () => void; onClearChat: () => void; onRevert: () => void; onOpenInspector: () => void }) {
  const [text, setText] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const att = useImageAttach();
  // Keep the chat pinned to the most recent message (bottom) — that's the live edge, so a fresh
  // reply is what you see first, not the top of the history.
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length, synthing]);
  const mode = run.conductor_mode || "auto";
  const react = run.conductor_react || "auto";
  const autopilot = autopilotOf(react, mode);
  const send = () => { if (text.trim() || att.images.length) { onTalk(text.trim(), att.images); setText(""); att.reset(); } };
  // Applying a loop edit rewrites the reusable loop TEMPLATE (every future run of this loop),
  // so confirm before copying the proposed edits over — same apply path, just guarded.
  const onApplyLoopEdit = (mid: string) => {
    if (confirm("Copy these loop edits to the loop template?\n\nThis updates the loop itself — every future run of this loop will use the edited phases. It does not change the current run.")) onApply(mid);
  };
  // Auto-grow the chat composer to fit its contents, capped.
  useEffect(() => {
    document.querySelectorAll<HTMLTextAreaElement>("textarea.conductor-ta").forEach(el => {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    });
  }, [text]);
  // The composer row (text + image + send) and a Stop / "review comments" bar. The full
  // chat + activity view lives in the ConductorInspector modal (opened via onOpenInspector).
  const composer = (big: boolean) => (
    <div>
      {synthing
        ? <div style={{ width: "100%", marginBottom: 8, fontSize: 12, color: "#5848a0", display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}><span className="spin" /> Conductor is investigating… <button className="btn" style={{ padding: "2px 10px", fontSize: 11.5 }} onClick={onStop}>⏹ Stop</button></div>
        : (react === "manual" && openCount > 0 && <div style={{ width: "100%", marginBottom: 8, display: "flex", justifyContent: "center" }}><button className="btn btn-brand" style={{ padding: "5px 12px", fontSize: 12.5 }} onClick={onReview}>Review {openCount} comment{openCount > 1 ? "s" : ""} now</button></div>)}
      {activity.length > 0 && (
        <details open={synthing} style={{ marginBottom: 8, fontSize: 11.5 }}>
          <summary style={{ cursor: "pointer", color: "#5848a0", userSelect: "none" }}>🧠 Activity — {activity.length} step{activity.length > 1 ? "s" : ""}{synthing ? " · live" : ""}</summary>
          <div style={{ marginTop: 6, maxHeight: 170, overflow: "auto", borderLeft: "2px solid var(--rule)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 3, color: "var(--ink-soft)" }}>
            {activity.slice(-50).map((a, i) => <div key={i} className="mono" style={{ fontSize: 11 }}>{a}</div>)}
          </div>
        </details>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea className="input conductor-ta" rows={1}
          style={{ flex: 1, fontSize: big ? 13.5 : 12.5, resize: "none", maxHeight: 200, lineHeight: 1.5, overflowY: "auto" }}
          placeholder="Talk to the Conductor — ⌘/Ctrl+↵ or tap Send (Enter makes a new line; paste/attach an image too)…" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          onPaste={att.onPaste} disabled={busy} />
        <button className="btn btn-brand max-sm:min-h-[44px]" style={{ padding: big ? "7px 14px" : "6px 12px" }} disabled={busy || (!text.trim() && !att.images.length)} onClick={send}>Send</button>
      </div>
      <div style={{ marginTop: 8 }}><ImageBar images={att.images} addFile={att.addFile} removeAt={att.removeAt} /></div>
    </div>
  );
  const byId: Record<string, Cmt> = Object.fromEntries(comments.map(c => [c.id, c]));
  const renderMsg = (m: CMsg, big: boolean) => {
    const dir = m.directive ? (() => { try { return JSON.parse(m.directive!); } catch { return null; } })() : null;
    const fs = big ? 14 : 12.5;
    if (m.role === "you") return <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: big ? "78%" : "90%", background: "var(--brand-tint)", border: "1px solid #eccabf", borderRadius: "10px 10px 2px 10px", padding: big ? "10px 14px" : "7px 10px", fontSize: fs }}>{m.body && <div style={{ lineHeight: 1.55 }}><Markdown>{m.body}</Markdown></div>}{parseImgs(m.image).map((src, i) => <img key={i} src={src} alt="" style={{ display: "block", marginTop: (m.body || i) ? 6 : 0, maxWidth: "100%", maxHeight: big ? 280 : 180, borderRadius: 6, border: "1px solid #eccabf" }} />)}</div>;
    if (m.role === "system") return <div key={m.id} className="muted" style={{ fontSize: big ? 12.5 : 11.5, fontStyle: "italic", textAlign: "center" }}>{m.body}</div>;
    return (
      <div key={m.id} style={{ alignSelf: "flex-start", maxWidth: big ? "88%" : "94%", background: "#f6f1fb", border: "1px solid #e0d6f3", borderRadius: "10px 10px 10px 2px", padding: big ? "12px 15px" : "9px 11px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}><span className="cdot" style={{ width: 7, height: 7 }} /><b style={{ fontSize: big ? 13 : 11.5, color: "#5848a0" }}>Conductor</b></div>
        <div style={{ fontSize: fs, lineHeight: 1.55, whiteSpace: "pre-wrap" }}><Markdown>{m.body}</Markdown></div>
        {dir && m.status === "proposed" && (
          <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
            {dir.action === "edit_loop"
              ? <button className="btn btn-run" style={{ padding: big ? "6px 13px" : "4px 11px", fontSize: big ? 13 : 12 }} disabled={busy} onClick={() => onApplyLoopEdit(m.id)}>✓ Apply to loop template</button>
              : <button className="btn btn-run" style={{ padding: big ? "6px 13px" : "4px 11px", fontSize: big ? 13 : 12 }} disabled={busy} onClick={() => onApply(m.id)}>✓ Approve → {dir.targetName}</button>}
            <button className="btn" style={{ padding: big ? "6px 11px" : "4px 9px", fontSize: big ? 13 : 12 }} disabled={busy} onClick={() => onDismiss(m.id)}>Dismiss</button>
          </div>
        )}
        {m.status === "applied" && <div style={{ marginTop: 6, fontSize: big ? 12 : 11, color: "var(--success)" }}>{dir?.action === "edit_loop" ? "✓ loop template updated" : `✓ routed${dir?.targetName ? ` to ${dir.targetName}` : ""}`}</div>}
        {m.status === "dismissed" && <div className="muted" style={{ marginTop: 6, fontSize: big ? 12 : 11 }}>dismissed</div>}
        {dir?.commentIds?.length ? (
          <details style={{ marginTop: 9 }}>
            <summary style={{ cursor: "pointer", fontSize: big ? 12 : 11, color: "var(--ink-dim)", userSelect: "none" }}>📎 Reacting to {dir.commentIds.length} comment{dir.commentIds.length > 1 ? "s" : ""}</summary>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6, borderLeft: "2px solid var(--rule)", paddingLeft: 10 }}>
              {dir.commentIds.map((cid: string) => { const c = byId[cid]; if (!c) return null; return (
                <button key={cid} onClick={() => onJumpComment(c)} title="Jump to this comment"
                  style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0, fontSize: big ? 12.5 : 11, lineHeight: 1.45, color: "var(--ink-soft)" }}>
                  <span style={{ color: "var(--brand)", fontWeight: 600 }}>↳ {c.artifact_name || c.state}</span> — “{c.body.length > 64 ? c.body.slice(0, 64) + "…" : c.body}”
                </button>
              ); })}
            </div>
          </details>
        ) : null}
      </div>
    );
  };
  return (
    <>
    <div className="card conductor max-sm:order-2">
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="cdot" /><b style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>Conductor</b>
          <button className="btn" style={{ marginLeft: "auto", padding: "3px 9px", fontSize: 11 }} onClick={onOpenInspector} title="Open the Conductor — full chat + a live activity log of everything that's happened">⤢ Chat &amp; activity</button>
          {/* Always-present ⋯ menu next to Chat & activity: clear the Conductor's chat history (like
              /clear), plus comment-clearing when there's something to clear. */}
          <div style={{ position: "relative" }}>
            <button className="btn" aria-haspopup="menu" aria-expanded={clearOpen} title="Conductor options" onClick={() => setClearOpen(o => !o)} style={{ padding: "3px 8px", fontSize: 12 }}>⋯</button>
            {clearOpen && (<>
              <div onClick={() => setClearOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
              <div className="card card-pad" role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 41, width: 226, display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 8px 28px rgba(0,0,0,.16)" }}>
                <button className="btn" disabled={busy || (messages.length === 0 && activity.length === 0)}
                  onClick={() => { if (confirm("Clear the Conductor's chat history?\n\nThis wipes the conversation and its activity log — a fresh start for when it's drifted. It keeps the run's goal, phases, comments and files, so the Conductor picks the context back up from those on your next message.")) { onClearChat(); } setClearOpen(false); }}
                  style={{ justifyContent: "flex-start", padding: "6px 10px", fontSize: 12 }}>🧹 Clear conductor history</button>
                {(openCount > 0 || handledCount > 0) && <div style={{ height: 1, background: "var(--rule-soft)", margin: "1px 0" }} />}
                {handledCount > 0 && <button className="btn" disabled={busy} onClick={() => { onClear("handled"); setClearOpen(false); }} style={{ justifyContent: "flex-start", padding: "6px 10px", fontSize: 12 }}>Clear {handledCount} handled</button>}
                {openCount + handledCount > 0 && <button className="btn" disabled={busy} onClick={() => { onClear("all"); setClearOpen(false); }} style={{ justifyContent: "flex-start", padding: "6px 10px", fontSize: 12 }}>Clear all comments</button>}
              </div>
            </>)}
          </div>
        </div>
      </div>
      {openCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: "1px solid var(--rule-soft)", fontSize: 11.5 }}>
          <span style={{ color: "var(--brand)", fontWeight: 600 }}>💬 {openCount} open</span>
          {handledCount > 0 && <span className="muted">· ✓ {handledCount} handled</span>}
        </div>
      )}
      <div ref={feedRef} style={{ padding: "10px 14px 16px", maxHeight: 340, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && !synthing && (openCount > 0
          ? (react === "manual"
            ? <div style={{ fontSize: 12.5, color: "#5848a0" }}>{openCount} comment{openCount > 1 ? "s" : ""} waiting — Manual mode, so hit <b>Review</b> below when you're ready and the Conductor reads {openCount > 1 ? "them all at once" : "it"}.</div>
            : <div style={{ fontSize: 12.5, color: "#5848a0", display: "flex", gap: 7, alignItems: "center" }}><span className="spin" /> {openCount} comment{openCount > 1 ? "s" : ""} — the Conductor will read {openCount > 1 ? "them" : "it"} & propose a route…</div>)
          : <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>Leave comments on any phase — you, or anyone sharing the board. {react === "manual" ? "Manual mode: the Conductor waits — hit Review to read them all at once." : "The Conductor reads them all on its own — everyone's together — and proposes where the loop should go next; you approve or dismiss."} {mode === "propose" ? "Flip to Auto and it routes itself." : ""}</div>)}
        {messages.map(m => renderMsg(m, false))}
      </div>
      <div style={{ borderTop: "1px solid var(--rule)", padding: "10px 12px" }}>
        {composer(false)}
      </div>
    </div>
    </>
  );
}

// A plain-language line for what the agent is doing right now (a tool call).
// ═══════════ Unified annotator — comment on ANY artifact ═══════════
// Parse a stored `image` field (JSON array of data URLs; tolerates a legacy single one).
function parseImgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw[0] === "[") { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [raw];
}
function imagesOf(c: Cmt): string[] { return parseImgs(c.image); }
// Attach one or MORE images to a comment — file picker (multi) or paste (⌘V / Ctrl+V). Keep adding.
function useImageAttach() {
  const [images, setImages] = useState<string[]>([]);
  const addFile = (file: File | null | undefined) => {
    if (!file || !file.type?.startsWith("image/")) return;
    const r = new FileReader(); r.onload = () => setImages(prev => [...prev, String(r.result)]); r.readAsDataURL(file);
  };
  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault(): void }) => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
    if (items.length) { e.preventDefault(); items.forEach(it => addFile(it.getAsFile())); }
  };
  const removeAt = (i: number) => setImages(prev => prev.filter((_, j) => j !== i));
  const reset = () => setImages([]);
  return { images, addFile, onPaste, removeAt, reset };
}
function ImageBar({ images, addFile, removeAt }: { images: string[]; addFile: (f: File | null | undefined) => void; removeAt: (i: number) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {images.map((img, i) => (
        <span key={i} style={{ position: "relative", display: "inline-block" }}>
          <img src={img} alt="" style={{ height: 40, borderRadius: 5, border: "1px solid var(--rule)", display: "block" }} />
          <button onClick={() => removeAt(i)} title="Remove" style={{ position: "absolute", top: -7, right: -7, width: 18, height: 18, borderRadius: 999, border: "1px solid var(--rule)", background: "var(--surface)", cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0 }}>✕</button>
        </span>
      ))}
      <label className="btn" style={{ padding: "3px 9px", fontSize: 11.5, cursor: "pointer" }} title="Attach image(s) — or paste with ⌘V / Ctrl+V">📎 {images.length ? "Add more" : "Image"}
        <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { [...(e.target.files || [])].forEach(f => addFile(f)); e.currentTarget.value = ""; }} />
      </label>
    </div>
  );
}

function Annotator({ art, runId, comments, onAdd, onDelete, onEdit, onReply }: { art: Art; runId: string; comments: Cmt[]; onAdd: (anchor: any, body: string, images?: string[]) => void; onDelete: (id: string) => void; onEdit: (id: string, body: string) => void; onReply: (parent: Cmt, body: string) => void }) {
  if (art.kind === "video") return <VideoCommenter art={art} runId={runId} comments={comments} onAdd={onAdd} onDelete={onDelete} onEdit={onEdit} />;
  if (art.kind === "html" || art.kind === "image") return <PinCommenter art={art} runId={runId} comments={comments} onAdd={onAdd} onDelete={onDelete} onEdit={onEdit} onReply={onReply} />;
  return <DocCommenter art={art} runId={runId} comments={comments} onAdd={onAdd} onDelete={onDelete} onEdit={onEdit} onReply={onReply} />;
}

// pins on a mock or screenshot
function PinCommenter({ art, runId, comments, onAdd, onDelete, onEdit, onReply }: { art: Art; runId: string; comments: Cmt[]; onAdd: (anchor: any, body: string, images?: string[]) => void; onDelete: (id: string) => void; onEdit: (id: string, body: string) => void; onReply: (parent: Cmt, body: string) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const [openPin, setOpenPin] = useState<string | null>(null);
  const pins = comments.filter(c => anchorOf(c).type === "pin");
  const fileUrl = `/api/runs/${runId}/file?p=${encodeURIComponent(art.body)}`;
  useEffect(() => { if (!mode) { setDraft(null); setText(""); } }, [mode]);
  function place(e: MouseEvent) {
    if (!mode || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setDraft({ x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) });
    setText(""); setOpenPin(null);
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--rule)", alignItems: "center" }}>
        <button className="btn" onClick={() => setMode(m => !m)} style={{ background: mode ? "var(--brand)" : "var(--surface)", color: mode ? "#fff" : "var(--ink-soft)", borderColor: mode ? "var(--brand)" : "var(--rule)" }}>{mode ? "✓ Click to pin a comment" : "📌 Comment on this"}</button>
        {pins.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{pins.length} comment{pins.length > 1 ? "s" : ""}</span>}
      </div>
      <div ref={boxRef} onClick={place} style={{ position: "relative", height: 540, background: art.kind === "image" ? "#1a1814" : "#fff", cursor: mode ? "crosshair" : "default" }}>
        {art.kind === "html"
          ? <iframe srcDoc={art.body} sandbox="allow-scripts allow-same-origin" style={{ width: "100%", height: "100%", border: "none", background: "#fff", pointerEvents: mode ? "none" : "auto" }} title={art.name} />
          : <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", pointerEvents: "none" }}><img src={fileUrl} alt={art.name} style={{ maxWidth: "100%", maxHeight: "100%" }} /></div>}
        {pins.map((c, i) => { const a = anchorOf(c); return (
          <button key={c.id} onClick={e => { e.stopPropagation(); setOpenPin(p => p === c.id ? null : c.id); setDraft(null); }} title={c.body}
            style={{ position: "absolute", left: `${a.x}%`, top: `${a.y}%`, transform: "translate(-50%,-50%)", zIndex: 3, width: 22, height: 22, borderRadius: 999, border: "2px solid #fff", cursor: "pointer", background: c.status === "sent" ? "var(--ink-dim)" : "var(--brand)", color: "#fff", fontSize: 11, fontWeight: 700, boxShadow: "0 1px 4px rgba(0,0,0,.35)" }}>{i + 1}</button>
        ); })}
        {openPin && (() => { const c = pins.find(p => p.id === openPin); if (!c) return null; const a = anchorOf(c);
          return <div style={{ position: "absolute", left: `min(${a.x}%, calc(100% - 250px))`, top: `calc(${a.y}% + 16px)`, zIndex: 4, width: 240, background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: 10, padding: 12, boxShadow: "0 6px 24px rgba(0,0,0,.18)" }}>
            <div style={{ display: "flex", fontSize: 13 }}><EditableBody c={c} onEdit={onEdit} onDelete={(id) => { onDelete(id); setOpenPin(null); }} /></div>
            <div style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 11 }}>{c.status === "sent" ? "✓ executed by Conductor" : "open"}</span></div>
          </div>; })()}
        {draft && <Composer x={draft.x} y={draft.y} onCancel={() => { setDraft(null); setText(""); }} text={text} setText={setText}
          onSubmit={(images) => { onAdd({ type: "pin", x: draft.x, y: draft.y }, text.trim(), images); setDraft(null); setText(""); setMode(false); }} />}
        {mode && !draft && pins.length === 0 && <div style={{ position: "absolute", top: 8, left: 8, zIndex: 2, background: "var(--brand)", color: "#fff", fontSize: 11.5, padding: "4px 9px", borderRadius: 7, pointerEvents: "none" }}>Click anywhere to pin a comment</div>}
      </div>
      <CommentList comments={comments} onDelete={onDelete} onEdit={onEdit} onReply={onReply} />
    </div>
  );
}

function Composer({ x, y, text, setText, onSubmit, onCancel }: { x: number; y: number; text: string; setText: (s: string) => void; onSubmit: (images: string[]) => void; onCancel: () => void }) {
  const att = useImageAttach();
  const go = () => { onSubmit(att.images); att.reset(); };
  return (
    <div onClick={e => e.stopPropagation()} style={{ position: "absolute", left: `min(${x}%, calc(100% - 260px))`, top: `calc(${y}% + 16px)`, zIndex: 5, width: 250, background: "var(--surface)", border: "1px solid var(--brand)", borderRadius: 10, padding: 12, boxShadow: "0 6px 24px rgba(0,0,0,.22)" }}>
      <textarea autoFocus className="input" onPaste={att.onPaste} style={{ width: "100%", minHeight: 64, fontSize: 12.5 }} placeholder="What should change here? (paste/attach images too)" value={text}
        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (text.trim() || att.images.length)) go(); }} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        <button className="btn btn-run" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!text.trim() && !att.images.length} onClick={go}>Comment</button>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onCancel}>Cancel</button>
        <ImageBar images={att.images} addFile={att.addFile} removeAt={att.removeAt} />
      </div>
    </div>
  );
}

// comment at a timestamp on the QA video
function VideoCommenter({ art, runId, comments, onAdd, onDelete, onEdit }: { art: Art; runId: string; comments: Cmt[]; onAdd: (anchor: any, body: string, images?: string[]) => void; onDelete: (id: string) => void; onEdit: (id: string, body: string) => void }) {
  const vref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  const att = useImageAttach();
  const vids = comments.filter(c => anchorOf(c).type === "video").sort((a, b) => anchorOf(a).t - anchorOf(b).t);
  const fileUrl = `/api/runs/${runId}/file?p=${encodeURIComponent(art.body)}`;
  const seek = (to: number) => { if (vref.current) { vref.current.currentTime = to; vref.current.pause(); setT(to); } };
  return (
    <div>
      <div style={{ background: "#1a1814", display: "grid", placeItems: "center", padding: 12 }}>
        <video ref={vref} src={fileUrl} controls playsInline onTimeUpdate={e => setT(e.currentTarget.currentTime)} onLoadedMetadata={e => setDur(e.currentTarget.duration || 0)} style={{ maxWidth: "100%", maxHeight: 540, borderRadius: 6 }} />
      </div>
      {/* timeline with comment markers */}
      <div style={{ padding: "10px 14px 4px" }}>
        <div style={{ position: "relative", height: 8, background: "var(--rule-soft)", borderRadius: 4 }}>
          <div style={{ position: "absolute", left: 0, height: 8, width: `${dur ? (t / dur) * 100 : 0}%`, background: "var(--brand)", borderRadius: 4 }} />
          {vids.map(c => { const a = anchorOf(c); return <button key={c.id} title={c.body} onClick={() => seek(a.t)}
            style={{ position: "absolute", left: `${dur ? (a.t / dur) * 100 : 0}%`, top: -4, transform: "translateX(-50%)", width: 12, height: 12, borderRadius: "50% 50% 50% 2px", border: "1.5px solid #fff", background: c.status === "sent" ? "var(--ink-dim)" : "var(--warning)", cursor: "pointer" }} />; })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, alignItems: "center" }}>
          <span className="mono muted" style={{ fontSize: 11 }}>{fmtClock(t)} / {fmtClock(dur)}</span>
          {!composing
            ? <button className="btn" style={{ padding: "3px 10px", fontSize: 11.5 }} onClick={() => { if (vref.current) vref.current.pause(); setComposing(true); }}>💬 Comment at {fmtClock(t)}</button>
            : null}
        </div>
        {composing && (
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <span className="mono pill" style={{ background: "var(--warning-tint)", color: "var(--warning)", alignSelf: "flex-start" }}>{fmtClock(t)}</span>
            <textarea autoFocus className="input" onPaste={att.onPaste} style={{ flex: 1, minHeight: 44, fontSize: 12.5 }} placeholder="What happens here? (paste/attach images too)" value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (text.trim() || att.images.length)) { onAdd({ type: "video", t }, text.trim(), att.images); setText(""); att.reset(); setComposing(false); } }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
              <button className="btn btn-run" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!text.trim() && !att.images.length} onClick={() => { onAdd({ type: "video", t }, text.trim(), att.images); setText(""); att.reset(); setComposing(false); }}>Add</button>
              <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { setText(""); att.reset(); setComposing(false); }}>Cancel</button>
              <ImageBar images={att.images} addFile={att.addFile} removeAt={att.removeAt} />
            </div>
          </div>
        )}
      </div>
      {vids.length > 0 && (
        <div style={{ borderTop: "1px solid var(--rule)", padding: "8px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
          {vids.map(c => { const a = anchorOf(c); return (
            <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5 }}>
              <button className="mono pill" style={{ background: "var(--warning-tint)", color: "var(--warning)", border: "none", cursor: "pointer" }} onClick={() => seek(a.t)}>{fmtClock(a.t)}</button>
              <EditableBody c={c} onEdit={onEdit} onDelete={onDelete} />
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

// a note on a spec/PRD/doc — a single whole-artifact comment via the button. (Text-selection /
// highlight-to-comment was removed: live <mark> DOM mutation over the rendered doc fought React
// and caused major issues. Mocks/images still get pinned comments via PinCommenter; legacy
// text-anchored comments still render in the list below.)
function DocCommenter({ art, runId, comments, onAdd, onDelete, onEdit, onReply }: { art: Art; runId: string; comments: Cmt[]; onAdd: (anchor: any, body: string, images?: string[]) => void; onDelete: (id: string) => void; onEdit: (id: string, body: string) => void; onReply: (parent: Cmt, body: string) => void }) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const att = useImageAttach();
  function submit() {
    if (!text.trim() && !att.images.length) return;
    onAdd({ type: "note" }, text.trim(), att.images);
    setComposing(false); setText(""); att.reset();
  }
  return (
    <div>
      <ArtifactView art={art} runId={runId} />
      <div style={{ borderTop: "1px solid var(--rule)", padding: "10px 14px" }}>
        {composing ? (
          <div style={{ display: "flex", gap: 6 }}>
            <textarea autoFocus className="input" onPaste={att.onPaste} style={{ flex: 1, minHeight: 44, fontSize: 12.5 }} placeholder={`A note on ${art.name}… (paste or attach images)`} value={text}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
              <button className="btn btn-run" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!text.trim() && !att.images.length} onClick={submit}>Add</button>
              <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { setComposing(false); setText(""); att.reset(); }}>Cancel</button>
              <ImageBar images={att.images} addFile={att.addFile} removeAt={att.removeAt} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" style={{ padding: "4px 11px", fontSize: 12.5 }} onClick={() => { setComposing(true); setText(""); }}>💬 Comment on {art.name}</button>
          </div>
        )}
        <CommentList comments={comments} onDelete={onDelete} onEdit={onEdit} onReply={onReply} />
      </div>
    </div>
  );
}

// A comment's text with inline Edit / Delete (open comments only). Shared by the
// pin popover, the video list, and the comment list so editing works everywhere.
function EditableBody({ c, onEdit, onDelete }: { c: Cmt; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  if (editing) return (
    <div onClick={e => e.stopPropagation()} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
      <textarea className="input" autoFocus value={draft} onChange={e => setDraft(e.target.value)} onFocus={e => e.target.select()} style={{ minHeight: 56, fontSize: 12.5 }} />
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-primary" style={{ padding: "3px 10px", fontSize: 11.5 }} onClick={e => { e.stopPropagation(); if (draft.trim()) onEdit(c.id, draft.trim()); setEditing(false); }}>Save</button>
        <button className="btn" style={{ padding: "3px 9px", fontSize: 11.5 }} onClick={e => { e.stopPropagation(); setDraft(c.body); setEditing(false); }}>Cancel</button>
      </div>
    </div>
  );
  return (
    <div style={{ flex: 1, display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {c.body && <MentionBody text={c.body} />}
        {imagesOf(c).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: c.body ? 5 : 0 }}>{imagesOf(c).map((img, i) => <a key={i} href={img} target="_blank" rel="noreferrer"><img src={img} alt="" style={{ maxHeight: 90, maxWidth: 150, borderRadius: 6, border: "1px solid var(--rule)" }} /></a>)}</div>}
      </div>
      {c.status === "open" && <span style={{ flex: "0 0 auto", display: "flex", gap: 4 }}>
        <button className="btn" style={{ padding: "1px 7px", fontSize: 11 }} onClick={e => { e.stopPropagation(); setDraft(c.body); setEditing(true); }}>Edit</button>
        <button className="btn" style={{ padding: "1px 7px", fontSize: 11 }} onClick={e => { e.stopPropagation(); onDelete(c.id); }}>✕</button>
      </span>}
    </div>
  );
}

// A single inline reply composer (collapsed to a "Reply" link until opened).
function ReplyBox({ onReply }: { onReply: (body: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) { onReply(text.trim()); setText(""); setOpen(false); } };
  if (!open) return <button className="btn" style={{ padding: "1px 8px", fontSize: 10.5, alignSelf: "flex-start" }} onClick={e => { e.stopPropagation(); setOpen(true); }}>↩ Reply</button>;
  return (
    <div onClick={e => e.stopPropagation()} style={{ display: "flex", gap: 6, marginTop: 2 }}>
      <textarea className="input" autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="Reply… (@name to mention · ⌘↵ to send)"
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } }}
        style={{ minHeight: 34, fontSize: 12, flex: 1 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <button className="btn btn-primary" style={{ padding: "2px 9px", fontSize: 11 }} onClick={send}>Reply</button>
        <button className="btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => { setText(""); setOpen(false); }}>✕</button>
      </div>
    </div>
  );
}

// Author byline shown above a comment/reply body.
function Byline({ c, badge }: { c: Cmt; badge?: ReactNode }) {
  const author = c.author || "Someone";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
      {badge}
      <Avatar name={author} size={18} />
      <span style={{ fontWeight: 600, fontSize: 12 }}>{author}</span>
      <span className="muted" style={{ fontSize: 10.5 }}>{timeAgo(c.created_at)}</span>
      {c.status === "sent" && <span className="muted" style={{ fontSize: 10 }}>· sent to the Conductor</span>}
    </div>
  );
}

function CommentList({ comments, onDelete, onEdit, onReply }: { comments: Cmt[]; onDelete: (id: string) => void; onEdit: (id: string, body: string) => void; onReply: (parent: Cmt, body: string) => void }) {
  const isNote = (c: Cmt) => ["note", "pin", "text"].includes(anchorOf(c).type);
  const tops = comments.filter(c => !c.parent_id && isNote(c));
  const repliesOf = (id: string) => comments.filter(c => c.parent_id === id).sort((a, b) => a.created_at - b.created_at);
  if (tops.length === 0) return null;
  return (
    <div style={{ borderTop: "1px solid var(--rule)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      {tops.map((c, i) => { const a = anchorOf(c); const replies = repliesOf(c.id);
        return (
          <div key={c.id} style={{ fontSize: 12.5 }}>
            <Byline c={c} badge={a.type === "pin" ? <span style={{ flex: "0 0 auto", width: 18, height: 18, borderRadius: 999, background: c.status === "sent" ? "var(--ink-dim)" : "var(--brand)", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center" }}>{i + 1}</span> : undefined} />
            {a.type === "text" && a.quote && <div style={{ fontSize: 11.5, color: "var(--ink-dim)", borderLeft: "2px solid var(--rule)", paddingLeft: 8, marginBottom: 3, fontStyle: "italic" }}>“{a.quote.slice(0, 120)}{a.quote.length > 120 ? "…" : ""}”</div>}
            <EditableBody c={c} onEdit={onEdit} onDelete={onDelete} />
            {(replies.length > 0 || true) && (
              <div style={{ marginTop: 7, marginLeft: 9, paddingLeft: 11, borderLeft: "2px solid var(--rule)", display: "flex", flexDirection: "column", gap: 9 }}>
                {replies.map(r => (
                  <div key={r.id}>
                    <Byline c={r} />
                    <EditableBody c={r} onEdit={onEdit} onDelete={onDelete} />
                  </div>
                ))}
                <ReplyBox onReply={(body) => onReply(c, body)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function looksBinary(s: string): boolean {
  if (!s) return false;
  if (/PNG\r?\n|GIF8|JFIF|�PNG/.test(s.slice(0, 12))) return true; // image bytes read as text
  return (s.slice(0, 400).match(/�/g) || []).length > 12;
}

// ——— Run-level Downloads: files an agent RETURNED via return_file ———
function mimeIcon(mime: string): string {
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("csv")) return "📄";
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("compress") || mime.includes("gzip")) return "🗜";
  if (mime.includes("pdf")) return "📕";
  return "📦";
}

function ArtifactView({ art, runId }: { art: Art; runId: string }) {
  const fileUrl = `/api/runs/${runId}/file?p=${encodeURIComponent(art.body)}`;
  if ((art.kind === "markdown" || art.kind === "text" || art.kind === "json") && looksBinary(art.body))
    return <div style={{ padding: 22, color: "var(--ink-dim)", fontSize: 13, lineHeight: 1.6 }}>📷 This looks like an image the agent saved as text, so it can’t be rendered here.<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Re-running the phase now produces a proper image deliverable.</div></div>;
  if (art.kind === "html")
    return <iframe srcDoc={art.body} sandbox="allow-scripts allow-same-origin" style={{ width: "100%", height: 540, border: "none", background: "#fff" }} title={art.name} />;
  if (art.kind === "image")
    return <div style={{ background: "#1a1814", display: "grid", placeItems: "center", padding: 12 }}><img src={fileUrl} alt={art.name} style={{ maxWidth: "100%", maxHeight: 540, borderRadius: 6 }} /></div>;
  if (art.kind === "video")
    return <div style={{ background: "#1a1814", display: "grid", placeItems: "center", padding: 12 }}><video src={fileUrl} controls autoPlay loop muted playsInline style={{ maxWidth: "100%", maxHeight: 560, borderRadius: 6 }} /></div>;
  if (art.kind === "file") {
    const fname = art.body.split("/").pop() || art.name;
    return <div style={{ padding: 28, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
      <div style={{ fontSize: 13.5, color: "var(--ink-soft)", display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 18 }}>📦</span><span className="mono">{fname}</span></div>
      <a href={fileUrl} download={fname} className="btn btn-run" style={{ textDecoration: "none", fontSize: 13.5 }}>⬇ Download {fname}</a>
    </div>;
  }
  if (art.kind === "json") {
    let pretty = art.body; try { pretty = JSON.stringify(JSON.parse(art.body), null, 2); } catch {}
    return <pre className="mono" style={{ margin: 0, padding: 16, overflow: "auto", fontSize: 12, maxHeight: 540 }}>{pretty}</pre>;
  }
  if (art.kind === "markdown") return <div style={{ padding: 22, maxHeight: 580, overflow: "auto" }}><Markdown>{art.body}</Markdown></div>;
  return <pre style={{ margin: 0, padding: 16, whiteSpace: "pre-wrap", maxHeight: 540, overflow: "auto" }}>{art.body}</pre>;
}

// ——— timeline grouping — moved to components/RawActivityLog (shared with the Live view). ———

// ——— History: the state-machine narrative (phase moves + decisions), separate from
// the raw agent Activity. Each phase-entry can be rewound to (mode-aware). ———
function HistoryView({ items, comments, machine, run, busy, onRerun, focusTs }: { items: Item[]; comments: Cmt[]; machine: Machine; run: Run; busy: boolean; onRerun: (idx: number, stateId: string, name: string) => void; focusTs?: number | null }) {
  const KEEP = new Set(["enter", "approved", "reject", "feedback", "done", "error"]);
  const kept = items.filter(it => KEEP.has(it.t));
  // collapse consecutive re-entries of the same phase (agent re-kicks) into one line
  const milestones = kept.filter((it, i) => !(it.t === "enter" && kept[i - 1] && kept[i - 1].t === "enter" && kept[i - 1].state === it.state));
  const idxOf = (sid: string) => machine.states.findIndex(s => s.id === sid);
  // Mark which phase the run is on RIGHT NOW (the latest entry into the current phase).
  const curId = machine.states[run.state_index]?.id;
  const liveStatus = run.status === "running" ? "● working now" : run.status === "awaiting_approval" ? "● waiting for you" : run.status === "paused" ? "● paused" : null;
  const activeEnterTs = liveStatus ? milestones.filter(it => it.t === "enter" && it.state === curId).slice(-1)[0]?.ts : undefined;
  const [openRow, setOpenRow] = useState<number | null>(null);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [hiTs, setHiTs] = useState<number | null>(null);
  // For an "Entered X" row, the agent's actions during that phase = items in [thisEnter, nextEnter)
  // with that state — so unfurling a phase shows what actually happened in it.
  const phaseActivity = (enterTs: number, stateId: string) => {
    const next = milestones.find(m => m.t === "enter" && m.ts > enterTs);
    const end = next ? next.ts : Infinity;
    return items.filter(x => x.ts >= enterTs && x.ts < end && x.state === stateId && (x.t === "say" || x.t === "tool_call" || x.t === "artifact" || x.t === "deliverable"));
  };
  // Weave YOUR comments into the phase timeline, in time order, so the feedback you left
  // shows up next to the phase it was about.
  type Row = { ts: number } & ({ kind: "m"; it: Item } | { kind: "c"; c: Cmt });
  const rows: Row[] = [
    ...milestones.map(it => ({ ts: it.ts, kind: "m" as const, it })),
    ...comments.map(c => ({ ts: c.created_at, kind: "c" as const, c })),
  ].sort((a, b) => a.ts - b.ts);
  const stamp = (ts: number) => <span className="mono muted" style={{ flex: "0 0 auto", minWidth: 104, fontSize: 10.5, opacity: 0.6 }}>{new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>;
  // When asked to focus an iteration (from the deliverables panel), scroll its "Entered X"
  // row into view and flash it, so the user lands on the loop that started that run.
  useEffect(() => {
    if (focusTs == null) return;
    let idx = rows.findIndex(r => r.kind === "m" && r.it.t === "enter" && r.it.ts === focusTs);
    if (idx < 0) idx = rows.findIndex(r => r.ts >= focusTs);
    const el = idx >= 0 ? rowRefs.current[idx] : null;
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHiTs(focusTs);
    const t = setTimeout(() => setHiTs(null), 2400);
    return () => clearTimeout(t);
  }, [focusTs]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ maxHeight: 440, overflow: "auto", padding: "6px 14px 10px", fontSize: 13 }}>
      {rows.length === 0 && <span className="muted" style={{ display: "block", padding: 12 }}>Nothing yet.</span>}
      {rows.map((row, i) => {
        if (row.kind === "c") {
          const c = row.c; const imgs = imagesOf(c);
          const where = c.artifact_name || machine.states.find(s => s.id === c.state)?.name || c.state;
          return (
            <div key={i} ref={el => { rowRefs.current[i] = el; }} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 8px", margin: "2px 0", borderRadius: 7, background: "var(--brand-tint)", border: "1px solid #eccabf" }}>
              {stamp(row.ts)}
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: "var(--brand)", fontWeight: 600 }}>💬 You</span>
                <span className="muted" style={{ fontSize: 11.5 }}> on {where}{c.status === "sent" ? " · sent to the agent" : ""}</span>
                {c.body && <div style={{ marginTop: 2, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{c.body}</div>}
                {imgs.length > 0 && <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>{imgs.slice(0, 4).map((im, j) => <img key={j} src={im} alt="" style={{ height: 42, borderRadius: 4, border: "1px solid var(--rule)" }} />)}</div>}
              </div>
            </div>
          );
        }
        const it = row.it;
        const stateName = machine.states.find(s => s.id === it.state)?.name || it.state;
        const idx = idxOf(it.state);
        const canGo = it.t === "enter" && idx >= 0 && !(idx === run.state_index && run.status !== "done"); // any visited phase except the one you're already on
        const isActive = it.t === "enter" && it.ts === activeEnterTs;
        const msg = (it as any).message as string | undefined;
        const expandable = it.t === "enter" || (!!msg && (it.t === "reject" || it.t === "feedback" || it.t === "approved" || it.t === "done" || it.t === "error"));
        const isOpen = openRow === i;
        const focused = hiTs != null && it.t === "enter" && it.ts === hiTs;
        return (
          <div key={i} ref={el => { rowRefs.current[i] = el; }}>
            <div style={isActive || focused
              ? { display: "flex", gap: 10, alignItems: "center", padding: "7px 8px", borderRadius: 7, background: "var(--brand-tint)", border: `1px solid ${focused ? "var(--warning)" : "var(--brand)"}`, boxShadow: focused ? "0 0 0 3px var(--warning-tint)" : undefined }
              : { display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--rule)" }}>
              {stamp(row.ts)}
              <div onClick={() => expandable && setOpenRow(isOpen ? null : i)} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: expandable ? "pointer" : "default" }}>
                {expandable && <span className="muted" style={{ fontSize: 10, marginRight: 5 }}>{isOpen ? "▾" : "▸"}</span>}
                <HistoryRow it={it} stateName={stateName} />
                {isActive && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--brand)", fontWeight: 600 }}>{liveStatus}</span>}
                {isActive && run.status === "running" && <span className="spin" style={{ marginLeft: 6 }} />}
              </div>
              {canGo && (() => {
                const open = comments.filter(c => c.state === it.state && c.status === "open").length;
                return <button className="btn" disabled={busy} style={{ flex: "0 0 auto", padding: "2px 9px", fontSize: 11 }}
                  onClick={() => onRerun(idx, it.state, stateName)} title={`Send ${stateName} back to re-run — add instructions it will address (revises the existing deliverable), or just rewind`}>↩ Re-run…{open > 0 ? ` · 💬${open}` : ""}</button>;
              })()}
            </div>
            {isOpen && (
              <div style={{ margin: "3px 0 9px 114px", padding: "9px 12px", background: "var(--surface-2)", borderRadius: 7, fontSize: 12.5 }}>
                {it.t === "enter"
                  ? (() => {
                      const acts = phaseActivity(it.ts, it.state);
                      if (!acts.length) return <span className="muted">No recorded activity for this phase.</span>;
                      return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {acts.slice(-30).map((a, j) => <div key={j} style={{ fontSize: 11.5, color: "var(--ink-soft)" }} className={a.t === "say" ? "" : "mono"}>
                          {a.t === "artifact" ? `📄 ${a.name}` : a.t === "tool_call" ? toolLine(a.name, a.args) : a.t === "say" ? `💭 ${a.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}
                        </div>)}
                      </div>;
                    })()
                  : <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{msg}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryRow({ it, stateName }: { it: Item; stateName: string }) {
  if (it.t === "enter") return <span style={{ color: "var(--brand)", fontWeight: 600 }}>▶ Entered {it.name}</span>;
  if (it.t === "approved") return <span><span style={{ color: "var(--success)" }}>✓ {stateName} approved</span>{it.message ? <span className="muted"> · {it.message}</span> : null}</span>;
  if (it.t === "reject") return <span style={{ color: "var(--danger)" }}>↩ {stateName} sent back<span className="muted"> · {it.message}</span></span>;
  if (it.t === "feedback") return <span style={{ color: "var(--warning)" }}>↻ Changes on {stateName}<span className="muted"> · {it.message}</span></span>;
  if (it.t === "done") return <span style={{ color: "var(--success)" }}>● {it.message}</span>;
  if (it.t === "error") return <span style={{ color: "var(--danger)" }}>✕ {it.message}</span>;
  return <span className="muted">{stateName}</span>;
}
