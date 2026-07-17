/**
 * Progress narrator — turns the agent's raw, technical activity ("→ Write app/page.tsx",
 * "→ Bash npm test") into a CLEAR, human progress view: one plain-language line of what it's
 * doing right now, plus an evolving todo/milestone checklist (like Claude Code's todos, but in
 * the UI). A small, cheap model (Haiku) summarizes; the result is emitted as a "progress" event
 * the run page renders. Throttled + fire-and-forget, so it never slows the real work; if the
 * model call fails, the UI just falls back to the raw activity line.
 *
 * This is an observability layer (like the Conductor), not stage-specific pipeline logic — it
 * summarizes whatever the agent does, the same way for every phase.
 */
import { nanoid } from "nanoid";
import { getRun, listEvents, addEvent } from "../db";
import { harnessOneShot } from "./oneshot";

const NARRATOR_MODEL = "claude:haiku"; // small + cheap; just summarizing
const MIN_INTERVAL_MS = 9000; // at most ~once per 9s per run

const throttle = new Map<string, { inFlight: boolean; lastAt: number }>();

/** Pull the first JSON object out of a model reply (tolerates prose / fences). */
function extractJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cands = [fence?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of cands) { try { return JSON.parse(c); } catch { /* next */ } }
  return null;
}

/** One compact line for a tool call: the tool + its key detail (path / command / query). */
function toolOneLiner(name: string, args: any): string {
  if (typeof args === "string") return `${name} ${args.slice(0, 90)}`;
  const a = args || {};
  const detail = a.file_path || a.path || a.command || a.pattern || a.query || a.url || a.name || "";
  return `${name}${detail ? " " + String(detail).replace(/\s+/g, " ").slice(0, 100) : ""}`;
}

/** Recent activity as a compact log + the last narrated todos (so we EVOLVE the list). */
function buildContext(runId: string): { log: string; prevTodos: { task: string; status: string }[] } {
  const events = listEvents(runId);
  let prevTodos: { task: string; status: string }[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "progress") { try { prevTodos = JSON.parse(events[i].content).todos || []; } catch { /* ignore */ } break; }
  }
  const log = events.slice(-46).map(e => {
    let c: any = {}; try { c = JSON.parse(e.content); } catch { /* ignore */ }
    if (e.type === "tool_call") return "→ " + toolOneLiner(c.name, c.args);
    if (e.type === "tool_result") return "  ⤷ " + String(c.result || "").replace(/\s+/g, " ").slice(0, 100);
    if (e.type === "text" && c.text) return "· " + String(c.text).replace(/\s+/g, " ").slice(0, 220);
    if (e.type === "feedback" && c.message) return "[human feedback] " + String(c.message).replace(/\s+/g, " ").slice(0, 160);
    return "";
  }).filter(Boolean).join("\n").slice(-4200);
  return { log, prevTodos };
}

/** Summarize the current progress with Haiku and emit a "progress" event. */
export async function narrateProgress(runId: string, stateId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || run.status !== "running") return;
  const { log, prevTodos } = buildContext(runId);
  if (!log.trim()) return;

  const prev = prevTodos.length ? prevTodos.map(t => `[${t.status}] ${t.task}`).join("\n") : "(none yet)";
  const prompt = `You narrate a coding agent's progress for a NON-TECHNICAL person watching a live UI. Turn its raw, technical activity into a clear, human progress view. Describe WHAT is being built/accomplished — never tool names, file paths, or shell commands.

GOAL of the work:
${String(run.goal || "").slice(0, 500)}

RECENT ACTIVITY (newest last):
${log}

CURRENT CHECKLIST — evolve THIS list: keep task wording stable, advance statuses as work completes, and append only genuinely new tasks (may be empty to start):
${prev}

Output ONLY JSON (no prose, no code fence):
{
  "current": "<short, plain-language phrase of the FINE-GRAINED step happening RIGHT NOW. This MUST be a sub-step of the ONE milestone you mark 'active' below — the same area of work, just more specific. At most 8 words, e.g. if the active milestone is 'Add the footer counter', current might be 'Wiring up the items-left counter'>",
  "todos": [ { "task": "<a concrete milestone/task in human terms, e.g. 'Add the footer counter', 'Persist todos to storage', 'Run the tests' — NOT a tool name or file path>", "status": "done" | "active" | "pending" } ]
}
Rules: 3 to 6 todos. EXACTLY ONE is "active" (what it's on now). Order them done → active → pending. Keep wording stable across updates so the list reads as steady progress, not churn. CRITICAL: "current" and the single "active" milestone must agree — "current" is the sub-step being done UNDER that milestone right now. Never let "current" describe work that belongs to a milestone you've already marked "done".`;

  const raw = await harnessOneShot(NARRATOR_MODEL, prompt).catch(() => "");
  const obj = extractJson(raw);
  if (!obj || !obj.current) return;

  // Only emit if we're still on this same running phase (the call is async).
  const fresh = getRun(runId);
  if (!fresh || fresh.status !== "running" || fresh.state_index == null) return;

  const todos = Array.isArray(obj.todos)
    ? obj.todos.filter((t: any) => t && t.task).slice(0, 8).map((t: any) => ({
        task: String(t.task).slice(0, 140),
        status: (["done", "active", "pending"].includes(t.status) ? t.status : "pending") as "done" | "active" | "pending",
      }))
    : [];
  addEvent({ id: nanoid(), run_id: runId, state: stateId, type: "progress", content: { current: String(obj.current).slice(0, 140), todos } });
}

/** Throttled trigger: call this as the agent works; it fires a narration at most once every
 *  ~9s per run (and never while one is already in flight). Fire-and-forget. */
export function maybeNarrate(runId: string, stateId: string): void {
  const s = throttle.get(runId) || { inFlight: false, lastAt: 0 };
  const now = Date.now();
  if (s.inFlight || now - s.lastAt < MIN_INTERVAL_MS) return;
  s.inFlight = true; s.lastAt = now; throttle.set(runId, s);
  narrateProgress(runId, stateId).catch(() => {}).finally(() => { const c = throttle.get(runId); if (c) c.inFlight = false; });
}
