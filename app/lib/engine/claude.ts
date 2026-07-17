/**
 * Claude provider — drives the `claude` CLI (the Claude Code harness) in headless
 * stream-json mode. ONE session per ticket: the first phase starts a session, later
 * phases --resume it, so it's a single continuous agent with full context across
 * the back-and-forth. Claude uses its own native tools (Read/Write/Edit/Bash/Grep…)
 * to do real work in the worktree, plus the factory `factool` CLI (via Bash) for
 * factory-side actions (display a deliverable, screenshot, record, ask the vision
 * helper). Nothing here is repo- or stage-specific.
 */
import { spawn } from "child_process";
import { killTree } from "./proc";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function resolveClaude(): string {
  const cands = [
    process.env.CLAUDE_BIN,
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean) as string[];
  for (const c of cands) if (existsSync(c)) return c;
  return "claude"; // rely on PATH
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** `ollama launch claude` proxies through a LOCAL ollama server — make sure it's up
 *  (and pointed at the cloud key) before we drive an Ollama model through Claude Code. */
async function ensureOllamaServe(): Promise<void> {
  const ping = async () => { try { const r = await fetch("http://localhost:11434/api/version"); return r.ok; } catch { return false; } };
  if (await ping()) return;
  spawn("ollama", ["serve"], { detached: true, stdio: "ignore", env: { ...process.env } }).unref();
  for (let i = 0; i < 20; i++) { if (await ping()) return; await sleep(500); }
}

/** Cloud Ollama models need the :cloud tag for `ollama launch`. */
function cloudTag(model: string): string { return model.includes(":cloud") ? model : `${model}:cloud`; }

/** The `claude` CLI surfaces server-side rate limiting / overload / 5xx as its result
 *  text (e.g. "API Error: Server is temporarily limiting requests (not your usage limit)
 *  · Rate limited"). Those are transient — the server is asking us to slow down, not a
 *  real phase failure — so we back off and retry instead of hard-failing the run. */
function isTransientApiError(summary: string): boolean {
  return /temporarily limiting requests|rate.?limit|overloaded|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|\b(502|503|504|529)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(summary);
}

/** The resumed session is GONE (expired/wiped) — it can't be resumed at all, so the only
 *  recovery is a FRESH session from the on-disk state (worktree + re-stated phase prompt
 *  carry the work). */
const SESSION_GONE = /No conversation found|session ID|--resume/i;
/** The resumed session OVERFLOWED the model's context window ("Prompt is too long"). The
 *  harness (Claude Code) normally auto-compacts; a single request can still momentarily
 *  exceed the limit, especially for a non-Anthropic model proxied via `ollama launch
 *  claude`, where the CLI's token accounting is approximate. This is NOT permanently fatal
 *  — we prefer COMPACTION (retry the same session) over throwing it away, and only restart
 *  fresh as a last resort. */
const CONTEXT_OVERFLOW = /prompt is too long|context (?:length|window)|exceed\w* .{0,20}context|too many tokens|maximum context/i;
/** The gateway rejected the REQUEST BODY as too large — typically an image-heavy phase (e.g.
 *  Capture Frames) that piled more base64 screenshots into one continuous session than the
 *  provider's body limit allows, surfacing as "400 failed to read request body" / 413. Unlike
 *  a token overflow, retrying the SAME session just re-sends the same oversized body and fails
 *  instantly, so this must go STRAIGHT to a FRESH, compacted session — the only thing that
 *  sheds the accumulated images. (Otherwise every Conductor "revise" re-resumes the poisoned
 *  session and re-fails identically.) */
const BODY_TOO_LARGE = /failed to read request body|request entity too large|payload too large|body.{0,20}too large|\b413\b/i;

export interface ClaudePhaseResult { summary: string; sessionId: string | null; ok: boolean }

export function runClaudePhase(opts: {
  workspace: string;
  prompt: string;
  model: string;                 // "opus" | "sonnet" | "default" (claude-native)
  ollamaModel?: string;          // if set, drive Claude Code via `ollama launch claude --model <tag>`
  sessionId?: string | null;     // resume an existing ticket session
  env: Record<string, string>;   // FACTORY_* for factool
  onText: (t: string) => void;
  onToolCall: (name: string, args: unknown) => void;
  onToolResult: (name: string, result: string) => void;
  signal?: AbortSignal;
  // Optional: produce a compact handoff summary of the work so far, used to SEED a fresh
  // session when the resumed one can't be used (overflowed past compaction, or gone). The
  // caller (runner) builds this with the selected coding model from the persisted events —
  // so a fresh session continues instead of starting blank. Returns null if unavailable.
  compactContext?: () => Promise<string | null>;
}): Promise<ClaudePhaseResult> {
  return (async () => {
    // The factory's tools (factool) reach the server over HTTP; claude's Bash tool
    // inherits this env. Build the claude args, then either run claude directly
    // (claude-native models) or via `ollama launch claude` (Ollama models — the
    // model BACKS the full Claude Code harness, same as the original factory).
    const build = (sessionId: string | null | undefined, prompt: string = opts.prompt) => {
      const claudeArgs = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
      if (sessionId) claudeArgs.push("--resume", sessionId);
      if (opts.ollamaModel) {
        return { command: "ollama", args: ["launch", "claude", "--model", cloudTag(opts.ollamaModel), "--", ...claudeArgs] };
      }
      if (opts.model && opts.model !== "default") claudeArgs.push("--model", opts.model);
      return { command: resolveClaude(), args: claudeArgs };
    };

    if (opts.ollamaModel) await ensureOllamaServe();

    // Exponential backoff with equal jitter for transient API errors (rate limit /
    // overload / 5xx). Without this, a momentary "Server is temporarily limiting
    // requests" hard-fails the whole run. Jitter matters: concurrent phases that hit
    // the same limit must NOT all retry at the same instant, or they re-trigger it.
    const MAX_ATTEMPTS = 6;
    // How many times to re-run an OVERFLOWED session before giving up on it: this lets the
    // harness auto-compact (and clears a one-off over-limit request) instead of immediately
    // discarding the session and its context.
    const MAX_OVERFLOW_RETRIES = 2;
    let sessionId = opts.sessionId ?? null;
    let overflowRetries = 0;
    let res!: ClaudePhaseResult;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const built = build(sessionId);
      res = await runProc(built.command, built.args, { ...opts, sessionId });

      // Context OVERFLOW on a resumed session — prefer COMPACTION over discarding it. Just
      // retry the SAME session: the harness gets another pass to compact, and a transient
      // over-limit request clears. Only after a few retries do we fall through to a fresh
      // session below. (Don't go fresh on the first overflow — that needlessly throws away
      // the agent's context when compaction would have kept it.)
      if (!res.ok && sessionId && CONTEXT_OVERFLOW.test(res.summary) && overflowRetries < MAX_OVERFLOW_RETRIES) {
        overflowRetries++;
        opts.onText(`\n[Context hit the model limit — retrying so the harness can compact (${overflowRetries}/${MAX_OVERFLOW_RETRIES})]\n`);
        await sleep(1500);
        continue; // re-resume the same session
      }

      // The session can't be used as-is — it's GONE (expired/wiped), or it's STILL
      // overflowing after compaction retries. Restart FRESH: the worktree files (spec.md,
      // the diff, mock) + the re-stated phase prompt already carry the durable work. As a
      // fallback for the lost in-memory context, ask the selected coding model to COMPACT
      // the session into a handoff summary and SEED the fresh session with it — so it
      // continues instead of starting blank. (Claude Code's own compaction above is still
      // the preferred path; this only runs when that couldn't keep the session usable.)
      if (!res.ok && sessionId && (SESSION_GONE.test(res.summary) || CONTEXT_OVERFLOW.test(res.summary) || BODY_TOO_LARGE.test(res.summary))) {
        let freshPrompt = opts.prompt;
        if (opts.compactContext) {
          opts.onText("\n[Session unusable — compacting it with the coding model to seed a fresh one]\n");
          const summary = await opts.compactContext().catch(() => null);
          if (summary && summary.trim()) {
            freshPrompt = `=== HANDOFF SUMMARY OF THE PREVIOUS (RESET) SESSION — continue from here; do NOT repeat work already done ===\n${summary.trim()}\n\n${opts.prompt}`;
          }
        }
        opts.onText("\n[Starting a fresh session from the on-disk state]\n");
        const fresh = build(null, freshPrompt);
        res = await runProc(fresh.command, fresh.args, { ...opts, sessionId: null });
      }

      // Resume the same session on retry so the phase keeps its context.
      sessionId = res.sessionId ?? sessionId;
      if (res.ok || !isTransientApiError(res.summary) || attempt + 1 >= MAX_ATTEMPTS) return res;
      const window = Math.min(60_000, 2000 * 2 ** attempt);
      const delayMs = window / 2 + Math.random() * (window / 2);
      opts.onText(`\n[API rate-limited — backing off ${Math.round(delayMs / 1000)}s, retry ${attempt + 2}/${MAX_ATTEMPTS}]\n`);
      await sleep(delayMs);
    }
    return res;
  })();
}

