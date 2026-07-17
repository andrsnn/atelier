/**
 * Persistence for Atelier. Raw better-sqlite3 — small, synchronous-at-startup
 * schema creation only; all hot-path writes are tiny and fast.
 *
 * Data model (deliberately generic — the engine never special-cases a state):
 *   machines  — a state-machine definition: ordered states, each {name, prompt, tools[], model?}
 *   runs      — a goal in flight through a machine
 *   events    — the live timeline of a run (agent text, tool calls/results, artifacts, gates)
 *   artifacts — the things a run produced ("display a thing") — markdown/html/json/text
 */
import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";

const DIR = join(process.cwd(), ".factory");
mkdirSync(DIR, { recursive: true });

// Persistent store for run DELIVERABLES (files an agent returns via return_file).
// A run's worktree is transient — it can be torn down after the run — so a returned
// file must be COPIED here, out of the worktree, to stay downloadable. These are small
// final outputs (an mp3, a zip), so local disk is fine; override with FACTORY_DELIVERABLES_DIR.
export const DELIVERABLES_DIR = process.env.FACTORY_DELIVERABLES_DIR || join(DIR, "deliverables");
mkdirSync(DELIVERABLES_DIR, { recursive: true });

const sqlite = new Database(join(DIR, "factory.db"));
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  states TEXT NOT NULL,            -- JSON: [{ id, name, prompt, tools:[], gate?, rejectTo?, maxTurns? }]
  settings TEXT,                   -- JSON: { maxLoops, maxTurns, phaseTimeoutMin }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  state_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',   -- idle | running | awaiting_approval | done | failed
  approval_summary TEXT,                 -- the message the agent left when it asked for approval
  workspace TEXT NOT NULL,
  last_error TEXT,
  repo_path TEXT,                        -- the target git repo (null = scratch workspace)
  base_branch TEXT,                      -- branch the worktree is cut from
  branch_name TEXT,                      -- the run's feature branch
  pr_url TEXT,                           -- opened PR, if any
  primary_model TEXT,                    -- the single agent driving this ticket (e.g. claude:opus, ollama:qwen3-coder:480b)
  vision_model TEXT,                     -- multimodal helper for visual/QA (e.g. ollama:kimi-k2.6)
  agent_state TEXT,                      -- opaque per-provider continuation handle (claude session id, etc.)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  type TEXT NOT NULL,    -- state_enter | text | tool_call | tool_result | artifact | approval_request | approved | feedback | error | done
  content TEXT NOT NULL, -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,    -- markdown | html | json | text | image
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,           -- the phase that owns the artifact (e.g. "mock")
  artifact_id TEXT,             -- the specific artifact (mock option) the pin sits on
  artifact_name TEXT,           -- denormalized for the feedback prompt
  anchor TEXT NOT NULL,         -- JSON: { type:"pin", x:0-100, y:0-100 } | { type:"note" }
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | sent
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_run ON comments(run_id, id);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- the phase that returned the file
  filename TEXT NOT NULL,       -- the name shown / downloaded as
  stored_path TEXT NOT NULL,    -- absolute path to the PERSISTENT copy (survives worktree teardown)
  size INTEGER NOT NULL,        -- bytes
  mime TEXT NOT NULL,           -- inferred content-type (e.g. audio/mpeg)
  label TEXT,                   -- optional short human title
  description TEXT,             -- optional note
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliverables_run ON deliverables(run_id, id);
`);

// Migrate older DBs that predate project targeting — add columns if missing.
for (const col of ["repo_path TEXT", "base_branch TEXT", "branch_name TEXT", "pr_url TEXT", "primary_model TEXT", "vision_model TEXT", "agent_state TEXT", "loop_count INTEGER DEFAULT 0", "auto_mode INTEGER DEFAULT 0", "gate_mode TEXT DEFAULT 'machine'", "disabled_states TEXT", "reference_image TEXT", "reference_desc TEXT", "conductor_mode TEXT DEFAULT 'auto'", "conductor_model TEXT", "archived INTEGER DEFAULT 0", "conductor_react TEXT DEFAULT 'auto'"]) {
  try { sqlite.exec(`ALTER TABLE runs ADD COLUMN ${col}`); } catch { /* already exists */ }
}
try { sqlite.exec(`ALTER TABLE machines ADD COLUMN settings TEXT`); } catch { /* already exists */ }
try { sqlite.exec(`ALTER TABLE comments ADD COLUMN image TEXT`); } catch { /* already exists */ } // optional attached image (data URL)
try { sqlite.exec(`ALTER TABLE comments ADD COLUMN author TEXT`); } catch { /* already exists */ } // who left the comment (display name; collaboration)
try { sqlite.exec(`ALTER TABLE comments ADD COLUMN parent_id TEXT`); } catch { /* already exists */ } // threaded replies: the comment this one replies to
try { sqlite.exec(`ALTER TABLE conductor_messages ADD COLUMN image TEXT`); } catch { /* already exists */ } // image the human attaches to a conductor message
try { sqlite.exec(`ALTER TABLE conductor_messages ADD COLUMN author TEXT`); } catch { /* already exists */ } // who wrote the "you" message (display name)
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN conductor_revert TEXT`); } catch { /* already exists */ } // JSON {index,name}: where the run was before the Conductor's last route, so it can be reverted
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN qa_mode TEXT DEFAULT 'rigorous'`); } catch { /* already exists */ }
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN mode TEXT`); } catch { /* already exists */ } // generic per-run machine mode (id from machine.settings.modes)
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN apply_principles INTEGER DEFAULT 1`); } catch { /* already exists */ } // per-run toggle: apply the loop's learned principles to this run (1) or run clean (0)
try { sqlite.exec(`UPDATE runs SET mode = qa_mode WHERE mode IS NULL AND qa_mode IS NOT NULL`); } catch { /* qa_mode pre-rename data */ }
try { sqlite.exec(`ALTER TABLE deliverables ADD COLUMN is_final INTEGER DEFAULT 0`); } catch { /* already exists */ } // 1 = part of the agent's EXPOSED final output set (via the expose_output tool)
try { sqlite.exec(`ALTER TABLE deliverables ADD COLUMN loop INTEGER DEFAULT 0`); } catch { /* already exists */ } // loop_count when produced; lets the UI fall back to "the last loop's files" when nothing was exposed
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN criteria TEXT`); } catch { /* already exists */ } // JSON NorthStarCriterion[] — the run's North Star acceptance criteria (goal + these = the definition of done). Seeded from the loop template; editable per run; injected into every phase.
try { sqlite.exec(`ALTER TABLE runs ADD COLUMN learnings TEXT`); } catch { /* already exists */ } // JSON RunLearning[] — learnings scoped to THIS run (the run side of self-learning). "Keep for the loop" promotes one into the loop's principles.

