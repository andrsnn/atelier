/**
 * THE SINGLE-AGENT STATE-MACHINE DRIVER.
 *
 * One agent (one primary model) takes a whole ticket from understanding → PR on a
 * real repo, across phases, with full memory the entire time. The machine is a
 * non-linear graph: review/QA/security/acceptance phases can REJECT and loop the
 * ticket BACK to an earlier phase (e.g. Build) to fix problems, then come forward
 * through the checks again — bounded, so it can't loop forever. The agent gives the
 * verdict; this runner only routes per config. No phase-specific or repo-specific
 * logic lives here — behaviour is prompts + tools. See CLAUDE.md.
 */
import { nanoid } from "nanoid";
import { promises as fs, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { randomBytes } from "crypto";
import {
  getRun, getMachine, updateRun, addEvent, addArtifact, addDeliverable, clearFinalDeliverables, listArtifacts, listEvents, listRuns,
  listOpenComments, markCommentsSent, markAllOpenSent, getCriteria,
  type StateDef, type Run, type Comment,
} from "../db";
import { runClaudePhase } from "./claude";
import { harnessOneShot } from "./oneshot";
import { parseModel, isMultimodalPrimary } from "./models";
import { analyzeImage } from "./vision";
import { setupWorktree, gitDiffStat } from "./worktree";
import { takePendingControl } from "./control";
import { killDevServer } from "./devserver";
import { FACTORY_ROOT } from "../sandbox";
import { getProjectByRepoPath } from "../projects";
import { reflectAndRecord, isSelfLearning } from "./reflect";
import { maybeNarrate } from "./narrator";
import type { ToolContext } from "./tools";

// How a phase ends — the verdict the runner routes on (set from the agent's
// final control tool, or from the harness result).
type PhaseEnd =
  | { kind: "approval"; summary: string }
  | { kind: "reject"; summary: string }
  | { kind: "complete"; summary: string }
  | { kind: "exhausted"; summary: string }
  | { kind: "error"; summary: string };

const inFlight = new Set<string>();           // a phase is currently being driven for this run
const activeRuns = new Set<string>();          // runs holding a concurrency SLOT (whole-ticket)
const runQueue: string[] = [];                 // runIds waiting (FIFO) for a slot
const controllers = new Map<string, AbortController>(); // per-run abort, for pause / rewind

// How many tickets may ACTIVELY run at once. Default 1 (a strict queue), so
// concurrent runs don't thrash shared resources (QA dev servers, ports, CPU).
// Configurable: FACTORY_MAX_CONCURRENT_RUNS env at boot, or setMaxConcurrent() at runtime.
let MAX_CONCURRENT = (() => { const n = parseInt(process.env.FACTORY_MAX_CONCURRENT_RUNS || "1", 10); return Number.isFinite(n) && n > 0 ? n : 1; })();
export function getMaxConcurrent() { return MAX_CONCURRENT; }
export function setMaxConcurrent(n: number) { if (Number.isFinite(n) && n >= 1) { MAX_CONCURRENT = Math.floor(n); promote(); } }
export function queueState() { return { max: MAX_CONCURRENT, active: [...activeRuns], queued: [...runQueue] }; }

// Shared secret gating /api/internal/tool (the agent's callback bridge, which can run shell).
// If FACTORY_INTERNAL_SECRET is unset, generate a strong RANDOM per-process secret instead of a
// predictable default: the agent spawned by this process receives it via FACTORY_SECRET, but an
// external caller cannot guess it (fail closed). Set FACTORY_INTERNAL_SECRET explicitly for a
// multi-instance or restart-stable deployment.
export const INTERNAL_SECRET = process.env.FACTORY_INTERNAL_SECRET || randomBytes(24).toString("hex");
function baseUrl() { return process.env.FACTORY_BASE_URL || `http://localhost:${process.env.PORT || 7777}`; }
function factoolPath() { return join(process.cwd(), "bin", "factool.mjs"); }

function emit(runId: string, state: string, type: string, content: unknown) {
  addEvent({ id: nanoid(), run_id: runId, state, type, content });
}

/** Emit a log line into the run's CURRENT phase activity (used by out-of-band
 *  actions like the Test-it button). */
export function emitLog(runId: string, line: string) {
  const run = getRun(runId);
  const machine = run && getMachine(run.machine_id);
  const stateId = (machine && run && machine.states[run.state_index]?.id) || "";
  emit(runId, stateId, "text", { text: line + "\n", channel: "log" });
}

/** State ids the human turned OFF for this specific run (skipped by the driver). */
function disabledSet(run: Run): Set<string> {
  try { const a = JSON.parse(run.disabled_states || "[]"); return new Set(Array.isArray(a) ? a.map(String) : []); }
  catch { return new Set(); }
}

/** File extension for an attached reference image (from its data URL mime). */
function referenceExt(dataUrl: string | null): string | null {
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "png";
}
/** The human may attach one or MORE reference images (stored as a JSON array in
 *  reference_image; a legacy single data-URL still works). Map each to a stable
 *  workspace-relative filename. A lone image keeps the legacy `.reference.<ext>`
 *  name; multiples become `.reference-1.<ext>`, `.reference-2.<ext>`, … */
function referenceImageFiles(run: Run): { rel: string; dataUrl: string }[] {
  const urls = parseImages(run.reference_image);
  return urls.map((dataUrl, i) => {
    const ext = referenceExt(dataUrl);
    const rel = urls.length === 1 ? `.reference.${ext}` : `.reference-${i + 1}.${ext}`;
    return { rel, dataUrl };
  });
}
/** Write the human's reference image(s) into the workspace once (for a multimodal
 *  agent to Read). Text-only agents get the pre-computed description instead. */
async function writeReferenceImage(run: Run): Promise<void> {
  const files = referenceImageFiles(run);
  if (!files.length) return;
  try { await fs.mkdir(run.workspace, { recursive: true }); } catch { /* best-effort */ }
  for (const { rel, dataUrl } of files) {
    const abs = join(run.workspace, rel);
    try { await fs.access(abs); continue; } catch { /* not written yet */ }
    try { await fs.writeFile(abs, Buffer.from(dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64")); } catch { /* best-effort */ }
  }
}

// —————————————————————————————————————————————————————————————
// Context the agent sees for a phase.
// —————————————————————————————————————————————————————————————
function feedbackFor(runId: string, stateId: string): string[] {
  const events = listEvents(runId);
  // Feedback for this state is emitted BETWEEN the previous run and the re-entry,
  // so look since the PENULTIMATE state_enter of this state (captures the pending
  // reject reasons / wrap-up nudge that triggered this re-run).
  const enters: number[] = [];
  events.forEach((e, i) => { if (e.type === "state_enter" && e.state === stateId) enters.push(i); });
  const since = enters.length >= 2 ? enters[enters.length - 2] : -1;
  return events.slice(since + 1)
    .filter(e => e.type === "feedback" && e.state === stateId)
    .map(e => { try { return JSON.parse(e.content).message as string; } catch { return ""; } })
    .filter(Boolean);
}

async function buildPhasePrompt(run: Run, state: StateDef, firstPhase: boolean, provider: string, diff: string): Promise<string> {
  const parts: string[] = [];
  const F = factoolPath();
  // Always re-state the ticket + repo so each phase is grounded even if in-memory
  // conversation context was reset (the worktree files are the durable record).
  parts.push(`=== LOOP GOAL ===\n${run.goal}`);
  // Self-learning (a per-loop setting): inject the loop's accumulated PRINCIPLES (distilled
  // from past feedback) into every phase — unless this run opted out. Generic: just prepend the
  // standing rules; no phase-specific logic.
  if (run.apply_principles !== 0) {
    const lm = getMachine(run.machine_id);
    const principles = lm?.settings.principles || [];
    if (principles.length && lm!.settings.selfLearn === true) {
      parts.push(`=== LOOP PRINCIPLES — learned from earlier runs' feedback; FOLLOW every one ===\n${principles.map(p => `• ${p.text}`).join("\n")}`);
    }
  }
  // North Star: the run's acceptance criteria (goal + these = definition of done). Re-stated
  // every phase alongside the goal so the work can't drift off them; STATUS is the agent's to
  // report via the `north_star` tool (no deterministic pass/fail here).
  const criteria = getCriteria(run);
  if (criteria.length) {
    const lines = criteria.map((c, i) => `${i + 1}. ${c.status === "met" ? "[met]" : "[not yet met]"} ${c.text}${c.note ? `  (last note: ${c.note})` : ""}`).join("\n");
    parts.push(
      `=== NORTH STAR — ACCEPTANCE CRITERIA (the definition of done for this run; keep every step true to these) ===\n${lines}\n` +
      `As you work — and above all at any review / QA / acceptance phase — call the \`north_star\` factory tool to mark each criterion met (or leave it pending) with a one-line reason, so the human sees where the run really stands. Do NOT claim the goal is done while any criterion is still pending.`,
    );
  }
  // Reference image the human attached: multimodal agents Read the file; text-only
  // agents get the pre-computed description.
  const refFiles = referenceImageFiles(run);
  if (refFiles.length && parseModel(run.primary_model).provider === "claude") {
    const many = refFiles.length > 1;
    const list = refFiles.map(f => `\`${f.rel}\``).join(", ");
    parts.push(`=== REFERENCE IMAGE${many ? "S" : ""} ===\nThe human attached ${refFiles.length} reference image${many ? "s" : ""}, saved at ${list} in your workspace. Read ${many ? "them" : "it"} (your Read tool renders images) and factor ${many ? "them" : "it"} into your work.`);
  }
  if (run.reference_desc) {
    parts.push(`=== REFERENCE IMAGE (attached by the human; described for you because your model is text-only) ===\n${run.reference_desc}`);
  }
  if (run.repo_path) {
    parts.push(
      `=== REPOSITORY ===\nYou are working in a git worktree of the real project at the CURRENT WORKING DIRECTORY.\n` +
      `Repo: ${run.repo_path}\nYour branch: ${run.branch_name} (cut from ${run.base_branch}).\n` +
      `Earlier phases left files on disk (e.g. spec.md, mock.html) — READ them to recover prior decisions.\n` +
      `Make real changes here, commit them on this branch, and (in the final phase) push and open a PR with the GitHub CLI (\`gh\`).` +
      (firstPhase ? `\nExplore the codebase first to understand conventions before changing anything.` : ""),
    );
  }
  parts.push(
    `=== HARD BOUNDARY — STAY IN YOUR WORKSPACE ===\n` +
    `Do ALL work in your CURRENT WORKING DIRECTORY (this run's workspace) or the target repo ONLY. ` +
    `NEVER build, run a dev server, install packages, or write files inside the Atelier factory's own install directory — that is \`${FACTORY_ROOT}\`, the app running this loop. ` +
    `Do NOT \`cd\` into it, do NOT run \`npm run dev\` / \`npm run build\` / \`npm install\` there, and do not point any tooling (dev server, bundler, watcher) at it. ` +
    `Operating inside the factory tree makes its dev server recursively reload and can OOM the machine. ` +
    `Use \`start_dev_server\` (which is sandboxed) rather than launching \`npm run dev\` yourself. ` +
    `If the goal seems to require changing the factory app itself, STOP and request approval instead of doing it.\n\n` +
    `NEVER kill processes by name or pattern. Do NOT run \`pkill\`, \`killall\`, \`pkill -f\`, or a broad \`kill\` — e.g. \`pkill node\`, \`pkill -f npm\`, \`pkill -f next\`, \`pkill -f expo\`, \`pkill claude\`. Those match and kill the Atelier factory server, the model harness (\`claude\` / \`ollama\`) that IS running you, AND your own process, so you terminate YOURSELF mid-phase and the run just dies (you won't even realize you did it — that is exactly how runs have been failing). To stop a dev server you started, use \`start_dev_server\` (it tears its own down), or \`kill\` ONLY the exact numeric PID it printed — never a name or pattern. If a port is busy, use a DIFFERENT port; never sweep processes to free one.`,
  );
  // A machine's run modes live in the YAML as state.modes, keyed by the machine's own
  // mode ids — the runner just picks the prompt for run.mode, nothing hardcoded here.
  const modePrompt = state.modes && run.mode ? state.modes[run.mode] : undefined;
  const phasePrompt = modePrompt || state.prompt;
  parts.push(`=== PHASE: ${state.name}${modePrompt ? ` (${run.mode} mode)` : ""} ===\n${phasePrompt}`);
  const fb = feedbackFor(run.id, state.id);
  if (fb.length) parts.push(`=== YOU WERE SENT BACK — FIX THESE BEFORE PROCEEDING ===\n${fb.map(f => `• ${f}`).join("\n")}`);
  if (run.repo_path) parts.push(`=== CURRENT CHANGES (git diff --stat) ===\n${diff}`);

  // Only a Claude-native primary (the `claude` CLI harness) can Read an image and
  // actually SEE it. Text-only primaries crash with "400: this model does not support
  // image input" if they Read one; ollama-backed "multimodal" primaries (run via
  // `ollama launch claude`) don't get images rendered either — Reading PNGs piles raw
  // bytes into the session until "400 failed to read request body" (the exact crash
  // that failed the Capture Frames phase). So gate on provider, matching
  // feedbackImagesContext() below: non-Claude → forbid image Reads, use the vision helper.
  if (parseModel(run.primary_model).provider !== "claude") {
    parts.push(
      `=== ⚠️ DO NOT READ IMAGE FILES — YOUR MODEL CAN'T SEE THEM IN THIS HARNESS ===\n` +
      `Reading an image (Read tool on a .png/.jpg/.jpeg/.webp/.gif — INCLUDING a screenshot you just took) does NOT show it to you here: text-only models reject it ("400: this model does not support image input"), and ollama-backed models pile the raw bytes into the session until it overflows ("400 failed to read request body") and the phase crashes.\n` +
      `• NEVER open an image with Read. Not screenshots, not captures, not mocks.\n` +
      `• To SEE what's in any image, use the vision helper: \`node ${F} analyze --path <file> --question "..."\` — it sends the image to the vision model and returns a text description you can read.\n` +
      `• You never need to view an image directly; analyze gives you everything.`,
    );
  } else {
    parts.push(
      `=== IMAGES — read them yourself, don't call the vision helper ===\n` +
      `Your model can SEE images. Read screenshots/captures directly (the Read tool renders them) to judge them. Do NOT call analyze_image — that's only for text-only models and just spends an extra model call per check. Look with your own eyes instead.`,
    );
  }

  // Environment + auth recipe (configured per project). Lets QA bring the backend
  // up and log in instead of getting stuck at a login wall.
  const proj = getProjectByRepoPath(run.repo_path);
  if (proj && (proj.setupCommand || proj.auth)) {
    const a = proj.auth;
    parts.push(
      `=== PROJECT ENVIRONMENT & AUTH (configured) ===\n` +
      (proj.setupCommand ? `Bring the backend up first if it isn't (services/DB/seed): \`${proj.setupCommand}\` (run in the worktree). It may need Docker running.\n` : "") +
      `Dev command: ${proj.devCommand || "npm run dev"}\n` +
      (a ? `This app is AUTH-WALLED. After start_dev_server, you MUST authenticate before recording or you'll only capture the login page:\n` +
        `  • Login path: ${a.loginPath}\n` +
        `  • Test creds: ${a.email ? `email ${a.email}` : `read ${a.emailEnv} from the repo's .env.test`}${a.password ? `, password ${a.password}` : a.passwordEnv ? `, password ${a.passwordEnv} (from .env.test)` : ""} — these are seeded test fixtures (also see scripts/seed-test-users.sql / db-reset.sh / e2e/auth.setup.ts). Read the actual values from .env.test first.\n` +
        `  • Authenticate (replace PORT with the dev server's port, and the email/password with the fixture values you read): node ${F} authenticate --loginUrl "http://localhost:PORT${a.loginPath}" --email "<value of ${a.emailEnv || "test email"}>" --password "<value of ${a.passwordEnv || "test password"}>" --authedRoute "http://localhost:PORT${a.authedRoutes?.[0] || "/dashboard"}"\n` +
        `  • It prints whether it actually reached a protected route (not bounced to login). Only after it succeeds do screenshot_page / record_walkthrough run authenticated. Verify with a screenshot of ${a.authedRoutes?.[0] || "/dashboard"} that you see the real app, not the login form.\n` +
        `  • Protected routes to drive/record: ${(a.authedRoutes || ["/dashboard"]).join(", ")}\n` : ""),
    );
  }

  if (provider === "claude") {
    parts.push(
      `=== FACTORY TOOLS — run these via your Bash tool ===\n` +
      `Use your normal tools (Read/Write/Edit/Bash/Grep/TodoWrite/…) to do the actual work. For the FACTORY actions named in this phase, run the matching command:\n` +
      `• "display_artifact" →  node ${F} display --name "Spec" --kind markdown --file spec.md   (--file loads a workspace file; or --text "...")\n` +
      `• "return_file"      →  node ${F} return_file --path output/song.mp3 [--label "Song — MP3, 320kbps"] [--description "3:12, from <url>"]   (DELIVER a finished output FILE of ANY type to the human — copies it to a persistent store and adds a Download button in the run's Downloads. Use for EXTRA/intermediate files; for the FINAL result use expose_output.)\n` +
      `• "expose_output"    →  node ${F} expose_output --files '[{"path":"final.mp4","label":"Demo reel — MP4"},{"path":"summary.md","label":"Summary"}]'   (EXPOSE the DEFINITIVE final output SET — the one or few files that ARE the result the human asked for. The human sees THESE as "the output", not every file returned along the way. Call ONCE at the very end with the COMPLETE final set; it replaces any earlier exposed set. This is the proper final hand-off.)\n` +
      `• "start_dev_server" →  node ${F} dev_server   (boots the project's dev server in this worktree, WAITS until it serves, and prints the base URL — use this, do NOT run \`npm run dev\` yourself; the server is torn down when the phase ends)\n` +
      `• "authenticate"     →  node ${F} authenticate --loginUrl http://localhost:PORT/auth/login --email <fixture-email> --password <fixture-pass> --authedRoute http://localhost:PORT/dashboard   (logs in ONCE and persists the session so the captures below are AUTHENTICATED — run it after dev_server, before screenshot/record, on any auth-walled app)\n` +
      `• "screenshot_page"  →  node ${F} screenshot --name "Render" --path src/index.html   (or --url http://localhost:PORT/route)\n` +
      `• "record_walkthrough" → node ${F} record --name "QA walkthrough" --url http://localhost:PORT/route --steps '[{"do":"type","selector":"textarea","text":"a knight"},{"do":"click","selector":"button.generate"},{"do":"waitFor","selector":"canvas","ms":120000},{"do":"drag","selector":"canvas","dx":260}]'   (the video MUST show the feature working — use "waitFor" to capture an async result, not an empty page; add --present false for throwaway probes)\n` +
      `• "north_star"       →  node ${F} north_star --criteria '[{"criterion":"Live view is shown","status":"pending","note":"only Studio is shown so far"},{"criterion":1,"status":"met"}]'   (report where the run stands against its ACCEPTANCE CRITERIA above — mark each met or pending with a one-line reason; match a criterion by its text or its 1-based number. Call it whenever your assessment changes, and especially at review/QA/acceptance.)\n` +
      `• "analyze_image"    →  node ${F} analyze --path .captures/shot.png --question "Does this look like a polished working UI? List defects."\n` +
      `• "watch_pr"         →  node ${F} watch [--pr 123] [--timeoutSec 300]   (POLLS the open PR until its CI checks finish, then reports each check + mergeability + whether the branch is BEHIND base / CONFLICTS — use this on the PR/watch phase instead of a hand-rolled sleep loop; then rebase / fix the failing check / push, and call it again until it's green)\n` +
      `END THE PHASE with EXACTLY ONE of these as your LAST action, then stop:\n` +
      `• "request_approval" →  node ${F} approval --summary "what you did / what to approve"\n` +
      `• "reject" (review phases only) → node ${F} reject --reasons "specific defects to fix"\n` +
      `Do not end the phase until you've actually finished the work and displayed your deliverable.`,
    );
  }
  return parts.join("\n\n");
}

/** Fallback for when the agent's continuous session can't be resumed (overflowed past the
 *  harness's own compaction, or expired): have the SELECTED coding model compress the
 *  recent persisted session activity into a compact handoff summary, so a fresh session
 *  continues instead of starting blank. Returns null if there's nothing to summarize or the
 *  model call fails (the fresh session then just relies on the on-disk state + phase prompt).
 *  Bounded input so the summariser itself never overflows. */
async function compactSessionContext(run: Run): Promise<string | null> {
  const events = listEvents(run.id);
  const log = events.slice(-90).map(e => {
    try {
      const c = JSON.parse(e.content);
      if (e.type === "tool_call") return `→ ${c.name} ${JSON.stringify(c.args ?? {}).slice(0, 180)}`;
      if (e.type === "tool_result") return `  ⤷ ${String(c.result ?? "").replace(/\s+/g, " ").slice(0, 180)}`;
      if (e.type === "text" && c.text) return `· ${String(c.text).replace(/\s+/g, " ").slice(0, 280)}`;
      if (e.type === "feedback" && c.message) return `[feedback] ${String(c.message).slice(0, 200)}`;
    } catch {}
    return "";
  }).filter(Boolean).join("\n").slice(0, 12000);
  if (!log.trim()) return null;
  const prompt =
    `A coding agent's working session for the task below grew too large and is being reset. ` +
    `Below is a log of its most recent actions. Write a COMPACT handoff brief (<= 400 words, no preamble) so a FRESH agent can continue WITHOUT repeating work: ` +
    `what's already implemented/decided, what was tried and FAILED (so it isn't retried), the current state of the code, and what REMAINS to do. ` +
    `CRITICAL: explicitly list every FILE/ARTIFACT already written to the workspace (captured screenshots/frames, generated outputs, edited files — with their paths) so the fresh agent continues from what's ALREADY on disk instead of regenerating from scratch. For images/screenshots, reference them by PATH only — the fresh agent must NOT re-open every image back into context (that image pile-up is what overflowed the previous session); it should trust they exist and proceed with the REMAINING work.\n\n` +
    `TASK: ${String(run.goal || "").slice(0, 800)}\n\n=== RECENT SESSION LOG ===\n${log}`;
  const summary = await harnessOneShot(run.primary_model, prompt).catch(() => "");
  return summary.trim() ? summary.trim() : null;
}

// —————————————————————————————————————————————————————————————
// Drive the current phase.
// —————————————————————————————————————————————————————————————
/** Make a run progress, respecting the global one-at-a-time slot limit.
 *  - already holds a slot (mid-ticket, e.g. advancing a phase) → just drive next phase
 *  - a slot is free → take it and drive
 *  - no slot → mark queued; it starts automatically when a slot frees. */
export function kick(runId: string) {
  const run = getRun(runId);
  if (!run || run.status !== "running") return;
  if (activeRuns.has(runId)) { drive(runId); return; }
  if (activeRuns.size >= MAX_CONCURRENT) {
    if (!runQueue.includes(runId)) runQueue.push(runId);
    updateRun(runId, { status: "queued" });
    emit(runId, "system", "queued", { message: `Queued — ${activeRuns.size} ticket(s) running (limit ${MAX_CONCURRENT}). Starts automatically when a slot frees.` });
    return;
  }
  activeRuns.add(runId);
  drive(runId);
}

/** Drive ONE phase. Re-entrant-safe: internal kicks while a phase runs are no-ops
 *  (inFlight guard); when the phase settles we either drive the next phase (still
 *  running → holds its slot) or release the slot and promote the next queued run. */
function drive(runId: string) {
  if (inFlight.has(runId)) return;
  inFlight.add(runId);
  driveState(runId)
    .catch(err => { emit(runId, "system", "error", { message: err instanceof Error ? err.message : String(err) }); updateRun(runId, { status: "failed", last_error: String(err) }); })
    .finally(() => {
      inFlight.delete(runId);
      const fresh = getRun(runId);
      if (fresh && fresh.status === "running") { drive(runId); return; } // more phases — keep the slot
      activeRuns.delete(runId);                                          // waiting/terminal — free the slot
      promote();
    });
}

/** Start as many queued runs as there are free slots (FIFO). */
function promote() {
  while (activeRuns.size < MAX_CONCURRENT && runQueue.length) {
    const next = runQueue.shift()!;
    const r = getRun(next);
    if (!r || r.status !== "queued") continue; // stale (paused/deleted while queued)
    activeRuns.add(next);
    updateRun(next, { status: "running" });
    emit(next, "system", "text", { text: "▶ A slot freed — starting now.\n", channel: "log" });
    drive(next);
  }
}

/** Reconcile DB run-state with the in-memory scheduler. The queue/active-set live
 *  in memory, so a server restart loses them while the DB still says "queued"/
 *  "running". Idempotent + cheap; call it from the run/board pollers so an
 *  interrupted or stranded run is re-scheduled (respecting the slot limit). */
export function reconcile() {
  const runs = listRuns();
  // 1) Re-adopt runs that were mid-flight when the process died: still "running"
  //    in the DB but nothing is driving them. kick() re-takes a slot or re-queues.
  for (const r of runs) if (r.status === "running" && !inFlight.has(r.id) && !activeRuns.has(r.id)) kick(r.id);
  // 2) Re-enqueue runs the DB still calls "queued" that we've lost track of.
  for (const r of runs) if (r.status === "queued" && !runQueue.includes(r.id) && !activeRuns.has(r.id)) runQueue.push(r.id);
  promote();
}

async function driveState(runId: string) {
  let run = getRun(runId);
  if (!run || run.status !== "running") return;
  const machine = getMachine(run.machine_id);
  if (!machine) throw new Error(`machine ${run.machine_id} not found`);
  const state = machine.states[run.state_index];
  if (!state) { updateRun(runId, { status: "done" }); emit(runId, "system", "done", { message: "All phases complete." }); return; }

  // One-time workspace/worktree setup at the very start of the ticket.
  if (run.repo_path && !run.branch_name) {
    emit(runId, "setup", "text", { text: `Setting up an isolated worktree of ${run.repo_path}…\n` });
    const wt = await setupWorktree({ repoPath: run.repo_path, baseBranch: run.base_branch!, runId, workspace: run.workspace, log: (s) => emit(runId, "setup", "text", { text: s + "\n" }) });
    updateRun(runId, { branch_name: wt.branch });
    run = getRun(runId)!;
  } else {
    await fs.mkdir(run.workspace, { recursive: true });
  }
  await writeReferenceImage(run); // drop the human's reference image in the workspace (once)

  // This phase is turned OFF for this run — skip it (setup above still ran once).
  if (disabledSet(run).has(state.id)) {
    emit(runId, state.id, "text", { text: `⏭ "${state.name}" is turned off for this run — skipping.\n`, channel: "log" });
    return advance(runId);
  }

  const firstPhase = run.state_index === 0 && !run.agent_state;
  emit(runId, state.id, "state_enter", { name: state.name, index: run.state_index, prompt: state.prompt });

  // Per-phase model: a state can declare its OWN `model` (e.g. a vision-heavy phase that
  // inspects a video output with a specific model). An override phase runs ISOLATED — its
  // own model + a fresh session — so it never resumes or clobbers the main agent thread
  // that carries context across the other phases. No override ⇒ identical to before.
  const modelOverride = !!(state.model && state.model !== run.primary_model);
  const primary = parseModel(state.model || run.primary_model);
  const diff = run.repo_path ? await gitDiffStat(run.workspace).catch(() => "(diff unavailable)") : "";

  const ac = new AbortController();        // lets pause/rewind interrupt this phase
  controllers.set(runId, ac);

  const ctx: ToolContext = {
    workspace: run.workspace, runId, state: state.id, visionModel: run.vision_model,
    emitArtifact: ({ name, kind, body }) => {
      // Backstop: an image/video artifact's `body` is a workspace path. NEVER register
      // one whose file is missing or empty — that's what produces "broken image"/0:00
      // video tiles in the UI. Force the producer to actually create the file first.
      let size = body.length;
      if (kind === "image" || kind === "video") {
        let st; try { st = statSync(join(run.workspace, body)); } catch { /* missing */ }
        if (!st || !st.isFile() || st.size === 0)
          throw new Error(`Refusing to present ${kind} "${name}": file "${body}" is missing or empty in the workspace — produce a real file before presenting it.`);
        size = st.size;
      }
      addArtifact({ id: nanoid(), run_id: runId, state: state.id, name, kind, body });
      emit(runId, state.id, "artifact", { name, kind, size });
    },
    emitScreenshot: (name, relPath) => emit(runId, state.id, "screenshot", { name, path: relPath }),
    emitDeliverable: (d) => {
      addDeliverable({ id: d.id, run_id: runId, state: state.id, filename: d.filename, stored_path: d.storedPath, size: d.size, mime: d.mime, label: d.label, description: d.description, loop: getRun(runId)?.loop_count ?? 0 });
      emit(runId, state.id, "deliverable", { id: d.id, filename: d.filename, size: d.size, mime: d.mime, label: d.label, description: d.description });
    },
    emitFinalDeliverables: (list) => {
      clearFinalDeliverables(runId);
      const loop = getRun(runId)?.loop_count ?? 0;
      for (const d of list) {
        addDeliverable({ id: d.id, run_id: runId, state: state.id, filename: d.filename, stored_path: d.storedPath, size: d.size, mime: d.mime, label: d.label, description: d.description, is_final: true, loop });
        emit(runId, state.id, "deliverable", { id: d.id, filename: d.filename, size: d.size, mime: d.mime, label: d.label, description: d.description, final: true });
      }
    },
    log: (line) => emit(runId, state.id, "text", { text: line + "\n", channel: "log" }),
  };
  const callbacks = {
    onText: (t: string) => { emit(runId, state.id, "text", { text: t }); maybeNarrate(runId, state.id); },
    onToolCall: (name: string, args: unknown) => { emit(runId, state.id, "tool_call", { name, args }); maybeNarrate(runId, state.id); },
    onToolResult: (name: string, result: string) => emit(runId, state.id, "tool_result", { name, result: String(result).slice(0, 2000) }),
  };

  // ALL models drive the full Claude Code harness (30+ tools, TodoWrite, real
  // context management). Claude-native models run `claude`; Ollama models (GLM,
  // Qwen, Kimi) run via `ollama launch claude --model <tag>` — same harness, the
  // chosen model behind it. Factory-side actions go through factool (in the prompt).
  const phasePrompt = await buildPhasePrompt(run, state, firstPhase, "claude", diff);
  takePendingControl(runId); // clear any stale signal
  const res = await runClaudePhase({
    workspace: run.workspace,
    prompt: phasePrompt,
    model: primary.provider === "claude" ? primary.model : "default",
    ollamaModel: primary.provider === "ollama" ? primary.model : undefined,
    sessionId: modelOverride ? undefined : run.agent_state, // isolate an override phase from the main thread
    env: {
      FACTORY_BASE_URL: baseUrl(), FACTORY_RUN_ID: runId, FACTORY_STATE: state.id,
      FACTORY_SECRET: INTERNAL_SECRET, FACTORY_VISION_MODEL: run.vision_model || "",
    },
    onText: callbacks.onText, onToolCall: callbacks.onToolCall, onToolResult: callbacks.onToolResult,
    signal: ac.signal,
    // If the continuous session can't be resumed, seed the fresh one with a model-made
    // summary of the work so far (built from the persisted events) instead of starting blank.
    compactContext: () => compactSessionContext(run),
  });
  if (res.sessionId && !modelOverride) updateRun(runId, { agent_state: res.sessionId }); // don't clobber the main thread with an override phase's session
  const control = takePendingControl(runId);
  let end: PhaseEnd;
  if (control) end = { kind: control.action === "reject" ? "reject" : control.action === "complete" ? "complete" : "approval", summary: control.summary };
  else end = { kind: res.ok ? "approval" : "error", summary: res.summary };

  killDevServer(runId); // tear down any dev server the phase started

  // If this phase was interrupted (pause/rewind), bail without gating/advancing —
  // the run's new status/state_index has already been set by the interrupting action.
  if (ac.signal.aborted) return;
  const fresh = getRun(runId);
  if (!fresh || fresh.status !== "running") return;

  // Crash-recovery idempotency: a server restart can re-drive a phase that ALREADY
  // produced its verdict (the resumed agent re-emits the same final tool call). Detect
  // that and complete the interrupted transition ONCE — without re-emitting the event
  // or double-counting the loop. Normal (first-time) verdicts are unaffected (dup=false).
  const dup = phaseAlreadyVerdicted(runId, state.id);
  if (dup) emit(runId, state.id, "text", { text: "↩ Verdict already recorded before a restart — finishing the transition without re-emitting.\n", channel: "log" });

  if (end.kind === "reject") return handleReject(runId, machine, state, end.summary, dup);
  if (end.kind === "error") return failRun(runId, state.id, end.summary);
  if (end.kind === "complete") { if (!dup) emit(runId, state.id, "done", { summary: end.summary, auto: true }); return advance(runId); }

  const gm = fresh.gate_mode || "machine";
  const gated = gm === "all" ? true : gm === "none" ? false : state.gate === true;

  if (end.kind === "exhausted") {
    // The phase ran out of turns without finishing. A GATED phase hands it to the
    // human. A non-gated phase keeps going on its own (no clicks) — with a wrap-up
    // nudge — bounded by the global stall cap so it can't spin forever.
    if (gated) {
      emit(runId, state.id, "approval_request", { summary: end.summary, exhausted: true });
      updateRun(runId, { status: "awaiting_approval", approval_summary: end.summary });
      return;
    }
    const cap = machine.settings.maxLoops;
    const loops = (fresh.loop_count || 0) + 1;
    updateRun(runId, { loop_count: loops });
    if (loops > cap) return failStuck(runId, state.id, `"${state.name}" didn't converge`, cap);
    emit(runId, state.id, "text", { text: `↻ ${state.name} ran long (round ${loops}/${cap}) — continuing automatically and wrapping up.\n`, channel: "log" });
    emit(runId, state.id, "feedback", { message: "You are running long. STOP exploring and polishing. Commit what you have, then display your deliverable and call request_approval (or reject, if reviewing) NOW — do not do more cleanup." });
    updateRun(runId, { status: "running" });
    kick(runId);
    return;
  }

  // end.kind === "approval"
  if (!dup) emit(runId, state.id, "approval_request", { summary: end.summary });
  if (!gated) { if (!dup) emit(runId, state.id, "approved", { message: "Auto-advanced (no gate)." }); return advance(runId); }
  updateRun(runId, { status: "awaiting_approval", approval_summary: end.summary });
}

/** True if THIS phase entry already emitted a terminal verdict since its last
 *  state_enter — i.e. a restart re-drove a phase that had already produced its verdict
 *  and the resumed agent re-emitted it. Lets verdict handling stay idempotent. */
function phaseAlreadyVerdicted(runId: string, stateId: string): boolean {
  const events = listEvents(runId);
  let lastEnter = -1;
  events.forEach((e, i) => { if (e.type === "state_enter" && e.state === stateId) lastEnter = i; });
  if (lastEnter < 0) return false;
  return events.slice(lastEnter + 1).some(e =>
    e.state === stateId && (e.type === "reject" || e.type === "approval_request" || e.type === "done"));
}

function handleReject(runId: string, machine: ReturnType<typeof getMachine>, state: StateDef, reasons: string, dup = false) {
  const run = getRun(runId)!;
  const targetId = state.rejectTo;
  const targetIndex = targetId ? machine!.states.findIndex(s => s.id === targetId) : -1;
  if (!dup) emit(runId, state.id, "reject", { reasons, to: targetId });

  if (targetIndex < 0) {
    // No loop target configured — surface to the human as a failed gate.
    updateRun(runId, { status: "awaiting_approval", approval_summary: `Rejected: ${reasons}` });
    return;
  }
  const cap = machine!.settings.maxLoops;
  const loops = (run.loop_count || 0) + (dup ? 0 : 1); // a re-driven dup must not inflate the loop count
  updateRun(runId, { loop_count: loops });
  if (loops > cap) return failStuck(runId, state.id, `kept failing review: ${reasons}`, cap);
  // Route back: leave feedback for the target phase, jump there, keep running (same agent).
  if (!dup) emit(runId, machine!.states[targetIndex].id, "feedback", { message: reasons });
  updateRun(runId, { state_index: targetIndex, status: "running", approval_summary: null });
  kick(runId);
}

/** Hard failure for the human's attention — too many rounds without progress. */
function failStuck(runId: string, stateId: string, reason: string, cap: number) {
  const msg = `Stuck after ${cap} rounds — needs your help. ${reason}. Edit the ticket or leave a comment + Re-run, or retry.`;
  emit(runId, stateId, "error", { message: msg });
  updateRun(runId, { status: "failed", last_error: msg });
}
function failRun(runId: string, stateId: string, msg: string) {
  emit(runId, stateId, "error", { message: msg });
  updateRun(runId, { status: "failed", last_error: msg });
}

async function advance(runId: string) {
  const run = getRun(runId);
  if (!run) return;
  const machine = getMachine(run.machine_id);
  // An off-path leaf (e.g. a deep-dive/bisect routed into deliberately) rejoins the
  // normal flow at its `returnTo` phase; otherwise just go to the next phase in order.
  const cur = machine?.states[run.state_index];
  const dis = disabledSet(run);
  let next = cur?.returnTo ? (machine?.states.findIndex(s => s.id === cur.returnTo) ?? -1) : run.state_index + 1;
  if (next < 0) next = run.state_index + 1;
  // Skip phases turned off for this run AND off-path leaves (never auto-entered).
  while (machine && next < machine.states.length && (dis.has(machine.states[next].id) || machine.states[next].offPath)) {
    if (dis.has(machine.states[next].id)) emit(runId, machine.states[next].id, "text", { text: `⏭ Skipped "${machine.states[next].name}" (turned off for this run).\n`, channel: "log" });
    next++;
  }
  if (!machine || next >= machine.states.length) {
    await capturePr(run);
    // Clear any stale error from a recovered hiccup — the run succeeded.
    updateRun(runId, { status: "done", state_index: Math.min(next, machine?.states.length ?? next), last_error: null });
    emit(runId, "system", "done", { message: "Goal complete — all phases passed." });
    return;
  }
  // A phase passed — clear any stale error a recovered retry left behind.
  updateRun(runId, { state_index: next, status: "running", approval_summary: null, last_error: null });
  kick(runId);
}

/** Opportunistically read the PR url the agent opened (state-reading, not stage logic).
 *  The agent doesn't always open the PR from `factory/<runId>` — so don't key on that
 *  branch. Ask gh for the worktree's CURRENT branch, then fall back to the PR url the
 *  agent itself printed in this run's events. */
async function capturePr(run: Run) {
  if (!run.repo_path || run.pr_url) return;
  const sh = (cmd: string) => new Promise<string>((res) =>
    exec(cmd, { cwd: run.workspace, timeout: 15000 }, (_e: unknown, so: string) => res((so || "").trim())));
  const isPr = (u: string) => /^https:\/\/github\.com\/[^\s"')]+\/pull\/\d+/.test(u);
  const set = (u: string) => { if (isPr(u)) { updateRun(run.id, { pr_url: u }); emit(run.id, "system", "text", { text: `PR: ${u}\n` }); return true; } return false; };

  // 1) gh, by the branch the worktree is actually on (whatever the agent pushed).
  if (set(await sh(`gh pr view --json url -q .url`))) return;
  // 2) gh, by the recorded branch name (older runs).
  if (run.branch_name && set(await sh(`gh pr view ${run.branch_name} --json url -q .url`))) return;
  // 3) Fall back: the agent prints the PR url in its output — grab the last one.
  const evs = listEvents(run.id);
  for (let i = evs.length - 1; i >= 0; i--) {
    const m = (evs[i].content || "").match(/https:\/\/github\.com\/[^\s"')\\]+\/pull\/\d+/);
    if (m && set(m[0])) return;
  }
}

// —————————————————————————————————————————————————————————————
// Human gate actions.
// —————————————————————————————————————————————————————————————
export function approve(runId: string, note?: string) {
  const run = getRun(runId);
  if (!run || run.status !== "awaiting_approval") return;
  emit(runId, run_state(run), "approved", { message: note ? `Approved — ${note}` : "Human approved." });
  // Carry a pick/instruction forward to the NEXT phase (e.g. "build Option 2").
  if (note?.trim()) {
    const machine = getMachine(run.machine_id);
    const next = machine?.states[run.state_index + 1];
    if (next) emit(runId, next.id, "feedback", { message: note.trim() });
  }
  advance(runId);
}

export function requestChanges(runId: string, message: string) {
  const run = getRun(runId);
  if (!run || run.status !== "awaiting_approval") return;
  emit(runId, run_state(run), "feedback", { message });
  updateRun(runId, { status: "running", approval_summary: null });
  kick(runId);
}

export function start(runId: string) {
  const run = getRun(runId);
  if (!run || (run.status !== "idle" && run.status !== "failed")) return;
  // Retrying a FAILED run: drop the agent session so the phase restarts clean. A
  // crashed session (e.g. one that hit a 400 image-input error) is otherwise
  // resumed and re-fails the same way; a fresh session re-reads the goal + the
  // on-disk artifacts and follows the current prompt.
  const reset = run.status === "failed" ? { agent_state: null } : {};
  updateRun(runId, { status: "running", last_error: null, ...reset } as any);
  kick(runId);
}

/** Interrupt the in-flight phase (if any). The agentic loop checks the signal at
 *  turn boundaries (ollama) or gets SIGKILL (claude). */
function interrupt(runId: string) { controllers.get(runId)?.abort(); }

/** Pause a running ticket. The current phase stops at its next safe point. */
export function pauseRun(runId: string) {
  const run = getRun(runId);
  if (!run || (run.status !== "running" && run.status !== "queued")) return;
  // If it was only queued (not yet driving), just drop it from the queue.
  const qi = runQueue.indexOf(runId);
  if (qi >= 0) runQueue.splice(qi, 1);
  updateRun(runId, { status: "paused" });
  emit(runId, run_state(run), "text", { text: "⏸ Paused by the human.\n", channel: "log" });
  interrupt(runId);
  // Releasing an active run (or one mid-settle) lets a queued ticket start.
  if (!inFlight.has(runId)) { activeRuns.delete(runId); promote(); }
}

/** Resume a paused ticket — re-runs the current phase. */
export function resumeRun(runId: string) {
  const run = getRun(runId);
  if (!run || run.status !== "paused") return;
  updateRun(runId, { status: "running" });
  kick(runId);
}

/** Rewind (or jump) to any phase and re-run from there. The single agent keeps
 *  its memory; re-running an earlier phase revises it with the latest ticket/feedback. */
export function goToPhase(runId: string, index: number, note?: string) {
  const run = getRun(runId);
  if (!run) return;
  const machine = getMachine(run.machine_id);
  if (!machine || index < 0 || index >= machine.states.length) return;
  interrupt(runId); // stop whatever's running now
  const target = machine.states[index];
  emit(runId, target.id, "text", { text: `↩ Rewound to "${target.name}" — paused. Edit if you want, then Resume.\n`, channel: "log" });
  if (note) emit(runId, target.id, "feedback", { message: note });
  // Land PAUSED at the target phase so you can edit the ticket / adjust, then
  // Resume to run it. (Resume re-runs the current phase.)
  updateRun(runId, { state_index: index, status: "paused", approval_summary: null, loop_count: 0 });
}

/** Comment on ANY phase and send it back: re-run that phase NOW with the note as
 *  feedback, then flow forward through the checks again. (Rewind pauses; this runs.) */
export function reviseFrom(runId: string, index: number, comment: string) {
  const run = getRun(runId);
  if (!run) return;
  const machine = getMachine(run.machine_id);
  if (!machine || index < 0 || index >= machine.states.length) return;
  interrupt(runId);
  const target = machine.states[index];
  if (comment.trim()) emit(runId, target.id, "feedback", { message: comment.trim() });
  emit(runId, target.id, "text", { text: `↻ Revising "${target.name}"${comment.trim() ? " with your comment" : ""} — re-running from here.\n`, channel: "log" });
  updateRun(runId, { state_index: index, status: "running", approval_summary: null, loop_count: 0 });
  kick(runId);
}

/** Generic per-phase "add a case": route the run DIRECTLY to the given phase (by id) with
 *  an extra ad-hoc scenario for it to handle THIS run — an added case, not a reported
 *  failure. Phase-agnostic (the phase's own prompt decides what to do with it); the QA
 *  phase, say, adds it to its scenario ledger. Reuses reviseFrom; no hard-coded names. */
export function addCase(runId: string, stateId: string, scenario: string) {
  const s = scenario.trim(); if (!s) return false;
  const run = getRun(runId); if (!run) return false;
  const machine = getMachine(run.machine_id);
  const idx = machine ? machine.states.findIndex(st => st.id === stateId) : -1;
  if (!machine || idx < 0) return false;
  const name = machine.states[idx].name;
  reviseFrom(runId, idx, `The human asked you to ADDITIONALLY handle this specific case in "${name}" this run — an ADDED scenario to verify, NOT a reported failure. Do what this phase normally does for it (and if this phase keeps a ledger/log, record it there), then present the result:\n\n"${s}"`);
  return true;
}

/** Generic "re-check a watchable terminal phase": re-run a phase the human clicked
 *  refresh on (its result depends on state that keeps moving after it finished — e.g. a
 *  PR's mergeability / CI). Reuses reviseFrom with the phase's OWN declared brief
 *  (state.watchable.note), so the engine stays loop-agnostic: it only re-runs whatever
 *  phase said it was watchable, and that phase's prompt + tools decide what to do. Returns
 *  false if the phase isn't declared watchable (so the UI can't re-run arbitrary phases). */
export function recheckPhase(runId: string, index: number): boolean {
  const run = getRun(runId); if (!run) return false;
  const machine = getMachine(run.machine_id);
  const target = machine?.states[index];
  if (!machine || !target || !target.watchable) return false;
  const note = target.watchable.note?.trim()
    || `Re-check this phase: its external state may have moved since it last finished. Inspect the current situation and bring it up to date (${target.name}). If everything is already current, just report that and finish.`;
  reviseFrom(runId, index, note);
  return true;
}

/** MANUAL OVERRIDE of the Conductor: the human routes the loop DIRECTLY to any phase
 *  (incl. an off-path leaf like Deep-dive), ingesting the OPEN comments + their pinned
 *  images + any extra instructions/images they add. Bypasses the Conductor entirely. */
export async function routeToPhase(runId: string, stateId: string, instructions: string, extraImages: string[] = []): Promise<boolean> {
  const run = getRun(runId); if (!run) return false;
  const machine = getMachine(run.machine_id);
  const idx = machine ? machine.states.findIndex(s => s.id === stateId) : -1;
  if (!machine || idx < 0) return false;
  const name = machine.states[idx].name;
  const open = listOpenComments(runId);
  const imgCtx = await feedbackImagesContext(run, [...open.flatMap(c => parseImages(c.image)), ...extraImages]);
  const body = [
    open.length
      ? `The human routed this loop DIRECTLY to "${name}" (overriding the Conductor) to address these ${open.length} pinned comment(s):\n${formatComments(open)}`
      : `The human routed this loop DIRECTLY to "${name}" (overriding the Conductor).`,
    instructions.trim() ? `\n\n=== ADDITIONAL INSTRUCTIONS FROM THE HUMAN ===\n${instructions.trim()}` : "",
  ].join("") + imgCtx;
  markAllOpenSent(runId);
  reviseFrom(runId, idx, body);
  maybeReflect(runId, [instructions, ...open.map(c => c.body)].filter(Boolean).join("\n")); // learn from this feedback
  return true;
}

/** Turn phases ON/OFF for THIS run (e.g. skip Rigorous QA for a quick run). The
 *  driver skips disabled phases when advancing. Doesn't touch the machine. */
export function setDisabledSteps(runId: string, ids: string[]) {
  const run = getRun(runId);
  if (!run) return;
  const clean = [...new Set(ids.map(String))];
  updateRun(runId, { disabled_states: JSON.stringify(clean) });
  emit(runId, run_state(run), "text", { text: clean.length ? `⚙ Turned off for this run: ${clean.join(", ")}.\n` : `⚙ All steps enabled for this run.\n`, channel: "log" });
}

/** A stored image field is a JSON array of data-URLs (or, legacy, a single one). */
export function parseImages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw[0] === "[") { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [raw];
}

/** Write the human's attached feedback images into the workspace so the AGENT can
 *  actually SEE the visual evidence it's being asked to fix. The #1 reason a visual
 *  bug survives the loop is that the screenshot the human pinned never reached the
 *  worker — feedback was passed as text only. Returns workspace-relative paths. */
export function writeFeedbackImages(run: Run, dataUrls: string[]): string[] {
  const out: string[] = [];
  if (!dataUrls.length) return out;
  try { mkdirSync(join(run.workspace, ".feedback"), { recursive: true }); } catch { /* best effort */ }
  for (const url of dataUrls.slice(0, 8)) {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(url || "");
    if (!m) continue;
    const ext = m[1].replace("jpeg", "jpg");
    const rel = join(".feedback", `fb-${Date.now()}-${out.length}.${ext}`);
    try { writeFileSync(join(run.workspace, rel), Buffer.from(m[2], "base64")); out.push(rel); } catch { /* skip */ }
  }
  return out;
}

/** Write the human's pinned screenshots into the workspace AND turn them into prompt
 *  context the worker can actually use. Only a Claude primary can Read an image natively;
 *  every other model — text-only OR ollama-multimodal (whose read_file returns the PNG's
 *  bytes as text, not a rendered image) — gets a VISION-MODEL DESCRIPTION embedded as text,
 *  the same way the ticket's reference_desc works. This is what makes the visual half of the
 *  feedback loop actually reach the build agent instead of being silently dropped. */
export async function feedbackImagesContext(run: Run, dataUrls: string[]): Promise<string> {
  const rels = writeFeedbackImages(run, dataUrls);
  if (!rels.length) return "";
  if (parseModel(run.primary_model).provider === "claude") {
    return `\n\n=== 📷 THE HUMAN ATTACHED SCREENSHOT(S) — THIS IS THE VISUAL EVIDENCE, LOOK AT IT ===\nRead these image files (your Read tool renders images): ${rels.join(", ")}. They show exactly what the human is pointing at. Reproduce the problem against the RUNNING app and verify your fix by LOOKING at the result — the code "looking correct" is not proof.`;
  }
  // text-only or ollama-multimodal: have the vision helper describe each image so the
  // evidence lands in context as TEXT (the agent can't view the file itself).
  const descs: string[] = [];
  for (const rel of rels) {
    let d = "(vision helper unavailable — describe what you build in text)";
    try { d = await analyzeImage({ imagePath: join(run.workspace, rel), question: "A human attached this screenshot as feedback / evidence on the current work. Describe exactly what it shows and call out anything broken, wrong, empty, or notable the human is likely pointing at.", visionModel: run.vision_model }); } catch { /* keep fallback */ }
    descs.push(`• ${rel} — ${d}`);
  }
  return `\n\n=== 📷 THE HUMAN ATTACHED SCREENSHOT(S) — VISION-MODEL DESCRIPTION (your model can't view images, so this IS the visual evidence) ===\n${descs.join("\n")}\n\nTreat the above as the ground truth of what the human sees. Reproduce the problem against the RUNNING app and verify your fix by re-checking the result with the vision helper — code "looking correct" is not proof.`;
}

/** Format pin/note comments into precise, actionable revision instructions. */
function formatComments(rows: Comment[]): string {
  return rows.map((c, i) => {
    let where = "";
    try {
      const a = JSON.parse(c.anchor);
      if (a?.type === "pin" && typeof a.x === "number") where = ` at a point ${Math.round(a.x)}% from the left, ${Math.round(a.y)}% from the top`;
    } catch { /* note */ }
    const on = c.artifact_name ? ` on "${c.artifact_name}"` : "";
    return `${i + 1}.${on}${where}: ${c.body}`;
  }).join("\n");
}

/** Self-learning: after the human gives feedback on a run, fire the loop's Reflect & Record
 *  node (if any) to distill a DURABLE principle from that feedback and record it onto the loop.
 *  Fire-and-forget — never blocks the feedback from reaching the agent. Surfaced as an activity
 *  event so the learning is visible. This is the product baking in "fold my note into the loop
 *  so it's caught next time." */
export function maybeReflect(runId: string, humanText: string) {
  const run = getRun(runId); if (!run) return;
  const text = String(humanText || "").trim(); if (!text) return;
  if (!isSelfLearning(run.machine_id)) return;
  emit(runId, "system", "reflect", { message: "🧠 Reflect & Record — learning from your feedback…", status: "start" });
  reflectAndRecord(run.machine_id, text, run.goal)
    .then(res => {
      if (!res) return;
      if (res.added.length) emit(runId, "system", "reflect", { message: `🧠 The loop learned ${res.added.length} new principle(s) from your feedback:\n${res.added.map(p => `• ${p.text}`).join("\n")}`, principles: res.added.map(p => p.text), status: "done" });
      else emit(runId, "system", "reflect", { message: `🧠 Reflect & Record — ${res.reply}`, status: "done" });
    })
    .catch(err => emit(runId, "system", "reflect", { message: `🧠 Reflect & Record skipped (${err instanceof Error ? err.message : String(err)})`, status: "error" }));
}

/** Bundle the OPEN review comments on a phase's deliverable into one feedback
 *  packet and re-run that phase NOW to address them — the agent reads the prior
 *  artifact (e.g. option-*.html) and revises it in place. Mirrors the original
 *  factory's "Send to team" → revert-to-mock-preserving-artifacts flow. */
export async function sendComments(runId: string, stateId: string): Promise<{ ok: boolean; count: number }> {
  const run = getRun(runId);
  if (!run) return { ok: false, count: 0 };
  const machine = getMachine(run.machine_id);
  const index = machine?.states.findIndex(s => s.id === stateId) ?? -1;
  if (!machine || index < 0) return { ok: false, count: 0 };
  const open = listOpenComments(runId, stateId);
  if (!open.length) return { ok: false, count: 0 };
  const imgCtx = await feedbackImagesContext(run, open.flatMap(c => parseImages(c.image)));
  const packet =
    `The human reviewed your "${machine.states[index].name}" deliverable and left ${open.length} comment(s) pinned to specific spots. ` +
    `Revise the EXISTING deliverable in place to address EVERY point — do not start over, keep what wasn't mentioned:\n${formatComments(open)}` +
    imgCtx;
  markCommentsSent(runId, stateId);
  reviseFrom(runId, index, packet);
  maybeReflect(runId, open.map(c => c.body).filter(Boolean).join("\n")); // let the loop learn from these comments
  return { ok: true, count: open.length };
}

/** Edit the ticket text (e.g. add a missed detail), then rewind to re-spec. */
export function updateGoal(runId: string, goal: string) {
  const run = getRun(runId);
  if (!run) return;
  updateRun(runId, { goal });
  emit(runId, run_state(run), "text", { text: "✎ Ticket updated by the human.\n", channel: "log" });
}

/** Set the gate mode: "all" (review every phase) · "machine" (obey state gates) ·
 *  "none" (auto-run). Switching to a less-gated mode while paused continues. */
export function setGateMode(runId: string, mode: "all" | "machine" | "none") {
  const run = getRun(runId);
  if (!run) return;
  updateRun(runId, { gate_mode: mode } as Partial<Run>);
  // If we just stopped gating the CURRENT phase, continue immediately.
  if (run.status === "awaiting_approval" && mode === "none") approve(runId);
}

function run_state(run: Run): string {
  const machine = getMachine(run.machine_id);
  return machine?.states[run.state_index]?.id || "system";
}