function runProc(command: string, args: string[], opts: Parameters<typeof runClaudePhase>[0]): Promise<ClaudePhaseResult> {
  return new Promise((resolve) => {
    // The factory runs as `next start --port 7777`, which sets PORT/HOST in its own
    // process.env at runtime. Passing those straight through means any dev server the
    // agent boots (e.g. `next start`) inherits PORT=7777 and tries to bind the FACTORY's
    // port — EADDRINUSE — and the agent then "frees the port" by killing the occupant,
    // i.e. the factory itself. Strip them so the app's servers use their own defaults.
    const inheritedEnv = { ...process.env };
    delete inheritedEnv.PORT;
    delete inheritedEnv.HOST;
    delete inheritedEnv.HOSTNAME;
    const proc = spawn(command, args, {
      cwd: opts.workspace,
      env: { ...inheritedEnv, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so abort (pause/rewind) can kill the whole tree, not just the launcher
    });

    let sessionId: string | null = opts.sessionId ?? null;
    let summary = "";
    let resultIsError = false;
    let buf = "";
    const lastToolName = new Map<string, string>(); // tool_use id -> name

    const onAbort = () => killTree(proc);
    opts.signal?.addEventListener("abort", onAbort);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "system" && e.session_id) sessionId = e.session_id;
        else if (e.type === "assistant") {
          for (const c of e.message?.content || []) {
            if (c.type === "text" && c.text) opts.onText(c.text);
            else if (c.type === "tool_use") { if (c.id) lastToolName.set(c.id, c.name); opts.onToolCall(c.name, c.input); }
          }
        } else if (e.type === "user") {
          for (const c of e.message?.content || []) {
            if (c.type === "tool_result") {
              const name = (c.tool_use_id && lastToolName.get(c.tool_use_id)) || "tool";
              const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text || "").join("") : String(c.content ?? "");
              opts.onToolResult(name, text);
            }
          }
        } else if (e.type === "result") {
          if (e.session_id) sessionId = e.session_id;
          summary = typeof e.result === "string" ? e.result : summary;
          // The CLI can report a failure here even when it exits 0 (e.g. an API error
          // mid-run). Don't treat that as a passing phase.
          if (e.is_error || (typeof e.subtype === "string" && /error/i.test(e.subtype))) resultIsError = true;
        }
      }
    });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code, sig) => {
      opts.signal?.removeEventListener("abort", onAbort);
      // code === null + a signal means the process was KILLED, not that it exited. Our own
      // pause/rewind aborts are handled by the caller (opts.signal.aborted); anything else is
      // almost always the agent running a broad pkill/kill that matched its OWN harness. Name
      // that plainly so the run (and the Conductor) understands it wasn't a real work failure.
      if (code === null && sig && !opts.signal?.aborted && !summary) {
        summary = `The agent's own process was killed (signal ${sig}) mid-phase — a self-inflicted termination: a command the agent ran (almost always a broad \`pkill\`/\`kill\`) killed the \`claude\`/\`ollama\` harness that was running it. This is NOT a failure of the actual work. Re-run; the agent must never pkill/kill by name or pattern.`;
      } else if (code !== 0 && !summary) {
        summary = `claude exited ${code}: ${stderr.slice(0, 300)}`;
      }
      resolve({ summary: summary || "(no summary)", sessionId, ok: code === 0 && !resultIsError });
    });
    proc.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ summary: `failed to spawn claude: ${err.message}`, sessionId, ok: false });
    });
  });
}