// The Conductor's session: the human's notes to it + its synthesized directives.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS conductor_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- you | conductor | system
  body TEXT NOT NULL,
  directive TEXT,              -- JSON { targetState, targetName, brief, keep[], commentIds[] } when it proposes a route
  status TEXT NOT NULL DEFAULT '',  -- '' | proposed | applied | dismissed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conductor_run ON conductor_messages(run_id, id);
`);

export { sqlite as db };

export const now = () => Date.now();

// ---------- typed row shapes ----------
export interface StateDef {
  id: string; name: string; prompt: string; tools: string[]; model?: string;
  /** If this is a review/gate phase, the state id to loop BACK to when the agent rejects
   *  (e.g. qa → build). Omitted for non-review phases. The agent gives the verdict; the
   *  machine just routes — no deterministic pass/fail logic. */
  rejectTo?: string;
  /** Whether this phase PAUSES for human approval when it finishes (a gate). When
   *  false/undefined the phase auto-advances. Configurable per state in the editor.
   *  (Run-level Auto mode overrides all gates to auto.) */
  gate?: boolean;
  /** Whether the human may SKIP this phase when starting a loop. The YAML declares
   *  WHICH phases are skippable (the policy); the per-run choice lands in
   *  run.disabled_states; the driver skips any disabled phase when advancing. Lets a
   *  machine say "Mock and QA are optional" without any hard-coded state names. */
  optional?: boolean;
  /** Optional per-phase override of the tool-call budget (e.g. Build needs more). */
  maxTurns?: number;
  /** Optional per-MODE prompt overrides for this state, keyed by a machine mode id
   *  (see MachineMode / settings.modes). The runner uses modes[run.mode] when present;
   *  otherwise the default `prompt`. Lets a machine's modes live entirely in the YAML. */
  modes?: Record<string, string>;
  /** OFF-PATH leaf: `advance()` SKIPS this phase in the normal flow — it only runs when
   *  deliberately routed into (by the human or the Conductor). Use for an on-demand
   *  diagnostic side-quest (e.g. a deep-dive/bisect) that isn't part of the critical path. */
  offPath?: boolean;
  /** When this phase finishes, advance to THIS state id instead of the next in order.
   *  Lets an off-path leaf rejoin the normal flow (e.g. bisect → returnTo: review). */
  returnTo?: string;
  /** Canvas node position (machine editor's drag-drop view only). Ignored by the engine. */
  x?: number;
  y?: number;
  /** Optional human affordance for THIS phase: when set, the run page shows an input (only
   *  while viewing this phase) to send the phase an extra ad-hoc case/scenario to handle.
   *  Generic — e.g. QA declares { label: "🔬 Smoke-test a scenario" }. No hard-coded names. */
  caseInput?: { label: string; placeholder?: string };
  /** Optional downloadable OUTPUT this phase produces: when set, the run page shows a
   *  Download button (only while viewing this phase, once it has run) for `file` in the
   *  workspace. Config-driven like caseInput — the phase declares its deliverable, the
   *  system serves it; no hard-coded URLs. e.g. a Package phase: { file: "images.zip" }. */
  output?: { file: string; label?: string };
  /** Marks a TERMINAL phase whose result depends on state that keeps changing AFTER the
   *  phase finishes (e.g. a PR: is it still up to date with its base? did CI pass?). When
   *  set, the UI shows a "re-check" affordance — a button on the ticket while viewing this
   *  phase, and an icon in the dashboard list for any run parked here — that RE-RUNS this
   *  phase on demand (via reviseFrom) with `note` as the brief. Fully generic: the engine
   *  never knows what's being re-checked; the phase's own prompt + tools do the work (a PR
   *  loop points it at watch_pr + rebase; another loop could check anything). label/icon are
   *  display only. No hard-coded state names or PR logic anywhere in the engine or UI. */
  watchable?: { label: string; icon?: string; note?: string };
  /** Present only on machines IMPORTED FROM A CLAUDE CODE WORKFLOW script: the agents
   *  and orchestration shape of this phase, extracted statically for the visualizer.
   *  Opaque to the engine — purely a render hint (see app/lib/workflows/parse.ts). */
  workflow?: {
    orchestration: "sequential" | "parallel" | "pipeline";
    looped: boolean;
    agents: { label: string; task: string; fanout: boolean; model?: string }[];
  };
}

/** A run "mode" a machine offers (e.g. a QA-depth toggle). Generic: each machine
 *  declares its own; the UI renders whatever's here. The `id` matches a key in a
 *  state's `modes` map (the prompt override). A mode with no state override (or the
 *  one marked `default`) just runs the states' normal prompts. */
export interface MachineMode {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  default?: boolean;
}

/** A durable, generalized learning the loop has accumulated — seeded from its config or
 *  distilled by the Reflect & Record node from human feedback. Injected into every future
 *  run's phase prompts (when the run opts in). This is how a loop improves over time. */
export interface Principle {
  id: string;
  text: string;
  source: "seed" | "feedback";
  createdAt: number;
  /** Optional short note on where it came from (e.g. the feedback that produced it). */
  note?: string;
}

/** A North Star acceptance criterion — one objectively-checkable condition the run's output
 *  must satisfy. Goal + criteria = the run's definition of done. Authored by the human (or
 *  seeded from the loop template / Spec), injected into every phase, and STATUS-updated by the
 *  agent via the `north_star` tool (never deterministic parsing). */
export interface NorthStarCriterion {
  id: string;
  text: string;
  status: "pending" | "met";
  /** One-line evidence/reason the agent left for the current status. */
  note?: string;
}

/** A learning scoped to a SINGLE run (the run side of self-learning; loop-level learnings are
 *  Principles on the machine). "Keep for the loop" promotes one into the loop's principles. */
export interface RunLearning { id: string; text: string; createdAt: number }

/** Machine-level knobs — all configurable, none hardcoded in the engine. */
export interface MachineSettings {
  /** Total automatic rounds (reject loop-backs + self-continues) before the run
   *  FAILS and asks the human for help. Your "loop detection" cap. */
  maxLoops: number;
  /** Default tool-call budget per phase (a state can override with maxTurns). */
  maxTurns: number;
  /** Hard time budget per phase, in minutes. */
  phaseTimeoutMin: number;
  /** Optional run modes this machine offers (a dropdown in the UI). Each id maps to
   *  per-state `modes` prompt overrides. Empty/absent ⇒ no mode selector shown. */
  modes?: MachineMode[];
  /** SELF-LEARNING — a loop-level setting (not a node). When on, the loop distills durable
   *  principles from human feedback on its runs and applies them to future runs. */
  selfLearn?: boolean;
  /** Durable learnings this loop has accumulated (see Principle). Grown from human feedback
   *  when self-learning is on; applied to future runs. */
  principles?: Principle[];
  /** DEFAULT North Star acceptance criteria for this loop (the template). New runs of the loop
   *  seed their editable per-run criteria from these. Empty ⇒ runs start with no criteria. */
  criteria?: NorthStarCriterion[];
  /** Optional override of the reflection instructions (how it decides what to learn from
   *  feedback). Blank ⇒ the built-in default (engine/reflect.ts DEFAULT_REFLECT_PROMPT). */
  reflectPrompt?: string;
  /** STRUCTURAL self-learning — when on (with selfLearn), reflection may ADD a new node/state
   *  to the loop from feedback (not just a text principle) — e.g. a review step the loop was
   *  missing. Off ⇒ self-learning only records principles. Toggle in the Self-learning panel. */
  evolveStructure?: boolean;
  /** Present only on workflow-sourced machines: marks this machine as imported from a
   *  Claude Code workflow (`.claude/workflows/*.js`) and carries the original script so
   *  the editor's code view can show/round-trip it. The app is a visualizer over it. */
  workflow?: { source: "claude-workflow"; whenToUse?: string; totalAgents: number; script: string };
}
export const DEFAULT_SETTINGS: MachineSettings = { maxLoops: 10, maxTurns: 120, phaseTimeoutMin: 45 };
export interface Machine { id: string; name: string; description: string; states: StateDef[]; settings: MachineSettings; created_at: number; updated_at: number }
export interface Run {
  id: string; title: string; goal: string; machine_id: string; state_index: number;
  status: "idle" | "running" | "queued" | "awaiting_approval" | "paused" | "done" | "failed";
  approval_summary: string | null; workspace: string; last_error: string | null;
  repo_path: string | null; base_branch: string | null; branch_name: string | null; pr_url: string | null;
  primary_model: string | null; vision_model: string | null; agent_state: string | null; loop_count: number;
  auto_mode: number;
  /** "all" = gate every phase · "machine" = obey each state's gate flag · "none" = never pause. */
  gate_mode: "all" | "machine" | "none";
  /** JSON array of state ids to SKIP for THIS run (e.g. turn off QA for a quick run). */
  disabled_states: string | null;
  /** Optional reference image the human attached to the loop (data URL). */
  reference_image: string | null;
  /** A text description of the reference image (for text-only agents). */
  reference_desc: string | null;
  /** How the Conductor acts on feedback: "propose" (waits for your ok) · "auto" (routes itself). */
  conductor_mode: "propose" | "auto" | null;
  /** Whether the Conductor auto-reacts to new comments ("auto") or only when you ask it
   *  to ("manual" — it batches comments until you hit "Review comments"). */
  conductor_react: "auto" | "manual" | null;
  /** Optional model override for the Conductor (defaults to the run's primary). */
  conductor_model: string | null;
  /** Selected run mode id (one of the machine's `settings.modes`), or null to use the
   *  machine's default. Generic — the machine defines what modes mean via state `modes`
   *  prompt overrides. Null ⇒ states run their normal prompts. */
  mode: string | null;
  /** JSON {index,name} of where the run sat before the Conductor's last applied route —
   *  lets the human REVERT that route. Null when there's nothing to revert. */
  conductor_revert: string | null;
  /** Hidden from the board when 1 (declutter done/failed loops; restorable). */
  archived: number;
  /** Per-run toggle: apply the loop's learned principles to this run (1) or run clean (0).
   *  Default 1. Set at ticket creation; lets you opt a run out of the accumulated learnings. */
  apply_principles: number;
  /** JSON NorthStarCriterion[] — this run's North Star acceptance criteria (goal + these =
   *  definition of done). Seeded from the loop template; editable per run; injected each phase. */
  criteria: string | null;
  /** JSON RunLearning[] — learnings scoped to THIS run (the run side of self-learning). */
  learnings: string | null;
  created_at: number; updated_at: number;
}
export interface FactoryEvent { id: string; run_id: string; state: string; type: string; content: string; created_at: number }
export interface Artifact { id: string; run_id: string; state: string; name: string; kind: string; body: string; created_at: number }
export interface Deliverable { id: string; run_id: string; state: string; filename: string; stored_path: string; size: number; mime: string; label: string | null; description: string | null; is_final: number; loop: number; created_at: number }
export interface Comment { id: string; run_id: string; state: string; artifact_id: string | null; artifact_name: string | null; anchor: string; body: string; image: string | null; author: string | null; parent_id: string | null; status: "open" | "sent"; created_at: number }
/** A line in a run's Conductor session — your note to it, or its synthesized directive. */
export interface ConductorMsg { id: string; run_id: string; role: "you" | "conductor" | "system"; body: string; directive: string | null; status: "" | "proposed" | "applied" | "dismissed"; image: string | null; author: string | null; created_at: number }

