"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusChip, timeAgo } from "./components/ui";
import { useSimpleMode } from "./components/SimpleMode";
import { SimpleHome } from "./components/SimpleHome";
import { PRIMARY_MODELS, VISION_MODELS, isMultimodalPrimary } from "./lib/engine/models";

interface Run { id: string; title: string; status: string; created_at: number; updated_at: number; machine_id: string; repo_path: string | null; primary_model: string | null; state_index: number; pr_url?: string | null }
interface MachineMode { id: string; label: string; icon?: string; hint?: string; default?: boolean }
interface Machine { id: string; name: string; states: { id: string; name: string; gate?: boolean; optional?: boolean; watchable?: { label: string; icon?: string; note?: string } }[]; settings?: { modes?: MachineMode[]; principles?: { id: string; text: string }[]; selfLearn?: boolean } }
interface Project { id: string; name: string; repoPath: string; baseBranch: string; note?: string }

// shared sizing so every toolbar control is the same height (no more ragged buttons)
const TB = { height: 36, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", whiteSpace: "nowrap", boxSizing: "border-box" } as const;

// A short, human label for a loop in menus: drop the "— … / (…)" descriptive tail,
// and title-case kebab/snake workflow names (qa-recording → QA Recording). Works for
// current loops, AI-generated ones, and imported workflows alike.
const ACRONYMS = new Set(["qa", "pr", "api", "ui", "ux", "sdlc", "id", "prd", "ai", "seo", "db", "cli", "json", "yaml", "css", "html", "url"]);
function loopLabel(name: string): string {
  const s = (name || "").split("—")[0].split("(")[0].trim();
  if (!s) return "Loop";
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(s)) {
    return s.split(/[-_]/).map(w => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  }
  return s;
}

// Model rosters live in the single source of truth (app/lib/engine/models.ts).
const PRIMARY = PRIMARY_MODELS;
const VISION = VISION_MODELS;
const EXAMPLE = `Add a "task board" to the app. People can create tasks, drag them between columns (To do / In progress / Done), filter by tag, and mark a task complete. Tasks persist across reloads. Dragging a card updates its status immediately, and the board matches the app's existing look. It should be easy to see, at a glance, what's in each column.`;

export default function Home() {
  const router = useRouter();
  const { simple } = useSimpleMode();
  const [runs, setRuns] = useState<Run[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(""); // set to the first available project once loaded
  const [machineId, setMachineId] = useState("");
  const [skipSteps, setSkipSteps] = useState<string[]>([]); // state ids the human chose to skip (optional phases)
  const [primary, setPrimary] = useState("ollama:glm-5.2:cloud");
  const [vision, setVision] = useState("ollama:kimi-k2.6");
  const [gateMode, setGateMode] = useState<"all" | "machine" | "none">("none"); // default fully hands-off; the human can dial it back
  const [mode, setMode] = useState<string>(""); // "" = the selected machine's default mode
  const [applyPrinciples, setApplyPrinciples] = useState(true); // self-learning: apply this loop's learned principles to the run
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [reaping, setReaping] = useState(false);
  const [reapMsg, setReapMsg] = useState("");
  const [gearOpen, setGearOpen] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  // "+ Add new repo…" → opens a folder-picker panel (tap-to-browse on mobile,
  // native macOS dialog on desktop) that registers a folder as a project.
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoFlash, setRepoFlash] = useState(""); // transient "Initialized a new git repository" note
  const [view, setView] = useState<"feed" | "machine" | "columns">("feed");
  const [showArchived, setShowArchived] = useState(false);
  const [archivedRuns, setArchivedRuns] = useState<Run[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [sortBy, setSortBy] = useState<"status" | "updated" | "created" | "name">("status");
  useEffect(() => { const v = localStorage.getItem("atelier.view"); if (v === "feed" || v === "machine" || v === "columns") setView(v);
    const s = localStorage.getItem("atelier.sort"); if (s === "status" || s === "updated" || s === "created" || s === "name") setSortBy(s); }, []);
  function pickView(v: "feed" | "machine" | "columns") { setView(v); localStorage.setItem("atelier.view", v); }
  function pickSort(s: "status" | "updated" | "created" | "name") { setSortBy(s); localStorage.setItem("atelier.sort", s); }

  // Reference images: attach via the file picker (multi-select) or paste with
  // ⌘V / Ctrl+V — add as many as you like; each is stored as a data URL.
  function addImageFile(file: File | null | undefined) {
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setImages(prev => [...prev, String(reader.result)]);
    reader.readAsDataURL(file);
  }
  function onPasteImages(e: { clipboardData: DataTransfer | null; preventDefault(): void }) {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
    if (items.length) { e.preventDefault(); items.forEach(it => addImageFile(it.getAsFile())); }
  }
  const removeImageAt = (i: number) => setImages(prev => prev.filter((_, j) => j !== i));

  async function load() {
    const d = await (await fetch("/api/runs", { cache: "no-store" })).json();
    setRuns(d.runs); setMachines(d.machines); setProjects(d.projects || []);
    setArchivedCount(d.archivedCount || 0);
    setMachineId(m => m || d.machines[0]?.id || "");
    // Keep the picked repo valid for whoever's projects these are — default to the
    // first one (no hard-coded repo id), and recover if the selected one disappears.
    const projs: Project[] = d.projects || [];
    setProjectId(p => projs.some(x => x.id === p) ? p : (projs[0]?.id || ""));
  }
  async function loadArchived() {
    const d = await (await fetch("/api/runs?archived=1", { cache: "no-store" })).json();
    setArchivedRuns(d.runs || []); setArchivedCount(d.archivedCount || 0);
  }
  async function reap() {
    setReaping(true); setReapMsg("");
    try {
      const r = await fetch("/api/reap", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setReapMsg(d.total ? `🧹 Reaped ${d.total} — ${d.testDrives} browser, ${d.tracked} tracked, ${d.orphans} orphan${d.orphans === 1 ? "" : "s"}.` : "Nothing to reap — all clean.");
    } catch { setReapMsg("Couldn't reach the server."); }
    setReaping(false);
    setTimeout(() => setReapMsg(""), 6000);
  }
  async function archiveRun(id: string, archived: boolean) {
    await fetch(`/api/runs/${id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived }) });
    load(); if (showArchived) loadArchived();
  }
  // Re-check a run parked in a WATCHABLE terminal phase (e.g. Open PR) straight from the board:
  // re-runs that phase to bring it up to date. Generic — driven by the state's watchable flag.
  async function recheckRun(id: string, phase: number) {
    await fetch(`/api/runs/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recheck", phase }) });
    load();
  }
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, []); // eslint-disable-line
  useEffect(() => { if (showArchived) loadArchived(); }, [showArchived]); // eslint-disable-line

  async function submit() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    const d = await (await fetch("/api/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, title, projectId, machineId, primaryModel: primary, visionModel: vision, gateMode, mode, disabledSteps: skipSteps, applyPrinciples, images: images.length ? images : undefined }),
    })).json();
    setBusy(false);
    if (d.run) router.push(`/runs/${d.run.id}`);
  }

  // A repo was registered (via the folder browser, a typed path, or the native
  // macOS dialog): refresh the list and select it, then close the picker. `note`
  // surfaces a one-off confirmation (e.g. a fresh git repo was initialized).
  async function onRepoAdded(p: Project, note?: string) {
    await load();
    setProjectId(p.id);
    setAddRepoOpen(false);
    if (note) { setRepoFlash(note); setTimeout(() => setRepoFlash(""), 6000); }
  }
  // A loop's feed order — by status (in-flight → waiting → done → failed), or by a field.
  const RANK: Record<string, number> = { running: 0, queued: 0, idle: 0, awaiting_approval: 1, paused: 1, done: 2, failed: 3 };
  const SORTERS: Record<typeof sortBy, (a: Run, b: Run) => number> = {
    status: (a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4) || b.updated_at - a.updated_at,
    updated: (a, b) => b.updated_at - a.updated_at,
    created: (a, b) => b.created_at - a.created_at,
    name: (a, b) => a.title.localeCompare(b.title),
  };
  const feed = [...runs].sort(SORTERS[sortBy]);
  // STATUS columns (Kanban view).
  const STATUS_COLS: { key: string; label: string; statuses: string[]; color: string }[] = [
    { key: "active", label: "In progress", statuses: ["running", "queued", "idle"], color: "var(--brand)" },
    { key: "review", label: "Needs you", statuses: ["awaiting_approval", "paused"], color: "var(--warning)" },
    { key: "done", label: "Shipped", statuses: ["done"], color: "var(--success)" },
    { key: "failed", label: "Failed", statuses: ["failed"], color: "var(--danger)" },
  ];
  // MACHINE view: a loop's lane = the phase it's in (or Shipped / Failed), columns
  // ordered by the canonical machine's phase order.
  const stateName = (r: Run) => machines.find(m => m.id === r.machine_id)?.states[r.state_index]?.name || "—";
  const laneOf = (r: Run) => r.status === "done" ? "Shipped" : r.status === "failed" ? "Failed" : stateName(r);
  const canonNames = (machines.find(m => m.id === machineId)?.states || machines[0]?.states || []).map(s => s.name);
  const laneOrder = (l: string) => l === "Shipped" ? 900 : l === "Failed" ? 901 : (canonNames.indexOf(l) >= 0 ? canonNames.indexOf(l) : 800);
  const lanes = [...new Set(runs.map(laneOf))].sort((a, b) => laneOrder(a) - laneOrder(b));
  const machine = machines.find(m => m.id === machineId);
  const gatedNames = (machine?.states || []).filter((s: any) => s.gate).map(s => s.name);

  const proj = projects.find(p => p.id === projectId);
  // A multimodal primary can see images itself; a text-only one needs the vision helper.
  const visionNeeded = !isMultimodalPrimary(primary);

  // Simple mode: calm, mobile-first list of runs (the busy feed/columns board is Pro-only).
  if (simple) return <SimpleHome runs={runs} machines={machines} />;

  return (
    <div>
      <div className="flex flex-col gap-3.5 mb-[26px] sm:flex-row sm:items-end sm:gap-3.5">
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:flex-nowrap">
          {/* view switcher */}
          <div style={{ display: "flex", height: 36, border: "1px solid var(--rule)", borderRadius: 9, overflow: "hidden" }}>
            {([{ v: "feed", t: "≣ Feed" }, { v: "machine", t: "⇉ Loop" }, { v: "columns", t: "▦ Columns" }] as const).map(o => {
              const on = view === o.v;
              return <button key={o.v} onClick={() => pickView(o.v)} title={o.v === "feed" ? "A feed; each card shows its position in its loop" : o.v === "machine" ? "Cards grouped under the state they're in" : "Cards grouped by status"}
                style={{ border: "none", padding: "0 12px", fontSize: 12.5, cursor: "pointer", display: "inline-flex", alignItems: "center", background: on ? "var(--brand-tint)" : "var(--surface)", color: on ? "var(--brand)" : "var(--ink-dim)", fontWeight: on ? 600 : 500 }}>{o.t}</button>;
            })}
          </div>
          <button className="btn btn-run" onClick={() => setShowForm(s => !s)} style={{ ...TB, padding: "0 16px", fontSize: 13.5 }}>{showForm ? "✕ Close" : "＋ New loop"}</button>
          {/* quiet controls: sort, archive and maintenance all tuck behind the gear */}
          <div style={{ position: "relative", display: "inline-flex" }}>
            <button onClick={() => setGearOpen(o => !o)} title="Advanced / maintenance" aria-label="Advanced"
              style={{ height: 40, minWidth: 40, padding: "0 10px", marginLeft: 2, border: "none", background: "none", cursor: "pointer", fontSize: 17, lineHeight: 1, color: gearOpen ? "var(--brand)" : "var(--ink-dim)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>⚙</button>
            {gearOpen && <>
              <div onClick={() => setGearOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 25 }} />
              <div className="card card-pad" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 30, width: 252, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 6px 24px rgba(0,0,0,.14)" }}>
                {!showArchived && <>
                  <div className="label" style={{ fontSize: 10 }}>Sort by</div>
                  <select value={sortBy} onChange={e => pickSort(e.target.value as typeof sortBy)} title="Sort loops by"
                    style={{ ...TB, width: "100%", padding: "0 10px", borderRadius: 9, border: "1px solid var(--rule)", background: "var(--surface)", color: "var(--ink-soft)", cursor: "pointer" }}>
                    <option value="status">Status</option>
                    <option value="updated">Updated</option>
                    <option value="created">Created</option>
                    <option value="name">Name</option>
                  </select>
                </>}
                {(archivedCount > 0 || showArchived) && (
                  <button className="btn" onClick={() => { setShowArchived(s => !s); setGearOpen(false); }} title="Archived loops (hidden from the board)"
                    style={{ fontSize: 12.5, width: "100%", justifyContent: "flex-start", background: showArchived ? "var(--brand-tint)" : undefined, color: showArchived ? "var(--brand)" : undefined, borderColor: showArchived ? "var(--brand)" : undefined }}>
                    {showArchived ? "← Back to board" : `🗄 Archived ${archivedCount}`}
                  </button>
                )}
                <div className="label" style={{ fontSize: 10 }}>Advanced</div>
                <button className="btn" style={{ fontSize: 12.5, width: "100%", justifyContent: "flex-start" }} onClick={reap} disabled={reaping} title="Kill leftover dev servers + test-drive browsers (including orphans left by restarts). Never touches the factory's own server.">{reaping ? "Reaping…" : "🧹 Reap dev servers"}</button>
                {reapMsg && <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{reapMsg}</div>}
              </div>
            </>}
          </div>
        </div>
      </div>

      {!showArchived && feed.length === 0 && <div className="card card-pad muted">No loops yet — hit ＋ New loop to start one.</div>}

      {/* ARCHIVE — loops you've hidden from the board; restore any back */}
      {showArchived && (
        archivedRuns.length === 0
          ? <div className="card card-pad muted">No archived loops. Hover a loop card and hit 🗄 to archive it.</div>
          : <div className="feed">{archivedRuns.map(r => <LoopCard key={r.id} r={r} machines={machines} archived sortBy={sortBy} onArchive={archiveRun} />)}</div>
      )}

      {/* FEED — each loop shows its live position on its state machine */}
      {!showArchived && feed.length > 0 && view === "feed" && (
        <div className="feed">
          {feed.map(r => <LoopCard key={r.id} r={r} machines={machines} sortBy={sortBy} onArchive={archiveRun} onRecheck={recheckRun} />)}
        </div>
      )}

      {/* COLUMNS — grouped by status (Kanban). Phone: stack into one column (4 narrow
          columns blow out the page); sm+ restores the 4-across board. */}
      {!showArchived && feed.length > 0 && view === "columns" && (
        <div className="grid grid-cols-1 gap-4 items-start sm:grid-cols-4">
          {STATUS_COLS.map(col => {
            const cards = feed.filter(r => col.statuses.includes(r.status));
            return (
              <div key={col.key}>
                <div className="bcol-h"><span className="dot7" style={{ background: col.color }} /><span className="name">{col.label}</span><span className="cnt">{cards.length}</span></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 60 }}>
                  {cards.length === 0 && <div className="muted" style={{ fontSize: 12, padding: "8px 2px", opacity: 0.5 }}>Nothing here</div>}
                  {cards.map(r => <LoopCard key={r.id} r={r} machines={machines} compact sortBy={sortBy} onArchive={archiveRun} onRecheck={recheckRun} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* MACHINE — columns ARE the phases; loops sit under the state they're in */}
      {!showArchived && feed.length > 0 && view === "machine" && (
        <div style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(180px, 1fr)", gap: 14, alignItems: "start", overflowX: "auto", paddingBottom: 8 }}>
          {lanes.map(lane => {
            const cards = feed.filter(r => laneOf(r) === lane);
            const color = lane === "Shipped" ? "var(--success)" : lane === "Failed" ? "var(--danger)" : "var(--brand)";
            return (
              <div key={lane}>
                <div className="bcol-h"><span className="dot7" style={{ background: color }} /><span className="name">{lane}</span><span className="cnt">{cards.length}</span></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {cards.map(r => <LoopCard key={r.id} r={r} machines={machines} compact sortBy={sortBy} onArchive={archiveRun} onRecheck={recheckRun} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* new-ticket composer (toggled) */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,24,20,0.35)", display: "grid", placeItems: "start center", paddingTop: 70, zIndex: 50, overflow: "auto" }} onClick={() => setShowForm(false)}>
        <section className="card card-pad" style={{ width: 620, maxWidth: "92vw", marginBottom: 40 }} onClick={e => e.stopPropagation()} onPaste={onPasteImages}>
          <div className="label" style={{ marginBottom: 12 }}>New loop</div>

          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Repository</label>
              {projects.length === 0 ? (
                // First run: no repos yet. Give a RELIABLE, tappable entry to add one (a bare
                // <select> whose only option is "add" doesn't fire onChange when re-selected,
                // so a first-timer could get stuck). You can also just run in a scratch workspace.
                <div style={{ marginTop: 5 }}>
                  <button type="button" className="input" style={{ width: "100%", textAlign: "left", cursor: "pointer", color: "var(--brand)", fontWeight: 600 }} onClick={() => setAddRepoOpen(true)}>
                    ＋ Add a repository (choose or create a folder)
                  </button>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>No repos yet — pick or make a folder to build in. Or leave this and run in a scratch workspace.</div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
                  <select className="input" style={{ flex: 1 }} value={projectId}
                    onChange={e => { if (e.target.value === "__add__") setAddRepoOpen(true); else setProjectId(e.target.value); }}>
                    <option value="" disabled>Choose a repo…</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    <option value="__add__">＋ Add new repo (choose a folder)…</option>
                  </select>
                  <button type="button" className="btn" style={{ padding: "0 11px", whiteSpace: "nowrap" }} title="Add another repository" onClick={() => setAddRepoOpen(true)}>＋</button>
                </div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Loop</label>
              <select className="input" style={{ marginTop: 5 }} value={machineId} onChange={e => { setMachineId(e.target.value); setSkipSteps([]); }}>
                {machines.map(m => <option key={m.id} value={m.id}>{loopLabel(m.name)}</option>)}
              </select>
            </div>
          </div>
          {addRepoOpen && <AddRepoModal onClose={() => setAddRepoOpen(false)} onAdded={onRepoAdded} />}
          {repoFlash && <div style={{ color: "var(--success)", fontSize: 12, marginTop: -4, marginBottom: 8 }}>✓ {repoFlash}</div>}

          <div className="muted mono" style={{ fontSize: 11.5, marginTop: -4, marginBottom: 12 }}>
            {proj && <>{proj.repoPath} · base {proj.baseBranch}<br /></>}
            {machine && <>phases: {machine.states.map((s, i) => <span key={s.id}>{i > 0 && " → "}{s.name}{s.gate ? "⏸" : ""}</span>)}</>}
          </div>

          <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Title <span className="muted">(optional)</span></label>
          <input className="input" style={{ margin: "5px 0 12px" }} value={title} onChange={e => setTitle(e.target.value)} placeholder="task board" />

          <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Goal</label>
          <textarea className="input" style={{ margin: "5px 0 0", minHeight: 130 }} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should this loop achieve?" />

          {/* optional reference image(s) — file picker (multi) or ⌘V / Ctrl+V paste */}
          <div style={{ marginTop: 10 }}>
            {images.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                {images.map((img, i) => (
                  <span key={i} style={{ position: "relative", display: "inline-block" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img} alt={`reference ${i + 1}`} style={{ height: 56, borderRadius: 8, border: "1px solid var(--rule)", display: "block" }} />
                    <button onClick={() => removeImageAt(i)} title="Remove" style={{ position: "absolute", top: -7, right: -7, width: 18, height: 18, borderRadius: 999, border: "1px solid var(--rule)", background: "var(--surface)", cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
            <label className="dropz">
              ＋ {images.length ? "Add more images" : "Attach reference image(s)"} <span style={{ opacity: .7 }}>(mock, screenshot, diagram — multi-select or paste ⌘V — optional)</span>
              <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { [...(e.target.files || [])].forEach(f => addImageFile(f)); e.currentTarget.value = ""; }} />
            </label>
            {images.length > 0 && visionNeeded && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Your vision helper will describe {images.length === 1 ? "it" : `all ${images.length}`} for the agent.</div>}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Agent (drives the loop)</label>
              <select className="input" style={{ marginTop: 5 }} value={primary} onChange={e => setPrimary(e.target.value)}>
                {PRIMARY.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, opacity: visionNeeded ? 1 : 0.55 }}>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Vision/QA helper</label>
              <select className="input" style={{ marginTop: 5 }} value={vision} onChange={e => setVision(e.target.value)}>
                {VISION.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            {visionNeeded ? "This agent is text-only — it delegates visual judgment & QA to the helper." : "This agent is multimodal — it can handle visuals itself (helper still available)."}
          </div>

          <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, marginTop: 14, display: "block" }}>When to pause for you</label>
          <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
            {([
              { v: "all", label: "⏸ Review every step" },
              { v: "machine", label: "◐ Obey the loop" },
              { v: "none", label: "⏩ Auto-run" },
            ] as const).map(opt => {
              const on = gateMode === opt.v;
              return <button key={opt.v} onClick={() => setGateMode(opt.v)} className="btn" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, borderColor: on ? "var(--brand)" : "var(--rule)", background: on ? "var(--brand-tint)" : "var(--surface)", color: on ? "var(--brand)" : "var(--ink-soft)", fontWeight: on ? 600 : 500 }}>{opt.label}</button>;
            })}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            {gateMode === "all" && "Pauses at EVERY phase so you can review and Approve / comment."}
            {gateMode === "machine" && `Pauses only where this loop has a gate${gatedNames.length ? ` (${gatedNames.join(", ")})` : ""}; everything else flows.`}
            {gateMode === "none" && "Never pauses — runs straight through; Review/QA/Acceptance self-correct."}
          </div>

          {(() => {
            // Generic: the SELECTED machine declares its own run modes (settings.modes).
            // No modes ⇒ this whole block disappears. Nothing machine-specific is hardcoded.
            const modes = machine?.settings?.modes || [];
            if (!modes.length) return null;
            const effective = mode || (modes.find(m => m.default) || modes[0]).id;
            const cur = modes.find(m => m.id === effective);
            return <>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, marginTop: 14, display: "block" }}>Mode</label>
              <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
                {modes.map(opt => {
                  const on = effective === opt.id;
                  return <button key={opt.id} type="button" onClick={() => setMode(opt.id)} className="btn" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, borderColor: on ? "var(--brand)" : "var(--rule)", background: on ? "var(--brand-tint)" : "var(--surface)", color: on ? "var(--brand)" : "var(--ink-soft)", fontWeight: on ? 600 : 500 }}>{opt.icon ? opt.icon + " " : ""}{opt.label}</button>;
                })}
              </div>
              {cur?.hint && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{cur.hint}</div>}
            </>;
          })()}

          {(() => {
            // Self-learning opt-in per run: only when the SELECTED loop has self-learning on
            // (a loop-level setting). Driven by the loop's config.
            const learns = !!machine && machine.settings?.selfLearn === true;
            if (!learns) return null;
            const n = machine!.settings?.principles?.length || 0;
            return (
              <div style={{ marginTop: 14 }}>
                <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, display: "block" }}>🧠 Self-learning</label>
                <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
                  {([[true, "◉ Apply learned principles"], [false, "○ Run clean (ignore them)"]] as const).map(([v, label]) => {
                    const on = applyPrinciples === v;
                    return <button key={String(v)} type="button" onClick={() => setApplyPrinciples(v)} className="btn" style={{ flex: 1, justifyContent: "center", fontSize: 12.5, borderColor: on ? "var(--brand)" : "var(--rule)", background: on ? "var(--brand-tint)" : "var(--surface)", color: on ? "var(--brand)" : "var(--ink-soft)", fontWeight: on ? 600 : 500 }}>{label}</button>;
                  })}
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                  {applyPrinciples
                    ? `This run follows the ${n} principle${n === 1 ? "" : "s"} this loop learned from past feedback.`
                    : "This run ignores the loop's learned principles — a clean baseline."}
                </div>
              </div>
            );
          })()}

          {(() => {
            // Skippable phases are declared by the MACHINE (state.optional in the YAML) —
            // nothing hard-coded here. Render a toggle per optional phase; checked = skip
            // it on this run (its id goes to disabled_states; the driver skips it).
            const optional = (machine?.states || []).filter(s => s.optional);
            if (!optional.length) return null;
            return <>
              <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, marginTop: 14, display: "block" }}>Skip phases <span className="muted">(optional)</span></label>
              <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
                {optional.map(s => {
                  const off = skipSteps.includes(s.id);
                  return <button key={s.id} type="button"
                    onClick={() => setSkipSteps(prev => off ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                    title={off ? `${s.name} will be SKIPPED on this run` : `Click to skip ${s.name} on this run`}
                    className="btn" style={{ justifyContent: "center", fontSize: 12.5, border: `1px ${off ? "dashed" : "solid"} ${off ? "var(--warning)" : "var(--rule)"}`, background: off ? "var(--surface)" : "var(--surface)", color: off ? "var(--ink-dim)" : "var(--ink-soft)", fontWeight: off ? 600 : 500 }}>
                    {off ? "🚫 " : ""}{s.name} {off ? "— skipped" : "— run"}</button>;
                })}
              </div>
              {skipSteps.length > 0 && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Skipping {skipSteps.map(id => optional.find(s => s.id === id)?.name || id).join(", ")} on this run.</div>}
            </>;
          })()}

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
            <button className="btn btn-run" onClick={submit} disabled={busy || !goal.trim()} style={{ flex: 1, justifyContent: "center" }}>{busy ? "Starting…" : "▶ Run loop"}</button>
            <button className="btn" onClick={() => { setGoal(EXAMPLE); setTitle("task board"); if (!projectId && projects[0]) setProjectId(projects[0].id); }}>⤵ Example</button>
          </div>
        </section>
        </div>
      )}
    </div>
  );
}

function LoopCard({ r, machines, compact, archived, sortBy, onArchive, onRecheck }: { r: Run; machines: Machine[]; compact?: boolean; archived?: boolean; sortBy?: string; onArchive?: (id: string, archived: boolean) => void; onRecheck?: (id: string, phase: number) => void }) {
  const m = machines.find(x => x.id === r.machine_id);
  const states = m?.states || [];
  const idx = r.state_index;
  const cur = states[idx]?.name;
  const at = r.status === "done" ? "Done" : r.status === "failed" ? `Failed${cur ? ` · ${cur}` : ""}` : cur || "";
  const stop = (fn: () => void) => (e: { preventDefault(): void; stopPropagation(): void }) => { e.preventDefault(); e.stopPropagation(); fn(); };
  // A run parked in a WATCHABLE terminal phase (e.g. Open PR) can be re-checked from the board.
  // Generic: driven purely by that state's `watchable` flag — shown once the run has settled.
  const watchable = states[idx]?.watchable;
  const canRecheck = !!onRecheck && !!watchable && !archived && r.status !== "running" && r.status !== "queued";
  return (
    <Link href={`/runs/${r.id}`} className="card ticket" style={{ position: "relative" }}>
      {onArchive && (
        <button className={"archive-btn" + (archived ? " always" : "")} title={archived ? "Restore to the board" : "Archive (hide from the board)"}
          onClick={stop(() => onArchive(r.id, !archived))}>{archived ? "↩" : "🗄"}</button>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div className="ticket-title" style={{ minWidth: 0, fontSize: compact ? 14 : 15 }}>{r.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusChip status={r.status} />
          {!compact && at && r.status !== "done" && <span className="muted" style={{ fontSize: 12 }}>· {at}</span>}
          {r.status === "done" && r.pr_url && <span className="tag tag-green" style={{ fontSize: 10 }}>PR</span>}
          {canRecheck && (
            <button title={`${watchable!.label} — re-run ${states[idx]?.name} to bring it up to date`}
              onClick={stop(() => onRecheck!(r.id, idx))}
              style={{ border: "1px solid var(--rule)", background: "var(--surface)", cursor: "pointer", borderRadius: 7, padding: "1px 7px", fontSize: 11.5, lineHeight: 1.6, color: "var(--brand)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12 }}>{watchable!.icon || "🔄"}</span>{watchable!.label}
            </button>
          )}
        </div>
      </div>
      <div className="mrow" title={states.map(s => s.name).join(" → ")}>
        {states.map((s, i) => {
          const node = r.status === "done" ? "on" : r.status === "failed" ? (i < idx ? "on" : i === idx ? "fail" : "") : i < idx ? "on" : i === idx ? "cur" : "";
          const conn = r.status === "done" || i < idx ? "on" : "";
          return <span key={s.id} style={{ display: "contents" }}>
            <span className={`mnode ${node}`} />
            {i < states.length - 1 && <span className={`mconn ${r.status === "failed" && i >= idx ? "" : conn}`} />}
          </span>;
        })}
      </div>
      <div className="muted mono" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: .85 }}>
        {(r.repo_path || "scratch").split("/").pop()} · {sortBy === "updated" ? `updated ${timeAgo(r.updated_at)}` : timeAgo(r.created_at)}
      </div>
    </Link>
  );
}

interface FsEntry { name: string; path: string; hasGit: boolean }
interface FsList { path: string; home: string; parent: string | null; hereHasGit?: boolean; entries: FsEntry[]; error?: string }

// Add-repo picker that works on a PHONE. The old flow popped a native macOS
// `choose folder` dialog on the Mac (osascript) — invisible over Tailscale — so
// on mobile "nothing happened". This browses the Mac's folders via /api/fs/list
// (plain fetch + taps, no File System Access API), can make a NEW folder
// (/api/fs/mkdir), auto-inits git on non-repos so loops' `git worktree add`
// works (/api/fs/git-init), and keeps the native desktop dialog + a typed-path
// fallback. Registers via POST /api/projects.
function AddRepoModal({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project, note?: string) => void | Promise<void> }) {
  const [data, setData] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");
  const [creating, setCreating] = useState(false); // inline "new folder" input open?
  const [newName, setNewName] = useState("");

  async function browse(path?: string) {
    setLoading(true); setErr("");
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const d: FsList = await (await fetch(`/api/fs/list${qs}`, { cache: "no-store" })).json();
      if (d.error) setErr(d.error); else setData(d);
    } catch { setErr("Couldn't list folders on the Mac."); }
    finally { setLoading(false); }
  }
  useEffect(() => { browse(); }, []); // eslint-disable-line

  // Create a new folder in the current directory, then drill into it so the user
  // can immediately "Use this folder".
  async function makeFolder() {
    const name = newName.trim();
    if (!name || busy || !data) return;
    setBusy(true); setErr("");
    try {
      const d = await (await fetch("/api/fs/mkdir", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: data.path, name }),
      })).json();
      if (d.path) { setCreating(false); setNewName(""); await browse(d.path); }
      else setErr(d.error || "Could not create the folder.");
    } catch { setErr("Could not create the folder."); }
    finally { setBusy(false); }
  }

  // Use a folder as a repo: make it worktree-ready first (git init + empty commit
  // if it isn't already a git repo), THEN register it. A one-off note tells the
  // user when a fresh repo was initialized.
  async function useFolder(repoPath: string) {
    const p = (repoPath || "").trim();
    if (!p || busy) return;
    setBusy(true); setErr("");
    try {
      const gi = await (await fetch("/api/fs/git-init", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p }),
      })).json();
      if (gi.error) { setErr(gi.error); return; }
      const d = await (await fetch("/api/projects", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoPath: p }),
      })).json();
      if (d.project) await onAdded(d.project, gi.initialized ? "Initialized a new git repository." : undefined);
      else setErr(d.error || "Could not add that folder.");
    } catch { setErr("Could not add that folder."); }
    finally { setBusy(false); }
  }

  // Native macOS dialog — desktop convenience; opens on THIS Mac, not a phone.
  async function nativePicker() {
    if (busy) return;
    setBusy(true); setErr("");
    let picked: { canceled?: boolean; path?: string; error?: string };
    try {
      picked = await (await fetch("/api/projects/pick-folder", { method: "POST" })).json();
    } catch { setErr("Couldn't open the macOS dialog."); setBusy(false); return; }
    setBusy(false);
    if (picked.canceled) return;
    if (!picked.path) { setErr(picked.error || "Couldn't open the macOS dialog."); return; }
    await useFolder(picked.path);
  }

  const atHome = data ? data.parent === null : true;
  const here = data?.path || "";
  const hereName = here.split("/").filter(Boolean).pop() || here;
  const hereIsRepo = !!data?.hereHasGit;
  const rowBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "9px 11px", border: "1px solid var(--rule)", borderRadius: 9, background: "var(--surface)", color: "var(--ink)", cursor: "pointer", fontSize: 13.5, boxSizing: "border-box" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(26,24,20,0.45)", display: "grid", placeItems: "start center", paddingTop: 40, zIndex: 60, overflow: "auto" }}>
      <div className="card card-pad" onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: "94vw", marginBottom: 40, display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="label" style={{ flex: 1 }}>Add a repository</div>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, lineHeight: 1, color: "var(--ink-dim)", padding: 4 }}>✕</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: -6, lineHeight: 1.45 }}>Tap a folder to open it, then use it as the repo. It just has to be a folder on this Mac.</div>

        {/* current folder + up + new-folder */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" disabled={atHome || loading || busy} onClick={() => data?.parent && browse(data.parent)} title="Up one folder" style={{ padding: "0 11px", height: 34, flex: "0 0 auto" }}>⬆</button>
          <div className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink-soft)", background: "var(--surface-2)", border: "1px solid var(--rule-soft)", borderRadius: 8, padding: "8px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>{here || "…"}</div>
          <button className="btn" disabled={loading || busy} onClick={() => { setCreating(c => !c); setErr(""); }} title="Create a new folder here" style={{ padding: "0 11px", height: 34, flex: "0 0 auto", fontSize: 12.5, color: creating ? "var(--brand)" : undefined, borderColor: creating ? "var(--brand)" : undefined }}>＋ New</button>
        </div>

        {/* inline "new folder" input (iOS-friendly — no JS prompt()) */}
        {creating && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" autoFocus style={{ flex: 1, minWidth: 0, fontSize: 13 }} value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") makeFolder(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
              placeholder="new-folder-name" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button className="btn btn-run" disabled={busy || !newName.trim()} onClick={makeFolder} style={{ flex: "0 0 auto" }}>Create</button>
            <button className="btn" disabled={busy} onClick={() => { setCreating(false); setNewName(""); }} style={{ flex: "0 0 auto" }} aria-label="Cancel">✕</button>
          </div>
        )}

        {/* folder list */}
        <div style={{ maxHeight: "38vh", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--rule-soft)", borderRadius: 10, padding: 8, background: "var(--surface-2)" }}>
          {loading && <div className="muted" style={{ fontSize: 12.5, padding: "10px 4px" }}>Loading folders…</div>}
          {!loading && data?.entries.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: "10px 4px" }}>No sub-folders here — use this folder, or go up.</div>}
          {!loading && data?.entries.map(en => (
            <button key={en.path} onClick={() => browse(en.path)} disabled={busy} style={rowBtn}
              onMouseDown={e => e.preventDefault()}>
              <span style={{ fontSize: 15, flex: "0 0 auto" }}>📁</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{en.name}</span>
              {en.hasGit && <span className="tag" style={{ fontSize: 10, flex: "0 0 auto", padding: "1px 7px" }}>git</span>}
              <span style={{ color: "var(--ink-dim)", flex: "0 0 auto" }}>›</span>
            </button>
          ))}
        </div>

        {/* use current folder — tells you up front what will happen re: git */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <button className="btn btn-run" disabled={busy || loading || !here || atHome} onClick={() => useFolder(here)} title={atHome ? "Pick a sub-folder — you can't use your whole home folder as a repo" : undefined} style={{ justifyContent: "center" }}>
            {busy ? "Working…" : <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✓ Use “{hereName}”</span>}
          </button>
          {!loading && here && !atHome && (
            hereIsRepo
              ? <div className="muted" style={{ fontSize: 11.5 }}>This is a git repo — will be used as-is.</div>
              : <div className="muted" style={{ fontSize: 11.5 }}>Not a git repo — an empty git repository will be initialized so loops can run.</div>
          )}
          {atHome && <div className="muted" style={{ fontSize: 11.5 }}>Open or create a sub-folder to use as the repo.</div>}
        </div>

        {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}

        {/* fallbacks: type a path, or use the native macOS dialog on desktop */}
        <div style={{ borderTop: "1px solid var(--rule-soft)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>…or paste a path</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" style={{ flex: 1, minWidth: 0, fontSize: 12.5 }} value={manual} onChange={e => setManual(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") useFolder(manual); }} placeholder="/Users/you/my-repo" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button className="btn" disabled={busy || !manual.trim()} onClick={() => useFolder(manual)} style={{ flex: "0 0 auto" }}>Add</button>
          </div>
          <button className="btn" disabled={busy} onClick={nativePicker} style={{ justifyContent: "center", fontSize: 12.5 }} title="Opens a folder dialog on this Mac (desktop only — it won't appear on a phone)">🖥 Use the macOS folder dialog (desktop)</button>
        </div>
      </div>
    </div>
  );
}
