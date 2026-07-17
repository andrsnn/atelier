"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import YAML from "yaml";
import MachineCanvas from "@/app/components/MachineCanvas";
import { PHASE_MODEL_OPTS } from "@/app/lib/engine/models";

interface WfAgent { label: string; task: string; fanout: boolean; model?: string }
interface WfState { orchestration: "sequential" | "parallel" | "pipeline"; looped: boolean; agents: WfAgent[] }
interface StateDef { id: string; name: string; prompt: string; tools: string[]; model?: string; rejectTo?: string; gate?: boolean; maxTurns?: number; offPath?: boolean; returnTo?: string; x?: number; y?: number; caseInput?: { label: string; placeholder?: string }; output?: { file: string; label?: string }; workflow?: WfState }
interface Principle { id: string; text: string; source: "seed" | "feedback"; createdAt: number; note?: string }
interface Settings { maxLoops: number; maxTurns: number; phaseTimeoutMin: number; selfLearn?: boolean; evolveStructure?: boolean; principles?: Principle[]; reflectPrompt?: string; workflow?: { source: "claude-workflow"; whenToUse?: string; totalAgents: number; script: string } }
interface ToolInfo { name: string; label: string; description: string }

// The built-in reflection instructions (how self-learning decides what to learn). A loop can
// override these in the Self-learning panel; mirrors engine/reflect.ts DEFAULT_REFLECT_PROMPT.
const DEFAULT_REFLECT_PROMPT =
  "You are this loop's self-improvement brain. When the human gives feedback on a run, find the DURABLE, GENERALIZABLE lesson behind it (the kind of thing you'd fold into a phase's instructions so the issue never recurs) and record it as a standing principle for the whole loop. Keep principles short, imperative, and general — a rule for ANY future run, never a one-off fix for this one. Skip feedback that's purely run-specific with no reusable lesson.";

const ORCH: Record<string, { label: string; icon: string }> = {
  sequential: { label: "Sequential", icon: "→" },
  parallel: { label: "Parallel", icon: "⇉" },
  pipeline: { label: "Pipeline", icon: "⌁" },
};

// Per-phase model options. A phase can pin its OWN model — e.g. a multimodal model to inspect
// a video/image output — instead of the run's default. Blank = inherit the run's model.
// Options come from the single source of truth (app/lib/engine/models.ts).
const MODEL_OPTS = PHASE_MODEL_OPTS;
const modelLabel = (v?: string) => MODEL_OPTS.find(o => o.value === v)?.label || v || "";