// ---------- machines ----------
export function listMachines(): Machine[] {
  return sqlite.prepare("SELECT * FROM machines ORDER BY updated_at DESC").all().map(rowToMachine);
}
export function getMachine(id: string): Machine | null {
  const r = sqlite.prepare("SELECT * FROM machines WHERE id = ?").get(id);
  return r ? rowToMachine(r) : null;
}
function rowToMachine(r: any): Machine {
  return { ...r, states: JSON.parse(r.states), settings: r.settings ? { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings) } : DEFAULT_SETTINGS };
}
export function upsertMachine(m: { id: string; name: string; description?: string; states: StateDef[]; settings?: Partial<MachineSettings> }) {
  const t = now();
  const existing = sqlite.prepare("SELECT created_at FROM machines WHERE id = ?").get(m.id) as any;
  sqlite.prepare(`
    INSERT INTO machines (id, name, description, states, settings, created_at, updated_at)
    VALUES (@id, @name, @description, @states, @settings, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, description=@description, states=@states, settings=@settings, updated_at=@updated_at
  `).run({
    id: m.id, name: m.name, description: m.description ?? "",
    states: JSON.stringify(m.states),
    settings: JSON.stringify({ ...DEFAULT_SETTINGS, ...(m.settings || {}) }),
    created_at: existing?.created_at ?? t, updated_at: t,
  });
  return getMachine(m.id)!;
}

