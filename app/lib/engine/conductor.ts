/**
 * The Conductor — a per-loop agent that reads ALL the feedback (comments left on
 * any phase's artifacts, plus rejects/feedback in the history, plus the human's
 * notes to it) and decides what the state machine should do: which phase to
 * re-enter and a crisp revision brief for the running agent.
 *
 * It's decoupled from the SDLC: feedback can arrive anytime — running, paused, or
 * done — and the Conductor figures out where it belongs. In "propose" mode it
 * waits for your ok; in "auto" mode it routes itself (respecting the loop cap).
 */
import { nanoid } from "nanoid";
import { spawn } from "child_process";
import { killTree } from "./proc";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getRun, getMachine, updateRun, upsertMachine, listEvents, listOpenComments, listComments, markAllOpenSent,
  addConductorMessage, listConductorMessages, getConductorMessage, updateConductorMessage, setCriteria,
  type Comment, type ConductorMsg, type Run, type Machine, type NorthStarCriterion,
} from "../db";
import { parseModel, isMultimodalPrimary } from "./models";
import { describeImage } from "./vision";
import { reviseFrom, goToPhase, parseImages, feedbackImagesContext, maybeReflect } from "./runner";

/** A single change to the LOOP template (a phase's config, or adding/removing a phase). */
export interface LoopEditOp {
  op: "set_field" | "add_state" | "remove_state";
  stateId?: string;                                              // set_field / remove_state target
  field?: "name" | "prompt" | "tools" | "gate" | "rejectTo";    // set_field
  value?: unknown;                                               // set_field new value; add_state full state def
  after?: number;                                                // add_state: insert after this phase index
}
export interface LoopEdit {
  summary: string;         // one-line description of what changes and why
  ops: LoopEditOp[];
}

export interface Directive {
  action: "route" | "hold" | "edit_loop";
  targetState?: string;   // state id to re-enter
  targetName?: string;    // its display name
  brief?: string;         // the revision brief handed to the agent
  keep?: string[];        // phases left as-is
  commentIds?: string[];  // comments this directive consumed
  commentSig?: string;    // signature (id:body) of the open comments it was based on — lets the UI detect new/edited comments
  loopEdit?: LoopEdit;    // action "edit_loop" only — a proposed change to the loop template (ALWAYS approval-gated)
}

/** Validate the model's proposed loop edit against the real machine — drop any op that
 *  targets a non-existent phase or has a malformed value, so a bad suggestion can't corrupt
 *  the template. Returns null if nothing valid survives. */
function normalizeLoopEdit(raw: any, machine: Machine): LoopEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const ops: LoopEditOp[] = [];
  for (const o of Array.isArray(raw.ops) ? raw.ops : []) {
    if (!o || typeof o !== "object") continue;
    if (o.op === "set_field") {
      const st = machine.states.find(s => s.id === o.stateId);
      const field = o.field;
      if (!st || !["name", "prompt", "tools", "gate", "rejectTo"].includes(field)) continue;
      let value = o.value;
      if (field === "tools") { if (typeof value === "string") value = value.split(/[,\s]+/).filter(Boolean); if (!Array.isArray(value)) continue; }
      else if (field === "gate") value = !!value;
      else if (field === "rejectTo") { if (value != null && !machine.states.some(s => s.id === value)) continue; }
      else if (typeof value !== "string") continue; // name / prompt
      ops.push({ op: "set_field", stateId: o.stateId, field, value });
    } else if (o.op === "add_state") {
      const s = o.value;
      if (s && typeof s === "object" && s.name && s.prompt) ops.push({ op: "add_state", value: s, after: typeof o.after === "number" ? o.after : undefined });
    } else if (o.op === "remove_state") {
      if (machine.states.length > 1 && machine.states.some(s => s.id === o.stateId)) ops.push({ op: "remove_state", stateId: o.stateId });
    }
  }
  if (!ops.length) return null;
  return { summary: String(raw.summary || "Edit the loop").slice(0, 300), ops };
}

/** Human-readable bullet list of a proposed loop edit, for the Conductor chat message. */
function describeLoopEdit(le: LoopEdit, machine: Machine): string {
  const nameOf = (id?: string) => machine.states.find(s => s.id === id)?.name || id || "?";
  return le.ops.map(o => {
    if (o.op === "set_field") {
      if (o.field === "prompt") return `• **${nameOf(o.stateId)}** — rewrite its prompt`;
      if (o.field === "tools") return `• **${nameOf(o.stateId)}** — set tools: ${(o.value as string[]).join(", ")}`;
      if (o.field === "gate") return `• **${nameOf(o.stateId)}** — ${o.value ? "require approval" : "remove approval gate"}`;
      if (o.field === "rejectTo") return `• **${nameOf(o.stateId)}** — on reject, loop back to **${nameOf(o.value as string)}**`;
      if (o.field === "name") return `• **${nameOf(o.stateId)}** — rename to "${o.value}"`;
    }
    if (o.op === "add_state") return `• add a new phase **"${(o.value as any).name}"**`;
    if (o.op === "remove_state") return `• remove the **"${nameOf(o.stateId)}"** phase`;
    return "";
  }).filter(Boolean).join("\n");
}