export default function MachineEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [states, setStates] = useState<StateDef[]>([]);
  const [settings, setSettings] = useState<Settings>({ maxLoops: 10, maxTurns: 120, phaseTimeoutMin: 45 });
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [saved, setSaved] = useState(true);
  const [savedAt, setSavedAt] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [view, setView] = useState<"canvas" | "cards" | "yaml">("canvas");
  // AI chat panel — inspect + edit the loop in plain English
  const [chatOpen, setChatOpen] = useState(false);
  const [chatLog, setChatLog] = useState<{ role: "you" | "ai"; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  // Principles can number ~22, so show the first few and collapse the rest behind a toggle.
  const [showAllPrinciples, setShowAllPrinciples] = useState(false);

  useEffect(() => {
    (async () => {
      const d = await (await fetch(`/api/machines/${id}`, { cache: "no-store" })).json();
      if (d.machine) {
        setName(d.machine.name); setDescription(d.machine.description); setStates(d.machine.states);
        if (d.machine.settings) setSettings(d.machine.settings);
        if (d.machine.settings?.workflow) setView("cards"); // workflows read best as a phase list
      }
      setTools(d.tools || []);
      // Arrived from "Create a loop with AI" → open the graph + the chat to refine it.
      if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("ai")) {
        setView("canvas"); setChatOpen(true);
        setChatLog([{ role: "ai", text: "Drafted this loop from your description. Tell me what to change — add/remove a phase, tweak a prompt, add a loop-back, pin a model — and I'll edit it live." }]);
      }
    })();
  }, [id]);
  // On phones the drag-to-pan canvas is unusable and the DESCRIPTION field clips, so default
  // narrow viewports to the cards view. Reads window only after mount (SSR-safe).
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setView("cards");
  }, []);
  const isWorkflow = !!settings.workflow;
  function setSetting(patch: Partial<Settings>) { setSettings(s => ({ ...s, ...patch })); setSaved(false); }

  function mutate(fn: () => void) { fn(); setSaved(false); }
  function updateState(i: number, patch: Partial<StateDef>) { mutate(() => setStates(s => s.map((st, j) => j === i ? { ...st, ...patch } : st))); }
  function toggleTool(i: number, tool: string) {
    const st = states[i]; const has = st.tools.includes(tool);
    updateState(i, { tools: has ? st.tools.filter(t => t !== tool) : [...st.tools, tool] });
  }
  function addState() {
    mutate(() => setStates(s => [...s, { id: `state-${s.length + 1}-${Math.random().toString(36).slice(2, 6)}`, name: `State ${s.length + 1}`, prompt: "Do the work for this state, display_artifact your result, then request_approval.", tools: ["read_file", "write_file", "display_artifact"] }]));
  }
  function removeState(i: number) { mutate(() => setStates(s => s.filter((_, j) => j !== i))); }
  // Self-learning is a LOOP-LEVEL SETTING (not a node): when on, the loop distills durable
  // principles from your feedback and applies them to future runs.
  const selfLearnOn = settings.selfLearn === true;
  const evolveOn = settings.evolveStructure === true;
  const principles = settings.principles || [];
  // The toggle persists IMMEDIATELY (its own PATCH) — it must not need a separate "Save",
  // and must not commit unrelated in-progress edits. Optimistic + reconciled.
  async function toggleSelfLearn(on: boolean) {
    setSettings(s => ({ ...s, selfLearn: on }));
    try { await fetch(`/api/machines/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { selfLearn: on } }) }); }
    catch { /* keep optimistic state */ }
  }
  // Structural evolution: let self-learning ADD a new phase from feedback, not just principles.
  async function toggleEvolve(on: boolean) {
    setSettings(s => ({ ...s, evolveStructure: on }));
    try { await fetch(`/api/machines/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { evolveStructure: on } }) }); }
    catch { /* keep optimistic state */ }
  }
  // Principles are persisted via their OWN endpoint (not the machine PUT) so the Reflect &
  // Record node writing a learned principle can't be clobbered by a later loop save.
  async function savePrinciples(next: Principle[]) {
    setSettings(s => ({ ...s, principles: next }));
    try {
      const r = await fetch(`/api/machines/${id}/principles`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ principles: next }) });
      const d = await r.json(); if (d.principles) setSettings(s => ({ ...s, principles: d.principles }));
    } catch { /* keep optimistic local state */ }
  }
  function removePrinciple(pid: string) { savePrinciples(principles.filter(p => p.id !== pid)); }
  function addPrinciple(text: string) {
    const t = text.trim(); if (!t) return;
    savePrinciples([...principles, { id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: t, source: "seed", createdAt: Date.now() }]);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= states.length) return;
    mutate(() => setStates(s => { const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; }));
  }
  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    mutate(() => setStates(s => { const c = [...s]; const [m] = c.splice(from, 1); c.splice(to, 0, m); return c; }));
  }
  async function save() {
    // Principles are owned by their own endpoint (the reflect node writes them live); don't
    // send them in the machine PUT or a stale editor could wipe a just-learned principle.
    const { principles: _p, ...settingsNoPrinciples } = settings;
    await fetch(`/api/machines/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, states, settings: settingsNoPrinciples }) });
    setSaved(true); setSavedAt(new Date().toLocaleTimeString());
  }

  // Chat-edit the loop: describe a change, AI rewrites the states, canvas updates live.
  async function sendChat() {
    const msg = chatInput.trim(); if (!msg || chatBusy) return;
    setChatLog(l => [...l, { role: "you", text: msg }]); setChatInput(""); setChatBusy(true);
    try {
      const r = await fetch(`/api/machines/${id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg }) });
      const d = await r.json();
      if (!r.ok || !d.machine) { setChatLog(l => [...l, { role: "ai", text: `⚠ ${d.error || "couldn't apply that"}` }]); }
      else { setStates(d.machine.states); setName(d.machine.name); setSaved(true); setChatLog(l => [...l, { role: "ai", text: d.reply || "Updated." }]); }
    } catch (e) { setChatLog(l => [...l, { role: "ai", text: `⚠ ${e instanceof Error ? e.message : "edit failed"}` }]); }
    setChatBusy(false);
  }

  // A workflow phase renders as a read-only visualization (agents + orchestration),
  // not the editable tool card — the app visualizes the script, it doesn't author it.
  function renderWorkflowPhase(st: StateDef, i: number) {
    const wf = st.workflow!;
    const orch = ORCH[wf.orchestration];
    const detail = st.prompt.split("\n").filter(l => !l.trim().startsWith("•")).join("\n").trim();
    return (
      <div key={st.id} className="card card-pad" style={{ borderColor: "var(--brand)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: detail || wf.agents.length ? 11 : 0 }}>
          <span style={{ width: 24, height: 24, borderRadius: 999, background: "var(--ink)", color: "var(--surface)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>{i + 1}</span>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16 }}>{st.name}</span>
          <span className="chip" title={`Agents in this phase run ${orch.label.toLowerCase()}`} style={{ background: "var(--surface-2)", borderColor: "var(--rule)", color: "var(--ink-dim)", fontWeight: 600 }}>{orch.icon} {orch.label}</span>
          {wf.looped && <span className="chip" title="Runs inside a loop — repeats until a condition is met" style={{ background: "var(--surface-2)", borderColor: "var(--rule)", color: "var(--ink-dim)", fontWeight: 600 }}>↻ Loops</span>}
          {st.model && <span className="chip" title="This phase pins a specific model" style={{ background: "var(--brand-tint)", borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 600 }}>◈ {modelLabel(st.model)}</span>}
          <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>{wf.agents.length} agent{wf.agents.length === 1 ? "" : "s"}</span>
        </div>
        {detail && <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: wf.agents.length ? 11 : 0 }}>{detail}</div>}
        {wf.agents.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {wf.agents.map((a, j) => (
              <div key={j} style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "8px 11px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span style={{ color: "var(--brand)", fontSize: 13 }}>◆</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                    <code className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{a.label}</code>
                    {a.fanout && <span className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>one per item</span>}
                    {a.model && <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--brand)" }}>◈ {a.model}</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 2 }}>{a.task}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // The machine, as code — same shape as machines/*.yaml on disk.
  const yamlStr = (() => { try {
    return YAML.stringify({ id, name, description: description.replace(/\s*\[v3-repo-\d+\]\s*$/, ""), settings,
      states: states.map(s => ({ id: s.id, name: s.name, ...(s.model ? { model: s.model } : {}), ...(s.offPath ? { offPath: true } : {}), ...(s.returnTo ? { returnTo: s.returnTo } : {}), ...(s.gate ? { gate: true } : {}), ...(s.rejectTo ? { rejectTo: s.rejectTo } : {}), ...(s.maxTurns ? { maxTurns: s.maxTurns } : {}), ...(s.caseInput ? { caseInput: s.caseInput } : {}), ...(s.output ? { output: s.output } : {}), tools: s.tools, prompt: s.prompt })) });
  } catch { return "# (could not render)"; } })();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 13, rowGap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href="/machines" className="muted" style={{ fontSize: 18 }}>←</Link>
        <h1 style={{ fontSize: 24, margin: 0 }}>{isWorkflow ? "Workflow" : "Edit loop"}</h1>
        {isWorkflow && <span className="chip" style={{ background: "var(--brand-tint)", borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 600 }}>⚡ Claude Code workflow</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, rowGap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {savedAt && saved && <span className="muted" style={{ fontSize: 12 }}>saved {savedAt}</span>}
          {!isWorkflow && <button className="btn" onClick={() => setChatOpen(o => !o)} style={{ background: chatOpen ? "var(--brand-tint)" : "var(--surface)", borderColor: chatOpen ? "var(--brand)" : "var(--rule)", color: chatOpen ? "var(--brand)" : "var(--ink-soft)", fontWeight: chatOpen ? 600 : 500 }}>✨ Edit with AI</button>}
          <div style={{ display: "inline-flex", border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden", fontSize: 12.5 }}>
            {([["canvas", "◇ Canvas"], ["cards", "▤ Cards"], ["yaml", isWorkflow ? "⌁ Script" : "⌁ YAML"]] as const).map(([v, label], i) => (
              <button key={v} onClick={() => setView(v)} title={v === "canvas" ? "Drag-drop node canvas" : v === "cards" ? "Card list" : isWorkflow ? "The original Claude Code workflow .js script" : "machines/*.yaml — loops are code"}
                style={{ padding: "6px 13px", border: "none", borderLeft: i ? "1px solid var(--rule)" : "none", cursor: "pointer", background: view === v ? "var(--brand-tint)" : "var(--surface)", color: view === v ? "var(--brand)" : "var(--ink-dim)", fontWeight: view === v ? 600 : 400 }}>{label}</button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={save} disabled={saved}>{saved ? "Saved" : "Save changes"}</button>
        </div>
      </div>

      {isWorkflow && (
        <div className="card card-pad" style={{ marginBottom: 16, borderColor: "var(--brand)", background: "var(--brand-tint)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>Imported from a Claude Code workflow</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {settings.workflow!.totalAgents} agent call{settings.workflow!.totalAgents === 1 ? "" : "s"} across {states.length} phase{states.length === 1 ? "" : "s"} — parsed statically from the <code className="mono">.js</code> script.
            </span>
          </div>
          {settings.workflow!.whenToUse && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>When to use: {settings.workflow!.whenToUse}</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            This is a shared visualization — everyone on the board sees the team&rsquo;s workflows and where work sits. Run the workflow itself with Claude Code; see the <code className="mono">⌁ Script</code> view.
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px" }}>
          <label className="label">Name</label>
          <input className="input" style={{ marginTop: 5 }} value={name} onChange={e => { setName(e.target.value); setSaved(false); }} />
        </div>
        <div style={{ flex: "2 1 220px" }}>
          <label className="label">Description</label>
          <input className="input" style={{ marginTop: 5 }} value={description} onChange={e => { setDescription(e.target.value); setSaved(false); }} />
        </div>
      </div>

      {/* Machine-level safety knobs — all configurable, nothing hardcoded in the engine */}
      {!isWorkflow && (
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <details>
        <summary className="label" style={{ marginBottom: 8, cursor: "pointer", listStyle: "none" }}>Advanced limits ▸</summary>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div>
            <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Loop / retry cap</label>
            <input className="input" type="number" min={1} style={{ width: 120, marginTop: 4 }} value={settings.maxLoops} onChange={e => setSetting({ maxLoops: Number(e.target.value) })} />
            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>auto rounds before it fails &amp; asks for help</div>
          </div>
          <div>
            <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Tool-call budget / phase</label>
            <input className="input" type="number" min={5} style={{ width: 120, marginTop: 4 }} value={settings.maxTurns} onChange={e => setSetting({ maxTurns: Number(e.target.value) })} />
            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>default; a state can override below</div>
          </div>
          <div>
            <label className="label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>Phase timeout (min)</label>
            <input className="input" type="number" min={1} style={{ width: 120, marginTop: 4 }} value={settings.phaseTimeoutMin} onChange={e => setSetting({ phaseTimeoutMin: Number(e.target.value) })} />
          </div>
        </div>
        </details>
      </div>
      )}

      {/* Self-learning — a loop-level setting. On ⇒ the loop distills durable principles from
          your feedback and applies them to future runs. No node; it's just a switch. */}
      {!isWorkflow && (
      <div className="card card-pad" style={{ marginBottom: 16, ...(selfLearnOn ? { borderColor: "var(--brand)" } : {}) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <div className="label" style={{ margin: 0 }}>🧠 Self-learning</div>
          <button className="btn" onClick={() => toggleSelfLearn(!selfLearnOn)}
            title="When on, this loop distills durable principles from your feedback on its runs and applies them to every future run. Takes effect immediately — no save needed."
            style={{ padding: "5px 11px", fontSize: 12, background: selfLearnOn ? "var(--brand-tint)" : "var(--surface)", borderColor: selfLearnOn ? "var(--brand)" : "var(--rule)", color: selfLearnOn ? "var(--brand)" : "var(--ink-dim)", fontWeight: 600 }}>
            {selfLearnOn ? "◉ On" : "○ Off"}
          </button>
          {selfLearnOn && <span className="muted" style={{ fontSize: 12 }}>{principles.length} principle{principles.length === 1 ? "" : "s"}</span>}
        </div>
        <div className="muted" style={{ fontSize: 12.5, maxWidth: 800, marginBottom: selfLearnOn ? 12 : 0 }}>
          {selfLearnOn
            ? "As you leave comments and give feedback on this loop's runs, it distills the durable lesson into a principle below — and every future run follows them. Edit or remove any; add your own. (Each run can opt out when you create the ticket.)"
            : "Turn this on and the loop learns from your feedback: it distills durable principles from your comments and applies them to future runs — so you don't have to give the same note twice."}
        </div>
        {selfLearnOn && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {principles.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No principles yet — they appear here as the loop learns from your feedback.</div>}
              {(showAllPrinciples ? principles : principles.slice(0, 3)).map(p => (
                <div key={p.id} style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "8px 11px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                  <span title={p.source === "feedback" ? "Learned from your feedback" : "Added by you"} style={{ fontSize: 12 }}>{p.source === "feedback" ? "🧠" : "✎"}</span>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5 }}>{p.text}{p.note ? <span className="muted" style={{ fontSize: 11 }}> — from your note: “{p.note}”</span> : null}</div>
                  <button className="btn" style={{ padding: "2px 8px", fontSize: 11, color: "var(--danger)" }} onClick={() => removePrinciple(p.id)} title="Remove this principle">✕</button>
                </div>
              ))}
            </div>
            {principles.length > 3 && (
              <button onClick={() => setShowAllPrinciples(v => !v)}
                style={{ marginTop: 5, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--brand)" }}>
                {showAllPrinciples ? "▾ Show fewer" : `▸ Show all ${principles.length} principles`}
              </button>
            )}
            <AddPrinciple onAdd={addPrinciple} />
            {/* Structural evolution — let self-learning ADD a phase, not just principles. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--rule)" }}>
              <div className="label" style={{ margin: 0 }}>🧬 Evolve structure</div>
              <button className="btn" onClick={() => toggleEvolve(!evolveOn)}
                title="When on, self-learning may ADD a new phase to this loop from your feedback — not just a text principle — e.g. a review step it was missing. It edits the loop's structure; you can remove any added phase on the graph."
                style={{ padding: "4px 10px", fontSize: 11.5, background: evolveOn ? "var(--brand-tint)" : "var(--surface)", borderColor: evolveOn ? "var(--brand)" : "var(--rule)", color: evolveOn ? "var(--brand)" : "var(--ink-dim)", fontWeight: 600 }}>
                {evolveOn ? "◉ On" : "○ Off"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {evolveOn ? "Feedback can add a new phase (a missing step), not only a principle." : "Learn principles only — don't change the loop's phases."}
              </span>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Advanced — how it reflects</summary>
              <textarea className="input" style={{ marginTop: 7, minHeight: 84, fontFamily: "var(--font-mono)", fontSize: 12 }}
                value={settings.reflectPrompt ?? ""} placeholder={DEFAULT_REFLECT_PROMPT}
                onChange={e => setSetting({ reflectPrompt: e.target.value || undefined })} />
              <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>How it decides what to learn from your feedback. Blank = the built-in default.</div>
            </details>
          </>
        )}
      </div>
      )}

      {view === "canvas" && <MachineCanvas states={states} tools={tools} onChange={next => { setStates(next as StateDef[]); setSaved(false); }} />}

      {view === "yaml" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="label" style={{ padding: "10px 16px", borderBottom: "1px solid var(--rule)" }}>
            {isWorkflow ? `.claude/workflows/${id.replace(/^wf-/, "")}.js — Claude Code workflow` : `machines/${id}.yaml — loops are code`}
          </div>
          <pre className="mono" style={{ margin: 0, padding: "14px 16px", maxHeight: 520, overflow: "auto", fontSize: 12, lineHeight: 1.55, background: "var(--surface-2)" }}>{isWorkflow ? settings.workflow!.script : yamlStr}</pre>
        </div>
      )}

      {view === "cards" && <>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {states.map((st, i) => st.workflow ? renderWorkflowPhase(st, i) : (
          <div key={st.id} id={`mstate-${i}`} className="card card-pad"
            onDragOver={e => { if (dragIdx !== null) { e.preventDefault(); if (overIdx !== i) setOverIdx(i); } }}
            onDrop={e => { e.preventDefault(); if (dragIdx !== null) reorder(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
            style={{ outline: overIdx === i && dragIdx !== null && dragIdx !== i ? "2px dashed var(--brand)" : "none", outlineOffset: 2, opacity: dragIdx === i ? 0.5 : 1, borderColor: st.offPath ? "var(--brand)" : undefined, borderStyle: st.offPath ? "dashed" : undefined }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span draggable onDragStart={() => setDragIdx(i)} onDragEnd={() => { setDragIdx(null); setOverIdx(null); }} title="Drag to reorder this step"
                style={{ cursor: "grab", color: "var(--ink-dim)", fontSize: 16, userSelect: "none", padding: "0 2px" }}>⠿</span>
              <span style={{ width: 24, height: 24, borderRadius: 999, background: "var(--ink)", color: "var(--surface)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>{i + 1}</span>
              <input className="input" style={{ width: 200, fontWeight: 600, fontFamily: "var(--font-display)" }} value={st.name} onChange={e => updateState(i, { name: e.target.value })} />
              <label className="muted" style={{ fontSize: 12 }}>on reject →</label>
              <select className="input" style={{ width: 150 }} value={st.rejectTo || ""} onChange={e => updateState(i, { rejectTo: e.target.value || undefined })}>
                <option value="">(no loop-back)</option>
                {states.filter((_, j) => j !== i).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="btn" title="Pause for human approval when this phase finishes" onClick={() => updateState(i, { gate: !st.gate })}
                style={{ padding: "6px 11px", fontSize: 12, background: st.gate ? "var(--brand-tint)" : "var(--surface)", borderColor: st.gate ? "var(--brand)" : "var(--rule)", color: st.gate ? "var(--brand)" : "var(--ink-dim)", fontWeight: st.gate ? 600 : 400 }}>
                {st.gate ? "⏸ Approval gate" : "⏩ Auto-progress"}
              </button>
              <button className="btn" title="Off-path leaf: skipped in the normal flow; runs ONLY when routed into deliberately (e.g. a deep-dive). When it finishes it rejoins the flow at the phase you pick below."
                onClick={() => updateState(i, { offPath: !st.offPath, returnTo: !st.offPath && !st.returnTo ? states.find((_, j) => j !== i)?.id : st.returnTo })}
                style={{ padding: "6px 11px", fontSize: 12, background: st.offPath ? "var(--brand-tint)" : "var(--surface)", borderColor: st.offPath ? "var(--brand)" : "var(--rule)", color: st.offPath ? "var(--brand)" : "var(--ink-dim)", fontWeight: st.offPath ? 600 : 400 }}>
                {st.offPath ? "🔬 Off-path leaf" : "▢ On main path"}
              </button>
              {st.offPath && <>
                <label className="muted" style={{ fontSize: 12 }}>rejoins at →</label>
                <select className="input" style={{ width: 150 }} value={st.returnTo || ""} onChange={e => updateState(i, { returnTo: e.target.value || undefined })}>
                  <option value="">(end — stop after)</option>
                  {states.filter((_, j) => j !== i).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </>}
              <label className="muted" style={{ fontSize: 12 }}>model</label>
              <select className="input" style={{ width: 185 }} value={st.model || ""} onChange={e => updateState(i, { model: e.target.value || undefined })}
                title="Run THIS phase with a specific model (e.g. a multimodal model to inspect a video/image output). Blank = the run's model. An overriding phase runs isolated so it doesn't disturb the main agent thread.">
                {MODEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <label className="muted" style={{ fontSize: 12 }}>turns</label>
              <input className="input" type="number" min={5} style={{ width: 78 }} placeholder="default" value={st.maxTurns ?? ""} onChange={e => updateState(i, { maxTurns: e.target.value ? Number(e.target.value) : undefined })} title="Tool-call budget for this phase (blank = loop default)" />
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button className="btn" style={{ padding: "6px 10px" }} onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="btn" style={{ padding: "6px 10px" }} onClick={() => move(i, 1)} disabled={i === states.length - 1}>↓</button>
                <button className="btn" style={{ padding: "6px 10px", color: "var(--danger)" }} onClick={() => removeState(i)}>✕</button>
              </div>
            </div>

            <label className="label">Prompt — what to accomplish in this state</label>
            <textarea className="input" style={{ marginTop: 5, minHeight: 130, fontFamily: "var(--font-mono)", fontSize: 12.5 }} value={st.prompt} onChange={e => updateState(i, { prompt: e.target.value })} />

            <div className="label" style={{ margin: "14px 0 7px" }}>Attached tools — the capabilities the AI may use here</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {tools.map(t => {
                const on = st.tools.includes(t.name);
                return (
                  <button key={t.name} onClick={() => toggleTool(i, t.name)} title={t.description} className="chip"
                    style={{ cursor: "pointer", background: on ? "var(--brand-tint)" : "var(--surface-2)", borderColor: on ? "var(--brand)" : "var(--rule)", color: on ? "var(--brand)" : "var(--ink-dim)", fontWeight: on ? 600 : 400 }}>
                    {on ? "✓ " : "+ "}{t.label}
                  </button>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 9 }}>
              request_approval &amp; complete are always available — they end the state and hand control back to you.
            </div>
          </div>
        ))}
      </div>
      {!isWorkflow && <button className="btn" style={{ marginTop: 14 }} onClick={addState}>+ Add state</button>}
      </>}

      {/* AI chat — inspect + edit the loop in plain English; edits apply live to the graph */}
      {chatOpen && !isWorkflow && (
        <div className="card max-sm:left-3 max-sm:right-3 sm:right-5 sm:w-[380px]" style={{ position: "fixed", bottom: 20, maxHeight: "70vh", display: "flex", flexDirection: "column", zIndex: 50, boxShadow: "0 8px 30px rgba(0,0,0,.16)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}>
            <strong style={{ fontSize: 13 }}>✨ Edit this loop</strong>
            <span className="muted" style={{ fontSize: 11 }}>changes apply live</span>
            <button className="btn" style={{ marginLeft: "auto", padding: "2px 9px", fontSize: 12 }} onClick={() => setChatOpen(false)}>✕</button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9, minHeight: 120 }}>
            {chatLog.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Describe a change — “add a QA phase after Build”, “make Review loop back to Build”, “pin claude:opus on the planning phase”, “tighten the Spec prompt”.</div>}
            {chatLog.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "you" ? "flex-end" : "flex-start", maxWidth: "88%", fontSize: 12.5, lineHeight: 1.5, padding: "7px 11px", borderRadius: 10, whiteSpace: "pre-wrap",
                background: m.role === "you" ? "var(--brand)" : "var(--surface-2)", color: m.role === "you" ? "#fff" : "var(--ink)", border: m.role === "you" ? "none" : "1px solid var(--rule)" }}>{m.text}</div>
            ))}
            {chatBusy && <div className="muted" style={{ fontSize: 12 }}>editing the loop…</div>}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "10px 12px", borderTop: "1px solid var(--rule)" }}>
            <textarea className="input" value={chatInput} onChange={e => setChatInput(e.target.value)} disabled={chatBusy}
              placeholder="What should change? (⌘↵ to send)" style={{ flex: 1, minHeight: 38, fontSize: 12.5 }}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendChat(); } }} />
            <button className="btn btn-primary" onClick={sendChat} disabled={chatBusy || !chatInput.trim()} style={{ padding: "0 12px" }}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small inline input for adding a principle by hand (alongside the ones the loop learns). */
function AddPrinciple({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => { const t = text.trim(); if (t) { onAdd(t); setText(""); } };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
      <input className="input" style={{ flex: 1, fontSize: 12.5 }} value={text} onChange={e => setText(e.target.value)}
        placeholder="Add a principle by hand — a standing rule for every run (↵ to add)"
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
      <button className="btn" style={{ padding: "0 12px" }} onClick={submit} disabled={!text.trim()}>+ Add</button>
    </div>
  );
}