/** Structural self-learning: splice a NEW state into a machine's flow, after `afterId` (or at
 *  the end). Idempotent on the state's id. Returns the updated machine (or null if it's gone). */
export function insertMachineState(machineId: string, state: StateDef, afterId?: string): Machine | null {
  const m = getMachine(machineId);
  if (!m) return null;
  if (m.states.some(s => s.id === state.id)) return m; // already present
  const states = [...m.states];
  const i = afterId ? states.findIndex(s => s.id === afterId) : states.length - 1;
  states.splice(i >= 0 ? i + 1 : states.length, 0, state);
  return upsertMachine({ id: m.id, name: m.name, description: m.description, states, settings: m.settings });
}

// ---------- loop principles (self-learning) ----------
const pid = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const normPrinciple = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** APPEND learnings to a loop's principles (dedup by normalized text; newest wins on a
 *  near-duplicate; capped). Used by the record_principles tool AND the self-learning
 *  reflection. Read-modify-write on the whole settings blob so nothing else is lost. */
export function recordPrinciples(machineId: string, items: { text: string; source?: "seed" | "feedback"; note?: string }[]): Principle[] {
  const m = getMachine(machineId);
  if (!m) return [];
  const existing = [...(m.settings.principles || [])];
  const seen = new Set(existing.map(p => normPrinciple(p.text)));
  for (const it of items) {
    const text = String(it?.text || "").trim();
    if (!text) continue;
    const key = normPrinciple(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    existing.push({ id: pid(), text, source: it.source || "feedback", createdAt: now(), ...(it.note ? { note: it.note } : {}) });
  }
  const principles = existing.slice(-60); // keep the most recent 60
  upsertMachine({ id: m.id, name: m.name, description: m.description, states: m.states, settings: { ...m.settings, principles } });
  return principles;
}

/** REPLACE a loop's principles wholesale (editor edit/remove). */
export function setPrinciples(machineId: string, principles: Principle[]): Principle[] {
  const m = getMachine(machineId);
  if (!m) return [];
  const clean = (principles || []).filter(p => p && String(p.text || "").trim()).map(p => ({
    id: p.id || pid(), text: String(p.text).trim(), source: p.source === "seed" ? "seed" as const : "feedback" as const,
    createdAt: p.createdAt || now(), ...(p.note ? { note: p.note } : {}),
  }));
  upsertMachine({ id: m.id, name: m.name, description: m.description, states: m.states, settings: { ...m.settings, principles: clean } });
  return clean;
}

// ---------- North Star (goal + acceptance criteria) & run-level learnings ----------
const normStatus = (s: unknown): NorthStarCriterion["status"] => {
  const v = String(s || "").toLowerCase();
  return v === "met" || v === "done" || v === "pass" || v === "passed" ? "met" : "pending";
};

/** Parse a run's North Star criteria (tolerant of null/legacy). */
export function getCriteria(run: Pick<Run, "criteria">): NorthStarCriterion[] {
  try { const a = JSON.parse(run.criteria || "[]"); return Array.isArray(a) ? a.filter(c => c && c.text) : []; } catch { return []; }
}

/** REPLACE a run's criteria wholesale (the human's edit in the North Star panel). */
export function setCriteria(runId: string, list: { id?: string; text: string; status?: string; note?: string }[]): NorthStarCriterion[] {
  const clean: NorthStarCriterion[] = (list || [])
    .filter(c => c && String(c.text || "").trim())
    .map(c => ({ id: c.id || pid(), text: String(c.text).trim().slice(0, 400), status: normStatus(c.status), ...(c.note ? { note: String(c.note).slice(0, 300) } : {}) }));
  updateRun(runId, { criteria: JSON.stringify(clean) } as Partial<Run>);
  return clean;
}

/** Update criterion STATUS by matching each on its id, 1-based number, or text (the `north_star`
 *  tool's path — the agent reports where the run stands; no criteria are added/removed here). */
export function setCriteriaStatus(runId: string, updates: { criterion: string; status: string; note?: string }[]): NorthStarCriterion[] {
  const run = getRun(runId); if (!run) return [];
  const list = getCriteria(run);
  if (!list.length) return list;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const u of updates || []) {
    const key = String(u?.criterion ?? "").trim();
    const n = Number(key);
    const target =
      list.find(c => c.id === key) ||
      (Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : undefined) ||
      list.find(c => norm(c.text) === norm(key)) ||
      list.find(c => key && (norm(c.text).includes(norm(key)) || norm(key).includes(norm(c.text))));
    if (target) { target.status = normStatus(u.status); if (u.note) target.note = String(u.note).slice(0, 300); }
  }
  updateRun(runId, { criteria: JSON.stringify(list) } as Partial<Run>);
  return list;
}