function slugId(name: string, existing: Set<string>): string {
  const base = String(name || "state").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "state";
  let id = base, n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Apply an approved loop edit to the machine template and persist it (settings + learned
 *  principles are carried over untouched). Returns the updated machine. */
function applyLoopEdit(machine: Machine, le: LoopEdit): Machine {
  let states: any[] = machine.states.map(s => ({ ...s }));
  for (const o of le.ops) {
    if (o.op === "set_field") {
      const s = states.find(x => x.id === o.stateId); if (!s) continue;
      s[o.field!] = o.value;
    } else if (o.op === "add_state") {
      const ids = new Set(states.map(s => s.id));
      const src = o.value as any;
      const st = { id: src.id && !ids.has(src.id) ? src.id : slugId(src.name, ids), name: String(src.name), prompt: String(src.prompt), tools: Array.isArray(src.tools) ? src.tools : ["read_file", "write_file", "display_artifact"], gate: src.gate !== false, ...(src.rejectTo ? { rejectTo: src.rejectTo } : {}) };
      const at = typeof o.after === "number" ? Math.min(Math.max(o.after + 1, 0), states.length) : states.length;
      states.splice(at, 0, st);
    } else if (o.op === "remove_state") {
      states = states.filter(s => s.id !== o.stateId);
      for (const s of states) if (s.rejectTo === o.stateId) delete s.rejectTo;
    }
  }
  return upsertMachine({ id: machine.id, name: machine.name, description: machine.description, states, settings: machine.settings });
}

// A human-readable line for one investigation step (tool call) the Conductor takes.
function activityLine(name: string, input: any): string {
  const base = (p?: string) => (p ? String(p).split("/").pop() : "") || "";
  if (name === "Read") return `📖 Read ${base(input?.file_path)}`;
  if (name === "Grep") return `🔎 Grep ${input?.pattern ? `"${String(input.pattern).slice(0, 40)}"` : ""}`.trim();
  if (name === "Glob") return `📁 Glob ${input?.pattern || ""}`.trim();
  if (name === "Bash") return `💻 ${String(input?.command || "").replace(/\s+/g, " ").slice(0, 60)}`;
  return `🔧 ${name}`;
}

// ---------- a one-shot LLM call; with onActivity it streams the tool steps it takes ----------
async function callOnce(modelStr: string | null, prompt: string, opts: { imageDataUrls?: string[]; cwd?: string; signal?: AbortSignal; onActivity?: (line: string) => void } = {}): Promise<string> {
  const ref = parseModel(modelStr, "ollama:glm-5.2:cloud");
  // ALWAYS run one-shots through the Claude Code harness — the same auth path as
  // the agent, so it works off the ollama CLI's own login (never the in-process
  // client / OLLAMA_API_KEY):
  //   ollama models → `ollama launch claude --model <tag> -- -p … --output-format text`
  //   claude models → `claude -p … --output-format text`
  // If the human attached image(s), drop each to a temp file and let this one-shot READ them
  // (a multimodal model sees them; a text-only one just notes it can't).
  const imgPaths: string[] = [];
  for (const url of (opts.imageDataUrls || []).slice(0, 8)) {
    const m = url?.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) continue;
    const p = join(tmpdir(), `conductor-img-${process.pid}-${Date.now()}-${imgPaths.length}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
    try { await fs.writeFile(p, Buffer.from(m[2], "base64")); imgPaths.push(p); } catch { /* skip this one */ }
  }
  if (imgPaths.length) prompt += `\n\nThey ATTACHED ${imgPaths.length === 1 ? "AN IMAGE" : `${imgPaths.length} IMAGES`} at ${imgPaths.join(", ")} — use your Read tool to view ${imgPaths.length === 1 ? "it" : "them"} and factor ${imgPaths.length === 1 ? "it" : "them"} in (visual feedback, e.g. screenshots of what they're asking about).`;
  // With onActivity we stream the tool steps (so the UI can show what it's doing). The
  // final answer then comes from the stream's "result" event, not raw stdout.
  const stream = !!opts.onActivity;
  const claudeArgs = ["-p", prompt, "--output-format", stream ? "stream-json" : "text"];
  if (stream) claudeArgs.push("--verbose");
  // With a cwd (the run's workspace) or an image, run with tools enabled so the Conductor
  // can INVESTIGATE — read the source, grep, read the spec/diff/artifacts — before answering.
  if (opts.cwd || imgPaths.length) claudeArgs.push("--permission-mode", "bypassPermissions");
  let command: string, args: string[];
  if (ref.provider === "ollama") {
    const tag = ref.model.includes(":cloud") ? ref.model : `${ref.model}:cloud`;
    command = "ollama"; args = ["launch", "claude", "--model", tag, "--", ...claudeArgs];
  } else {
    if (ref.model && ref.model !== "default") claudeArgs.push("--model", ref.model);
    command = "claude"; args = claudeArgs;
  }
  return await new Promise<string>((resolve) => {
    const cp = spawn(command, args, { env: process.env, cwd: opts.cwd || undefined, detached: true });
    const onAbort = () => killTree(cp);
    opts.signal?.addEventListener("abort", onAbort);
    let out = "", err = "", result = "", sbuf = "";
    cp.stderr?.on("data", d => (err += d));
    const done = (v: string) => { opts.signal?.removeEventListener("abort", onAbort); for (const p of imgPaths) fs.unlink(p).catch(() => {}); resolve(v); };
    if (stream) {
      cp.stdout.on("data", chunk => {
        sbuf += chunk.toString(); let nl: number;
        while ((nl = sbuf.indexOf("\n")) >= 0) {
          const line = sbuf.slice(0, nl).trim(); sbuf = sbuf.slice(nl + 1);
          if (!line) continue;
          let e: any; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "assistant") { for (const c of e.message?.content || []) {
            if (c.type === "tool_use") opts.onActivity!(activityLine(c.name, c.input));
            else if (c.type === "text" && String(c.text || "").trim()) opts.onActivity!("💭 " + String(c.text).trim().replace(/\s+/g, " ").slice(0, 140));
          } }
          else if (e.type === "result" && typeof e.result === "string") result = e.result;
        }
      });
      cp.on("close", () => done(result.trim() || (err.trim() ? `(the model call produced no answer — ${err.trim().slice(0, 300)})` : "")));
    } else {
      cp.stdout.on("data", d => (out += d));
      // surface stderr if the model produced no stdout — otherwise a bad cwd / spawn failure looks like "nothing to do".
      cp.on("close", () => done(out.trim() || (err.trim() ? `(the model call produced no answer — ${err.trim().slice(0, 300)})` : "")));
    }
    cp.on("error", (e) => done(`(could not run the Conductor model: ${e instanceof Error ? e.message : String(e)})`));
  });
}

// Pull a JSON object out of a model response (handles ```json fences + prose).
function extractJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** The model sometimes writes a "numbered" brief/answer as one inline run
 *  ("1. foo 2. bar 3. baz"); markdown then renders only item 1 as a list and crams the rest
 *  into its text (looks broken — see the Conductor brief). Put each "N." item on its own
 *  line so it renders as a real list. Conservative: only breaks a " N. " that follows other
 *  text on the same line, so an already newline-separated list is left untouched. */
function breakInlineList(s: string): string {
  return s ? s.replace(/([^\n])[ \t]+(\d{1,2}\.\s)/g, "$1\n$2") : s;
}

function anchorLabel(anchorJson: string): string {
  try {
    const a = JSON.parse(anchorJson);
    if (a.type === "pin") return ` (pinned at ${Math.round(a.x)}% across, ${Math.round(a.y)}% down)`;
    if (a.type === "video") return ` (at ${fmt(a.t)} in the video)`;
    if (a.type === "text" && a.quote) return ` (on the text: "${String(a.quote).slice(0, 100)}")`;
  } catch {}
  return "";
}
function fmt(s: number) { const m = Math.floor(s / 60), sec = Math.round(s % 60); return `${m}:${String(sec).padStart(2, "0")}`; }

function buildPrompt(run: Run, machine: Machine, comments: Comment[], chat: ConductorMsg[], source: "chat" | "feedback"): string {
  const byState = new Map<string, Comment[]>();
  for (const c of comments) { const k = c.state || "(loop)"; (byState.get(k) || byState.set(k, []).get(k)!).push(c); }
  const nameOf = (id: string) => machine.states.find(s => s.id === id)?.name || id;

  // Phases the human turned OFF for THIS run — the driver skips them, so the Conductor must not
  // route into one (route to the nearest ON phase instead).
  const disabled = new Set<string>();
  try { const a = JSON.parse(run.disabled_states || "[]"); if (Array.isArray(a)) a.forEach(x => disabled.add(String(x))); } catch { /* none */ }
  const states = machine.states.map((s, i) => `  ${i}. ${s.name} (id: ${s.id})${disabled.has(s.id) ? " — ⏭ OFF for this run (skipped by the driver — do NOT route here)" : ""}${s.rejectTo ? ` — can loop back to ${s.rejectTo}` : ""}`).join("\n");
  const current = machine.states[run.state_index];
  const offList = machine.states.filter(s => disabled.has(s.id)).map(s => s.name);

  // The EDITABLE loop template — full config so the Conductor can propose precise edits to it.
  const loopConfig = machine.states.map((s, i) =>
    `  [${i}] id:${s.id} · "${s.name}"${s.gate === false ? " · no-gate" : " · gate"}${s.rejectTo ? ` · rejects→${s.rejectTo}` : ""}\n     tools: ${(s.tools || []).join(", ") || "(none)"}\n     prompt: ${String(s.prompt || "").replace(/\s+/g, " ").slice(0, 700)}`
  ).join("\n");

  const feedbackBlock = comments.length
    ? [...byState.entries()].map(([sid, cs]) =>
        `### ${nameOf(sid)} (${cs.length})\n${cs.map((c, i) => `  ${i + 1}. ${c.author ? `${c.author} ` : ""}on "${c.artifact_name || sid}"${anchorLabel(c.anchor)}${c.parent_id ? " (reply)" : ""}: ${c.body}`).join("\n")}`
      ).join("\n\n")
    : "(no pinned comments)";

  const recentNotes = chat.filter(m => m.role === "you").slice(-4).map(m => `  - ${m.body}`).join("\n");

  // What you've ALREADY acted on — so you track executed vs remaining and don't repeat yourself.
  const executed = chat.filter(m => m.directive && m.status === "applied").map(m => {
    try { const d = JSON.parse(m.directive!); return `  - sent it back to ${d.targetName}: ${(d.brief || "").split("\n")[0].slice(0, 100)}`; } catch { return ""; }
  }).filter(Boolean).join("\n");

  // The SAME Conductor serves two very different triggers, and it must behave differently:
  //   • "chat"     — the human is talking to you in the chat box. Default to CONVERSATION.
  //   • "feedback" — reviewers left pinned comments to be acted on. Default to ROUTING.
  const lens = source === "chat"
    ? `\n⚑ THIS IS A CHAT TURN. They are talking to you directly, and THEIR MESSAGE ITSELF IS THE THING TO ACT ON — treat what they typed exactly like a comment they pinned. You do NOT need any pinned comments to act: if "OPEN FEEDBACK" below says "(no pinned comments)", that's normal and is NOT a reason to refuse — the instruction is what they just said to you. NEVER reply that you "don't see any comments", that there's "nothing to act on", or that you "can't do that" because there are no comments — that is always the wrong answer here.

Decide by what they're actually asking:
• They ask you to MAKE A CHANGE — "fix this", "change X", "redo Y", "add Z", "send it back", "make it …", or any imperative/request to do something: JUST DO IT. Treat their words as the brief and action "route" to the EARLIEST phase whose artifact must change (or action "edit_loop" if they're changing how the loop itself works). Their exact words are handed to the agent verbatim, so route even if you'd phrase the fix differently — don't stall asking for a pinned comment first.
• They ask a QUESTION, react, or think out loud ("why is it doing that?", "what do you think?", "this seems vague"): DEFAULT TO CONVERSATION — action "hold" and reply as a thought-partner. Don't route just because something *could* be improved.

Investigate the code (Read/Grep/Glob) only when your answer or your change needs grounding in the source — a casual remark needs no tool calls. Don't re-initiate the loop merely to have a conversation.\n`
    : `\n⚑ THIS IS A FEEDBACK PASS. They left the comments below to be acted on — read them, pick the EARLIEST phase whose artifact must change, and route with a crisp brief. If there is genuinely nothing to change, "hold".\n`;

  return `You are the CONDUCTOR of an agentic build pipeline (a state machine). One agent runs a "loop" (a goal) through ordered phases, each producing a distinct artifact. Your teammate (the person using Atelier) pins comments to any phase's artifact and talks to you here, any time. You are running INSIDE the run's workspace (the real repo), so you can Read / Grep / Glob the source, the spec, the git diff and the artifacts. Investigate the code whenever your answer needs grounding in it (but see the mode note below: don't investigate or route for a plain conversation).

VOICE — this matters: you are a collaborator on their team, working the problem WITH them, not a gatekeeper handing down verdicts. In your reply (the "reasoning" field) talk straight TO them and say "you". Never call them "the human", "the user", or "the person". Be warm, plain, and direct, like a good teammate thinking out loud. When something they are seeing is actually the intended behavior, do NOT dismiss it with "works as designed" or "not a bug" — that reads as cold and defensive. Instead explain how it actually works, and check whether that is what they wanted. Take their ideas seriously and build on them.

Your job has FOUR parts:
(1) ROUTE — read the feedback and decide the EARLIEST phase to re-enter so the agent fixes everything in one pass, with a crisp revision brief. (This re-runs part of the CURRENT run.)
(2) ANSWER — when they ask why something behaves the way it does, investigate and tell them straight whether it is a genuine bug or the intended behavior, and explain it so it makes sense.
(3) THOUGHT-PARTNER — when they are brainstorming, floating an idea, or asking how to improve something or get around a limitation, be a collaborator, not a gatekeeper: dig into the code, then propose concrete options (including ones not yet in the codebase), weigh the tradeoffs honestly, push back on or build on their idea, and turn anything worth doing into a route + brief. Be genuinely creative here: generate real alternatives, don't just validate or dismiss. But routing is OPT-IN, not reflexive: only route when they want a change made now, never just because something *could* be improved.
(4) EDIT THE LOOP — when they want to change how the LOOP ITSELF works (its phases, a phase's PROMPT, its TOOLS, its approval GATE, or its reject ROUTING), e.g. "change how the critique works", "make the compose phase reuse captures", "this phase should use the vision model not Gemini", "add a QA phase", "the loop keeps re-shooting", propose an "edit_loop": a concrete, minimal set of edits to the loop template below. This changes the TEMPLATE for future runs (routing only re-runs the current run). You NEVER apply a loop edit yourself: you only propose it, and they click Apply. Propose the SMALLEST edit that achieves what they asked, and explain what changes and why in "reasoning".
${lens}
LOOP GOAL: ${run.goal}

PHASES (earliest first):
${states}

CURRENT PHASE: ${current ? `${current.name} (id: ${current.id})` : "(done)"}  ·  STATUS: ${run.status}
${offList.length ? `\n⏭ TURNED OFF FOR THIS RUN (the human is moving faster): ${offList.join(", ")}. The driver SKIPS these, so NEVER route into one — pick the nearest ON phase instead. If a change genuinely requires a phase that's off, say so plainly and suggest they turn it back on rather than routing there.\n` : ""}
THE EDITABLE LOOP TEMPLATE (each phase's real config — use these exact ids/fields when you propose an edit_loop):
${loopConfig}

OPEN FEEDBACK (what REMAINS to act on), grouped by the phase whose artifact it's pinned to:
${feedbackBlock}
${executed ? `\nYou've ALREADY EXECUTED these routes this loop (don't repeat them; build on them):\n${executed}` : ""}
${recentNotes ? `\nThey also told you directly:\n${recentNotes}` : ""}

Decide:
- If they are BRAINSTORMING or asking a DESIGN / "how could we…" / "is there a better approach" / "what do you think of <idea>" / "any way around X?" question: engage as a THOUGHT-PARTNER. Ground yourself in the code first, then give 2–4 concrete approaches with honest tradeoffs and a recommended first step. Never shut a forward-looking idea down by saying the current code is fine or the limit is external; that misreads the question and comes off dismissive. Take the idea seriously, say what you'd actually do, and if an approach is worth pursuing, ROUTE it (action "route" + brief, usually Spec for an architecture change, Build for a code change).
- If they reported a PROBLEM with how something CURRENTLY behaves (a complaint, "this is broken", "it still fails"), or asked a QUESTION (or attached an image asking "what is this / is this a bug / why does it do X?"), INVESTIGATE first: Read / Grep / Glob the relevant source, spec.md, the git diff, and the artifacts. THEN answer plainly in "reasoning", grounded in what you actually read (cite file:line), and be honest about which it is:
    • a GENUINE BUG — the code is actually wrong/broken. Name the file:line, and if it's worth fixing now, route the agent to fix it (action "route" + a brief).
    • INTENDED BEHAVIOR — it's working the way it's meant to. Don't slap a "works as designed" or "not a bug" label on it; just walk them through how it actually works so it clicks, and check whether that's what they wanted (often it's a small gap in understanding, and sometimes what they want IS a change you can route).
    • NOT SURE YET — say what you'd need to confirm.
  You are READ-ONLY: investigate by reading; NEVER edit files or run mutating commands. The ONLY way to actually change anything is to ROUTE the agent.
  ⚠️ CRITICAL — you CANNOT run or SEE the app; you only read code. So for a VISUAL or BEHAVIOURAL complaint (a screenshot showing something looks/animates/lays out wrong), the code "looking correct" is NOT evidence it works: code intent ≠ the rendered result, and an existing "fix" in the code can itself be the bug. NEVER call a visual complaint intended-behavior from reading code alone: they are looking at the real output and you are not, so their screenshot OUTRANKS your reading of the code. Default to treating it as a real bug and ROUTE TO BUILD to REPRODUCE it against the running app (screenshot/record), find the true root cause, and fix it. Do NOT bounce it to QA just to "re-capture proof", and do NOT trust that an already-present fix works without it being verified in the actual render. Only treat a visual complaint as intended-behavior once Build/QA has shown captured proof it renders correctly.
- For actionable FEEDBACK to fix: pick the EARLIEST phase whose artifact must change (a spec gap → Spec; a visual/code issue → Build; feedback pinned to "Mock" usually → Build, not re-do the mock, unless the mock itself is wrong). action "route" with a numbered brief.
- If there's nothing to do and no question, action is "hold".

- If they want to change the LOOP ITSELF (a phase's prompt/tools/gate/routing, or add/remove a phase): action "edit_loop" with a "loopEdit" describing the minimal edits. Use the exact phase ids from THE EDITABLE LOOP TEMPLATE above. Do NOT route AND edit in the same reply — pick the one they're actually asking for (a one-off fix to THIS run = route; a change to how the loop works = edit_loop).

Reply with ONE JSON object, nothing else:
{
  "action": "route" | "hold" | "edit_loop",
  "targetState": "<the state id to re-enter, if route>",
  "brief": "<a direct, numbered brief to the agent: exactly what to change, grounded in the comments. only if route. 1-8 items. Put EACH numbered item on its OWN line (use \\n between items) so it renders as a list — never run them together inline.>",
  "keep": ["<phase names that stay approved/untouched>"],
  "loopEdit": {
    "summary": "<one line: what this changes and why — only if edit_loop>",
    "ops": [
      { "op": "set_field", "stateId": "<phase id>", "field": "prompt" | "tools" | "gate" | "rejectTo" | "name", "value": "<new value — a full string for prompt/name, a string array for tools, a boolean for gate, a phase id (or null) for rejectTo>" },
      { "op": "add_state", "after": <index to insert after>, "value": { "name": "...", "prompt": "...", "tools": ["..."], "gate": true, "rejectTo": "<phase id, optional>" } },
      { "op": "remove_state", "stateId": "<phase id>" }
    ]
  },
  "reasoning": "<For a routing decision: 1-3 sentences explaining your call. For a COMPLAINT or QUESTION: your FULL answer — what's going on, whether it's a genuine bug or the intended behavior (explained warmly, never labeled 'works as designed'), grounded in the code you actually read (cite file:line). For a BRAINSTORM / DESIGN question: your concrete options, their tradeoffs, and a recommendation. For an edit_loop: what you're changing and why. Always grounded in the code you read (cite file:line). This is shown to them as your reply and addressed to 'you', so make it complete, warm, and clear.>"
}`;
}

/** Read the open feedback + chat and produce a directive. Stores a conductor
 *  message. In "auto" mode (and when it routes), applies it immediately.
 *  Single-flight per run: concurrent triggers (multiple browser tabs, rapid
 *  comments) share ONE in-progress call instead of each spending tokens. */
const synthInFlight = new Map<string, Promise<ConductorMsg | null>>();
const synthAbort = new Map<string, AbortController>();
// Live, in-memory log of the Conductor's investigation steps for a run (Read/Grep/…),
// so the UI can show "what it's doing" while it thinks. Reset each synthesis; kept after
// so the human can review what it looked at.
const conductorActivity = new Map<string, string[]>();
export function getConductorActivity(runId: string): string[] { return conductorActivity.get(runId) || []; }
export function clearConductorActivity(runId: string) { conductorActivity.delete(runId); }
/** Is the Conductor currently thinking for this run? (UI shows a Stop while true.) */
export function isConductorWorking(runId: string): boolean { return synthInFlight.has(runId); }
/** Cancel an in-flight Conductor synthesis — kills the model call. */
export function stopConductor(runId: string): boolean {
  const ac = synthAbort.get(runId);
  if (ac && !ac.signal.aborted) { ac.abort(); return true; }
  return false;
}
export function synthesize(runId: string, source: "chat" | "feedback" = "feedback"): Promise<ConductorMsg | null> {
  const existing = synthInFlight.get(runId);
  if (existing) return existing;
  const p = doSynthesize(runId, source).finally(() => synthInFlight.delete(runId));
  synthInFlight.set(runId, p);
  return p;
}
async function doSynthesize(runId: string, source: "chat" | "feedback"): Promise<ConductorMsg | null> {
  const run = getRun(runId); if (!run) return null;
  const machine = getMachine(run.machine_id); if (!machine) return null;
  const comments = listOpenComments(runId);
  const chat = listConductorMessages(runId);

  const prompt = buildPrompt(run, machine, comments, chat, source);
  // images only count if they're on the CURRENT (latest) human message — never reuse an
  // image from an earlier question on a later one that didn't attach anything.
  const lastImgs = parseImages([...chat].reverse().find(mm => mm.role === "you")?.image);
  // run IN the workspace so the Conductor can investigate (read source / spec / diff) to answer questions
  const ac = new AbortController();
  synthAbort.set(runId, ac);
  conductorActivity.set(runId, []); // fresh activity log for this pass
  const pushAct = (line: string) => { const a = conductorActivity.get(runId) || []; if (a[a.length - 1] !== line) a.push(line); if (a.length > 80) a.shift(); conductorActivity.set(runId, a); };
  // The Conductor's own model may be TEXT-ONLY (e.g. GLM / Kimi-code). If they attached image(s),
  // do NOT hand raw images to a model that will 400 ("does not support image input"). Route them
  // through the run's VISION helper (the loop's configured vision model), describe them, and pass
  // the description as text. A multimodal Conductor model (Claude) still reads the raw images itself.
  const condModel = run.conductor_model || run.primary_model;
  let promptForModel = prompt;
  let imagesForModel = lastImgs;
  if (lastImgs.length && !isMultimodalPrimary(condModel)) {
    const descs: string[] = [];
    for (let i = 0; i < lastImgs.length; i++) {
      pushAct(`👁 Reading image ${i + 1} with the vision helper`);
      try { const d = await describeImage({ dataUrl: lastImgs[i], visionModel: run.vision_model }); if (d.trim()) descs.push(lastImgs.length > 1 ? `Image ${i + 1}: ${d.trim()}` : d.trim()); } catch { /* skip this one */ }
    }
    promptForModel = descs.length
      ? prompt + `\n\n=== ATTACHED IMAGE${lastImgs.length > 1 ? "S" : ""} (they attached ${lastImgs.length === 1 ? "a screenshot" : `${lastImgs.length} screenshots`}; described here by the vision helper because your own model can't see images) ===\n${descs.join("\n\n")}`
      : prompt + `\n\n(They attached ${lastImgs.length} image${lastImgs.length > 1 ? "s" : ""}, but the vision helper (${run.vision_model || "none configured"}) could not read ${lastImgs.length > 1 ? "them" : "it"}. Tell them you can't see the image and suggest they set a vision-capable helper model.)`;
    imagesForModel = [];
  }
  let raw: string;
  try { raw = await callOnce(condModel, promptForModel, { imageDataUrls: imagesForModel, cwd: run.workspace, signal: ac.signal, onActivity: pushAct }); }
  finally { synthAbort.delete(runId); }
  if (ac.signal.aborted) { addConductorMessage({ id: nanoid(10), run_id: runId, role: "system", body: "⏹ Stopped.", status: "" }); return null; }
  // If the model answered in prose instead of JSON (common for a plain question), keep the
  // WHOLE answer — don't clip a multi-paragraph explanation to a couple sentences.
  const parsed = extractJson(raw) || { action: "hold", reasoning: (raw.trim() || "Nothing actionable yet.").slice(0, 8000) };
  // The model often emits a numbered brief/answer inline ("1. … 2. … 3. …"); break it onto
  // separate lines so it renders as a real list (in the chat AND in the brief sent to the agent).
  if (parsed.brief) parsed.brief = breakInlineList(String(parsed.brief));
  if (parsed.reasoning) parsed.reasoning = breakInlineList(String(parsed.reasoning));

  const route = parsed.action === "route" && parsed.targetState && machine.states.some((s: any) => s.id === parsed.targetState);
  const targetName = route ? (machine.states.find(s => s.id === parsed.targetState)?.name || parsed.targetState) : undefined;
  // A proposed edit to the LOOP TEMPLATE itself — ALWAYS approval-gated (never auto-applied,
  // in any autopilot mode). Routing re-runs the current run; this rewrites the template.
  const loopEdit = parsed.action === "edit_loop" ? normalizeLoopEdit(parsed.loopEdit, machine) : null;

  const body = loopEdit
    ? [parsed.reasoning || "", `\n\n**Proposed loop edit — ${loopEdit.summary}**\n${describeLoopEdit(loopEdit, machine)}`].join("").trim()
    : [
        parsed.reasoning || "",
        route ? `\n\n**Plan:** re-enter **${targetName}** with this brief:\n${parsed.brief || ""}` : "",
      ].join("").trim() || "Nothing actionable yet.";

  // signature of the exact open comments (id + text) this run saw — the UI uses it
  // to know when NEW or EDITED comments need a fresh pass.
  const sig = comments.map(c => `${c.id}:${c.body}`).sort().join("");
  const directive: Directive = loopEdit
    ? { action: "edit_loop", loopEdit, commentSig: sig }
    : route
    ? { action: "route", targetState: parsed.targetState, targetName, brief: parsed.brief || "", keep: parsed.keep || [], commentIds: comments.map(c => c.id), commentSig: sig }
    : { action: "hold", commentSig: sig };

  const id = nanoid(10);
  const mode = run.conductor_mode || "propose";
  // A loop edit ALWAYS waits for an explicit Apply click — never auto-applied, in any mode.
  const status: ConductorMsg["status"] = loopEdit ? "proposed" : route ? (mode === "auto" ? "applied" : "proposed") : "";
  // a fresh proposal supersedes any earlier one still awaiting your call, so a
  // burst of comments (or an edit) never stacks competing Approve buttons.
  if (route || loopEdit) for (const m of chat) { if (m.status === "proposed") updateConductorMessage(m.id, { status: "dismissed" }); }
  addConductorMessage({ id, run_id: runId, role: "conductor", body, directive: JSON.stringify(directive), status });

  if (route && mode === "auto") await applyNow(runId, machine, directive);
  return getConductorMessage(id);
}

/** "Since you last checked in": summarize the run's MAJOR events since a timestamp, in plain
 *  language (the process, not commands), for the activity panel's catch-up header. Read-only;
 *  stores nothing. Runs when the human opens the Conductor panel. */
export async function catchUp(runId: string, sinceTs = 0): Promise<{ summary: string; newCount: number }> {
  const run = getRun(runId); if (!run) return { summary: "", newCount: 0 };
  const machine = getMachine(run.machine_id);
  const nameOf = (sid: string) => machine?.states.find(s => s.id === sid)?.name || sid;
  const since = listEvents(runId).filter(e => e.created_at > sinceTs);
  const lines = since.map(e => {
    let c: any = {}; try { c = JSON.parse(e.content); } catch {}
    switch (e.type) {
      case "state_enter": return `→ entered ${c.name || nameOf(e.state)}`;
      case "reject": return `✗ ${nameOf(e.state)} rejected: ${String(c.reasons || "").slice(0, 160)}`;
      case "approval_request": return `⏸ ${nameOf(e.state)} asked for approval: ${String(c.summary || "").slice(0, 160)}`;
      case "approved": return `✓ approved ${nameOf(e.state)}`;
      case "done": return `✓ ${String(c.summary || c.message || "done").slice(0, 160)}`;
      case "feedback": return `[feedback] ${String(c.message || "").slice(0, 160)}`;
      case "artifact": return `produced "${c.name}"`;
      case "reflect": return `🧠 ${String(c.message || "").slice(0, 160)}`;
      case "error": return `error: ${String(c.message || "").slice(0, 160)}`;
      case "text": return c.channel === "log" ? "" : `· ${String(c.text || "").replace(/\s+/g, " ").slice(0, 180)}`;
      default: return "";
    }
  }).filter(Boolean);
  if (!lines.length) return { summary: "Nothing new since you last looked.", newCount: 0 };
  const prompt =
    `You are the Conductor of an agentic build run, catching your teammate up warmly. In 2–3 plain sentences, tell them what happened ` +
    `SINCE THEY LAST CHECKED IN — talk straight to them ("you"/"your run"), describe the PROCESS (what's being built / what the checks said), never tool names or commands. ` +
    `End with whether anything needs you, or say nothing needs you yet. No preamble, no lists.\n\n` +
    `GOAL: ${String(run.goal || "").slice(0, 400)}\n\nWHAT HAPPENED (oldest first):\n${lines.slice(-60).join("\n")}`;
  // This readback is generated by the run's OWN LLM (the model the human picked for the
  // run) — never a separate governor. Fall back to the governor only if no primary is set.
  const summary = await callOnce(run.primary_model || run.conductor_model, prompt).catch(() => "");
  return { summary: summary.trim() || "(couldn't summarize just now)", newCount: since.length };
}

/** Draft a short set of concrete, checkable ACCEPTANCE CRITERIA for a run from its goal, via one
 *  harness call, and save them (the human can then edit). These feed straight into the agent's and
 *  the north_star tool's prompts, so they anchor "done" — which is exactly why generating a good
 *  first set is worth a button. Returns the saved list, or null if nothing usable came back. */
export async function generateCriteria(runId: string): Promise<NorthStarCriterion[] | null> {
  const run = getRun(runId); if (!run) return null;
  const existing: string[] = (() => {
    try { const a = JSON.parse(run.criteria || "[]"); return Array.isArray(a) ? a.map((c: any) => String(c?.text || "").trim()).filter(Boolean) : []; }
    catch { return []; }
  })();
  const prompt = `You are helping define "done" for a build task. Read the GOAL and produce a short set of ACCEPTANCE CRITERIA: concrete, checkable conditions that must ALL hold for the work to count as complete.

Rules:
- 4 to 7 criteria (fewer if the goal is small). Each is ONE specific, verifiable condition you could check and answer yes/no on — not a vague aspiration.
- Cover what actually matters for THIS goal; no generic boilerplate padding.
- Phrase each as a short statement of the finished state (e.g. "The paywall never appears on a user's first session.").
${existing.length ? `- Some criteria already exist; produce a BETTER, complete set that supersedes them (keep the good ones):\n${existing.map(t => `  · ${t}`).join("\n")}\n` : ""}
GOAL:
${String(run.goal || "").slice(0, 6000)}

Reply with ONLY a JSON array of strings and nothing else. Example: ["First criterion.", "Second criterion."]`;
  const raw = await callOnce(run.primary_model || run.conductor_model, prompt).catch(() => "");
  let texts: string[] = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/); // tolerate any prose the model wraps around the array
    const arr = JSON.parse(m ? m[0] : raw);
    if (Array.isArray(arr)) texts = arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 8);
  } catch { return null; }
  if (!texts.length) return null;
  return setCriteria(runId, texts.map(t => ({ text: t, status: "pending" })));
}

async function applyNow(runId: string, machine: Machine, d: Directive) {
  const idx = machine.states.findIndex(s => s.id === d.targetState);
  if (idx < 0) return;
  // remember where the run sat BEFORE this route, so the human can revert it.
  const before = getRun(runId);
  if (before) updateRun(runId, { conductor_revert: JSON.stringify({ index: before.state_index, name: machine.states[before.state_index]?.name || "the previous phase" }) } as any);
  // Carry the human's EXACT WORDS + PINNED SCREENSHOTS through to the worker — not just the
  // Conductor's paraphrased brief. The build agent gets the verbatim feedback AND a usable
  // form of the images (Claude reads them; other models get a vision-model description).
  const acted = listComments(runId).filter(c => d.commentIds?.includes(c.id));
  const lastHuman = [...listConductorMessages(runId)].reverse().find(m => m.role === "you");
  const verbatim = [...acted.map(c => c.body?.trim()), lastHuman?.body?.trim()].filter(Boolean) as string[];
  const imgUrls = [...acted.flatMap(c => parseImages(c.image)), ...parseImages(lastHuman?.image)];
  const imgCtx = before ? await feedbackImagesContext(before, imgUrls) : "";
  const verbatimBlock = verbatim.length ? `\n\n=== YOUR TEAMMATE'S EXACT WORDS (verbatim — honor these; the brief above is only the Conductor's summary) ===\n${verbatim.map(v => `“${v}”`).join("\n")}` : "";
  markAllOpenSent(runId);
  reviseFrom(runId, idx, `The Conductor reviewed the feedback and is sending this back to ${d.targetName}. Address EVERY item; keep what wasn't mentioned:\n${d.brief}${verbatimBlock}${imgCtx}`);
}

/** Undo the Conductor's last applied route — rewind the run to where it was before. */
export function revertConductor(runId: string): boolean {
  const run = getRun(runId);
  if (!run?.conductor_revert) return false;
  let r: { index: number; name?: string };
  try { r = JSON.parse(run.conductor_revert); } catch { return false; }
  stopConductor(runId);
  goToPhase(runId, r.index);
  updateRun(runId, { conductor_revert: null } as any);
  addConductorMessage({ id: nanoid(10), run_id: runId, role: "system", body: `↩ Reverted the last route — back to ${r.name || "the previous phase"}.`, status: "" });
  return true;
}

/** Human approves a proposed directive → route the machine. */
export async function applyDirective(runId: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
  const msg = getConductorMessage(messageId);
  if (!msg || !msg.directive) return { ok: false, error: "no directive" };
  const run = getRun(runId); const machine = run && getMachine(run.machine_id);
  if (!run || !machine) return { ok: false, error: "no run" };
  const d = JSON.parse(msg.directive) as Directive;
  if (d.action === "edit_loop") {
    if (!d.loopEdit) return { ok: false, error: "no loop edit" };
    applyLoopEdit(machine, d.loopEdit);
    updateConductorMessage(messageId, { status: "applied" });
    addConductorMessage({ id: nanoid(10), run_id: runId, role: "system", body: `✓ Loop updated — ${d.loopEdit.summary}`, status: "" });
    return { ok: true };
  }
  const idx = machine.states.findIndex(s => s.id === d.targetState);
  if (idx < 0) return { ok: false, error: "unknown target" };
  await applyNow(runId, machine, d);
  updateConductorMessage(messageId, { status: "applied" });
  addConductorMessage({ id: nanoid(10), run_id: runId, role: "system", body: `Routed to ${d.targetName} — re-running with your approval.`, status: "" });
  return { ok: true };
}

export function dismissDirective(messageId: string) {
  updateConductorMessage(messageId, { status: "dismissed" });
}

/** The human types (and/or attaches an image) to the Conductor; we record it and
 *  re-synthesize with it in mind. Chatting does NOT pause the run — just talking to the
 *  Conductor shouldn't halt the build. This is a CHAT turn: the Conductor answers
 *  conversationally by default and only ROUTES when you clearly ask for a change; if it
 *  does route, reviseFrom interrupts the running phase itself, so no pre-pause is needed. */
export async function talkToConductor(runId: string, text: string, images?: string[]): Promise<ConductorMsg | null> {
  if (!text.trim() && !(images && images.length)) return null;
  addConductorMessage({ id: nanoid(10), run_id: runId, role: "you", body: text.trim(), status: "", image: images && images.length ? JSON.stringify(images) : null });
  // Self-learning: the Conductor chat is a feedback channel, so let the loop learn from it too.
  // Fire-and-forget; no-op unless self-learning is on, and the reflection model decides if there's
  // a durable lesson — a casual question or one-off yields no principle.
  if (text.trim()) maybeReflect(runId, text);
  // Investigate in the BACKGROUND so the UI never blocks (the reply arrives via the 1.5s poll;
  // the Stop button can cancel it). Runs as a CHAT turn — converse first, route only on request.
  void synthesize(runId, "chat").catch(() => {});
  return null; // returns immediately — the Conductor's reply shows up when it finishes
}

export function setConductorMode(runId: string, mode: "propose" | "auto") {
  updateRun(runId, { conductor_mode: mode });
}

/** "auto" = react to new comments on its own; "manual" = batch comments until the human
 *  hits "Review comments". */
export function setConductorReact(runId: string, react: "auto" | "manual") {
  updateRun(runId, { conductor_react: react } as any);
}

/** The UI exposes ONE "Autopilot" control that collapses react-cadence + route-approval
 *  into a single choice the way people actually think about it:
 *    auto    → reads new comments on its own AND routes the loop itself (no Approve prompt)
 *    propose → reads on its own, proposes a route, waits for your ok
 *    manual  → waits; batches comments until you hit Review, then proposes
 *  Flipping to full Auto also clears any route that was merely *proposed* under the old
 *  setting by applying the latest one now — otherwise a stale Approve button would linger. */
export async function setAutopilot(runId: string, autopilot: "auto" | "propose" | "manual"): Promise<void> {
  const react: "auto" | "manual" = autopilot === "manual" ? "manual" : "auto";
  const mode: "propose" | "auto" = autopilot === "auto" ? "auto" : "propose";
  updateRun(runId, { conductor_react: react, conductor_mode: mode } as any);
  if (autopilot !== "auto") return;
  // Only a proposed ROUTE gets auto-applied when flipping to full auto. A proposed LOOP EDIT
  // never auto-applies — it always waits for an explicit Apply click, regardless of this setting.
  const proposed = [...listConductorMessages(runId)].reverse().find(m => {
    if (m.status !== "proposed" || !m.directive) return false;
    try { return (JSON.parse(m.directive) as Directive).action === "route"; } catch { return false; }
  });
  if (proposed) await applyDirective(runId, proposed.id).catch(() => {});
}