export function getRunLearnings(run: Pick<Run, "learnings">): RunLearning[] {
  try { const a = JSON.parse(run.learnings || "[]"); return Array.isArray(a) ? a.filter(l => l && l.text) : []; } catch { return []; }
}
export function addRunLearning(runId: string, text: string): RunLearning | null {
  const run = getRun(runId); if (!run) return null;
  const t = String(text || "").trim().slice(0, 400); if (!t) return null;
  const list = getRunLearnings(run);
  const item: RunLearning = { id: pid(), text: t, createdAt: now() };
  list.push(item);
  updateRun(runId, { learnings: JSON.stringify(list.slice(-40)) } as Partial<Run>);
  return item;
}
export function removeRunLearning(runId: string, id: string): RunLearning[] {
  const run = getRun(runId); if (!run) return [];
  const list = getRunLearnings(run).filter(l => l.id !== id);
  updateRun(runId, { learnings: JSON.stringify(list) } as Partial<Run>);
  return list;
}
/** "Keep for the loop": promote a RUN learning into the loop's durable principles, then drop it
 *  from the run. Returns the loop's principles after the add. */
export function promoteLearning(runId: string, learningId: string): Principle[] {
  const run = getRun(runId); if (!run) return [];
  const item = getRunLearnings(run).find(l => l.id === learningId);
  if (!item) return getMachine(run.machine_id)?.settings.principles || [];
  const after = recordPrinciples(run.machine_id, [{ text: item.text, source: "feedback", note: "promoted from a run" }]);
  removeRunLearning(runId, learningId);
  return after;
}

// ---------- runs ----------
export function listRuns(opts: { archived?: boolean } = {}): Run[] {
  // Default: active (non-archived) loops. Pass { archived: true } for the archive.
  const want = opts.archived ? 1 : 0;
  return sqlite.prepare("SELECT * FROM runs WHERE COALESCE(archived,0) = ? ORDER BY created_at DESC").all(want) as Run[];
}
export function countArchived(): number {
  return (sqlite.prepare("SELECT COUNT(*) n FROM runs WHERE COALESCE(archived,0) = 1").get() as { n: number }).n;
}
export function setArchived(id: string, archived: boolean) {
  sqlite.prepare("UPDATE runs SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, now(), id);
}
export function getRun(id: string): Run | null {
  return (sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run) ?? null;
}
export function createRun(r: {
  id: string; title: string; goal: string; machine_id: string; workspace: string;
  repo_path?: string | null; base_branch?: string | null; branch_name?: string | null;
  primary_model?: string | null; vision_model?: string | null; gate_mode?: "all" | "machine" | "none";
  apply_principles?: boolean;
}) {
  const t = now();
  sqlite.prepare(`
    INSERT INTO runs (id, title, goal, machine_id, state_index, status, workspace, repo_path, base_branch, branch_name, primary_model, vision_model, loop_count, auto_mode, gate_mode, conductor_mode, conductor_react, apply_principles, created_at, updated_at)
    VALUES (@id, @title, @goal, @machine_id, 0, 'idle', @workspace, @repo_path, @base_branch, @branch_name, @primary_model, @vision_model, 0, 0, @gate_mode, 'auto', 'auto', @apply_principles, @t, @t)
  `).run({
    id: r.id, title: r.title, goal: r.goal, machine_id: r.machine_id, workspace: r.workspace,
    repo_path: r.repo_path ?? null, base_branch: r.base_branch ?? null, branch_name: r.branch_name ?? null,
    primary_model: r.primary_model ?? null, vision_model: r.vision_model ?? null, gate_mode: r.gate_mode || "machine",
    apply_principles: r.apply_principles === false ? 0 : 1, t,
  });
  // Seed this run's North Star criteria from the loop template's defaults (a fresh, editable copy).
  const tmpl = getMachine(r.machine_id)?.settings.criteria || [];
  if (tmpl.length) setCriteria(r.id, tmpl.map(c => ({ text: c.text, status: "pending" })));
  return getRun(r.id)!;
}
export function updateRun(id: string, patch: Partial<Run>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map(k => `${k} = @${k}`).join(", ");
  sqlite.prepare(`UPDATE runs SET ${set}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, id, updated_at: now() });
}

// ---------- events ----------
export function addEvent(e: { id: string; run_id: string; state: string; type: string; content: unknown }) {
  sqlite.prepare("INSERT INTO events (id, run_id, state, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.id, e.run_id, e.state, e.type, JSON.stringify(e.content ?? {}), now());
}
export function listEvents(runId: string, afterId?: string): FactoryEvent[] {
  // Order by rowid (insertion order) — ids are random nanoids, so ORDER BY id
  // would shuffle the activity log into nonsense.
  if (afterId) {
    return sqlite.prepare("SELECT * FROM events WHERE run_id = ? AND rowid > (SELECT rowid FROM events WHERE id = ?) ORDER BY rowid").all(runId, afterId) as FactoryEvent[];
  }
  return sqlite.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY rowid").all(runId) as FactoryEvent[];
}

// ---------- artifacts ----------
export function addArtifact(a: { id: string; run_id: string; state: string; name: string; kind: string; body: string }) {
  // Upsert by (run_id, state, name): re-presenting the same named deliverable
  // UPDATES it in place rather than piling up duplicates. The agent decides what
  // to present; the tool just doesn't show "Option 1" five times.
  const existing = sqlite.prepare("SELECT id FROM artifacts WHERE run_id = ? AND state = ? AND name = ?").get(a.run_id, a.state, a.name) as { id: string } | undefined;
  if (existing) {
    sqlite.prepare("UPDATE artifacts SET kind = ?, body = ?, created_at = ? WHERE id = ?").run(a.kind, a.body, now(), existing.id);
  } else {
    sqlite.prepare("INSERT INTO artifacts (id, run_id, state, name, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.run_id, a.state, a.name, a.kind, a.body, now());
  }
}
export function listArtifacts(runId: string): Artifact[] {
  return sqlite.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY rowid").all(runId) as Artifact[];
}
export function getArtifact(id: string): Artifact | null {
  return (sqlite.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact) ?? null;
}

// ---------- deliverables (files an agent RETURNS to the human via return_file) ----------
// Unlike artifacts (which reference a live workspace path), a deliverable owns a
// PERSISTENT copy of the file under DELIVERABLES_DIR, so it stays downloadable after
// the run's worktree is gone. A run can have many (multiple return_file calls).
export function addDeliverable(d: { id: string; run_id: string; state: string; filename: string; stored_path: string; size: number; mime: string; label?: string | null; description?: string | null; is_final?: boolean; loop?: number }) {
  sqlite.prepare("INSERT INTO deliverables (id, run_id, state, filename, stored_path, size, mime, label, description, is_final, loop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(d.id, d.run_id, d.state, d.filename, d.stored_path, d.size, d.mime, d.label ?? null, d.description ?? null, d.is_final ? 1 : 0, d.loop ?? 0, now());
}
/** Clear the current FINAL flag for a run — the next expose_output call becomes the sole exposed set. */
export function clearFinalDeliverables(runId: string) {
  sqlite.prepare("UPDATE deliverables SET is_final = 0 WHERE run_id = ?").run(runId);
}
export function listDeliverables(runId: string): Deliverable[] {
  return sqlite.prepare("SELECT * FROM deliverables WHERE run_id = ? ORDER BY rowid").all(runId) as Deliverable[];
}
export function getDeliverable(id: string): Deliverable | null {
  return (sqlite.prepare("SELECT * FROM deliverables WHERE id = ?").get(id) as Deliverable) ?? null;
}

// ---------- comments (mock/artifact review annotations) ----------
export function addComment(c: { id: string; run_id: string; state: string; artifact_id?: string | null; artifact_name?: string | null; anchor: string; body: string; image?: string | null; author?: string | null; parent_id?: string | null }) {
  sqlite.prepare("INSERT INTO comments (id, run_id, state, artifact_id, artifact_name, anchor, body, image, author, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .run(c.id, c.run_id, c.state, c.artifact_id ?? null, c.artifact_name ?? null, c.anchor, c.body, c.image ?? null, c.author ?? null, c.parent_id ?? null, now());
}
export function listComments(runId: string): Comment[] {
  return sqlite.prepare("SELECT * FROM comments WHERE run_id = ? ORDER BY rowid").all(runId) as Comment[];
}
export function listOpenComments(runId: string, state?: string): Comment[] {
  return state
    ? sqlite.prepare("SELECT * FROM comments WHERE run_id = ? AND state = ? AND status = 'open' ORDER BY rowid").all(runId, state) as Comment[]
    : sqlite.prepare("SELECT * FROM comments WHERE run_id = ? AND status = 'open' ORDER BY rowid").all(runId) as Comment[];
}
export function deleteComment(id: string) { sqlite.prepare("DELETE FROM comments WHERE id = ?").run(id); }
export function updateCommentBody(id: string, body: string) { sqlite.prepare("UPDATE comments SET body = ? WHERE id = ?").run(body, id); }
export function markCommentsSent(runId: string, state: string) {
  sqlite.prepare("UPDATE comments SET status = 'sent' WHERE run_id = ? AND state = ? AND status = 'open'").run(runId, state);
}
/** Mark every open comment on a run as sent — used when the Conductor consumes them all at once. */
export function markAllOpenSent(runId: string) {
  sqlite.prepare("UPDATE comments SET status = 'sent' WHERE run_id = ? AND status = 'open'").run(runId);
}
/** Clear comments — "handled" removes the ones the Conductor already acted on; "all" wipes them. */
export function clearComments(runId: string, scope: "all" | "handled" = "all") {
  if (scope === "handled") sqlite.prepare("DELETE FROM comments WHERE run_id = ? AND status = 'sent'").run(runId);
  else sqlite.prepare("DELETE FROM comments WHERE run_id = ?").run(runId);
}

// ---------- conductor session ----------
export function addConductorMessage(m: { id: string; run_id: string; role: ConductorMsg["role"]; body: string; directive?: string | null; status?: ConductorMsg["status"]; image?: string | null }) {
  sqlite.prepare("INSERT INTO conductor_messages (id, run_id, role, body, directive, status, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(m.id, m.run_id, m.role, m.body, m.directive ?? null, m.status ?? "", m.image ?? null, now());
}
export function listConductorMessages(runId: string): ConductorMsg[] {
  return sqlite.prepare("SELECT * FROM conductor_messages WHERE run_id = ? ORDER BY rowid").all(runId) as ConductorMsg[];
}
export function clearConductorMessages(runId: string) {
  sqlite.prepare("DELETE FROM conductor_messages WHERE run_id = ?").run(runId);
}
export function getConductorMessage(id: string): ConductorMsg | null {
  return (sqlite.prepare("SELECT * FROM conductor_messages WHERE id = ?").get(id) as ConductorMsg) || null;
}
export function updateConductorMessage(id: string, patch: { status?: ConductorMsg["status"]; body?: string }) {
  const cur = getConductorMessage(id); if (!cur) return;
  sqlite.prepare("UPDATE conductor_messages SET status = ?, body = ? WHERE id = ?")
    .run(patch.status ?? cur.status, patch.body ?? cur.body, id);
}
