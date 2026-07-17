/**
 * THE TOOL REGISTRY — the only imperative code in Atelier.
 *
 * Each tool is a real, well-described capability the AI may choose to use while
 * pursuing a state's goal. States attach tools by name; the generic agent loop
 * (agent.ts) offers the attached tools to the model and executes whatever it calls.
 *
 * To make the system capable of something new, add a TOOL here — never a branch
 * in the runner. See CLAUDE.md ("State Machine with Tools").
 */
import type { Tool } from "ollama";
import { promises as fs } from "fs";
import { resolve, join, dirname, extname, basename } from "path";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { exec } from "child_process";
import { screenshot as captureScreenshot, recordWalkthrough, type CaptureStep } from "./capture";
import { analyzeImage } from "./vision";
import { geminiEvaluate } from "./gemini";
import { startDevServer } from "./devserver";
import { authenticateAndSave } from "./auth";
import { openLiveBrowser } from "./testdrive";
import { getRun, recordPrinciples, getCriteria, setCriteriaStatus, DELIVERABLES_DIR } from "../db";

export type ArtifactKind = "markdown" | "html" | "json" | "text" | "image" | "video";

export interface ToolContext {
  workspace: string;
  runId: string;
  state: string;
  /** The multimodal helper model for analyze_image (e.g. ollama:kimi-k2.6). */
  visionModel?: string | null;
  /** Persist + broadcast an artifact ("display a thing"). For image/video the
   *  body is a workspace-relative file path served by the run file route. */
  emitArtifact(a: { name: string; kind: ArtifactKind; body: string }): void;
  /** A scratch screenshot the agent took to SEE its work — shown inline in the
   *  activity log, NOT added to Deliverables (so self-checks don't flood it). */
  emitScreenshot(name: string, relPath: string): void;
  /** Register a RETURNED FILE as a run deliverable (a persistent copy already made
   *  at storedPath). Persists the row + a timeline event; returns the deliverable id
   *  so the tool can point the human at its download URL. */
  emitDeliverable(d: { id: string; filename: string; storedPath: string; size: number; mime: string; label?: string | null; description?: string | null }): void;
  /** Expose the FINAL output SET for the run: persists these as deliverables flagged
   *  is_final=1 and clears any previously-exposed final set, so the human sees THIS as
   *  "the output" (not every intermediate file). Used by the expose_output tool. */
  emitFinalDeliverables(list: { id: string; filename: string; storedPath: string; size: number; mime: string; label?: string | null; description?: string | null }[]): void;
  log(line: string): void;
}

export interface ToolDef {
  schema: Tool;
  /** A short label shown in the machine editor. */
  label: string;
  /** True for control tools (request_approval / complete) that end the agent loop.
   *  Control tools are always available — they are not "attachable". */
  control?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Resolve a model-supplied path against the run workspace, robustly (absolute
// paths and dropped-leading-slash paths both land inside the workspace).
function resolvePath(workspace: string, p: string): string {
  let path = (p || "").trim();
  if (/^(Users|home|var|private|Volumes|tmp|opt|etc)\//.test(path)) path = "/" + path;
  const abs = resolve(workspace, path);
  // Keep everything inside the workspace sandbox.
  if (!abs.startsWith(resolve(workspace))) return join(workspace, path.replace(/^(\.\.[/\\])+/, ""));
  return abs;
}

// Content-type inference from a file extension — for the GENERIC return_file tool
// (any file type). Falls back to application/octet-stream for unknowns. Kept in sync
// with the deliverables download route so the browser is told the right type.
const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
  ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".zip": "application/zip", ".tar": "application/x-tar",
  ".gz": "application/gzip", ".tgz": "application/gzip", ".bz2": "application/x-bzip2", ".7z": "application/x-7z-compressed",
  ".json": "application/json", ".jsonl": "application/jsonl", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".xml": "application/xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".parquet": "application/vnd.apache.parquet", ".bin": "application/octet-stream",
};
export function inferMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] || "application/octet-stream";
}
// Human-readable byte size, for tool result text / logs.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function run_command_exec(cmd: string, cwd: string, timeout = 60000): Promise<string> {
  return new Promise((res) => {
    exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      if (err && !out.trim()) res(`Error: ${err.message}`);
      else res((out || "(no output)").slice(0, 12000));
    });
  });
}

const REGISTRY: Record<string, ToolDef> = {};
function register(def: ToolDef) { REGISTRY[def.schema.function!.name!] = def; }

// ----------------------------------------------------------------------------
// Exploration / read tools
// ----------------------------------------------------------------------------
register({
  label: "Read a file",
  schema: { type: "function", function: {
    name: "read_file",
    description: "Read the contents of a file in the workspace. Use to understand existing artifacts and code before acting.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root" } }, required: ["path"] },
  } },
  async run(args, ctx) {
    try {
      const body = await fs.readFile(resolvePath(ctx.workspace, String(args.path)), "utf-8");
      return body.length > 18000 ? body.slice(0, 18000) + `\n... (truncated, ${body.length} chars total)` : body;
    } catch { return `Error: file not found: ${args.path}`; }
  },
});

register({
  label: "List a directory",
  schema: { type: "function", function: {
    name: "list_directory",
    description: "List files and folders in a workspace directory. Use '.' for the workspace root.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Directory path relative to workspace (default '.')" } } },
  } },
  async run(args, ctx) {
    try {
      const dir = resolvePath(ctx.workspace, String(args.path || "."));
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (!entries.length) return "(empty directory)";
      return entries.filter(e => !["node_modules", ".next", ".git"].includes(e.name))
        .map(e => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`).join("\n");
    } catch { return `Error: directory not found: ${args.path}`; }
  },
});

register({
  label: "Search code/text",
  schema: { type: "function", function: {
    name: "search_code",
    description: "Search the workspace for a text/regex pattern. Returns matching lines with file paths.",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  } },
  async run(args, ctx) {
    const p = String(args.pattern).replace(/"/g, '\\"');
    const out = await run_command_exec(`grep -rni "${p}" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next 2>/dev/null | head -40`, ctx.workspace, 8000);
    return out.trim() || `No matches for: ${args.pattern}`;
  },
});

register({
  label: "Run a shell command",
  schema: { type: "function", function: {
    name: "run_command",
    description: "Run a shell command inside the workspace (e.g. ls, cat, node -e, npm test, git status). Use for checks and verification.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  } },
  async run(args, ctx) {
    const cmd = String(args.command);
    if (/\b(sudo|rm -rf \/|git push|npm publish|shutdown|mkfs|:\(\)\{)/.test(cmd)) return `Error: command blocked for safety: ${cmd}`;
    ctx.log(`$ ${cmd}`);
    return run_command_exec(cmd, ctx.workspace);
  },
});

// ----------------------------------------------------------------------------
// Mutation tools
// ----------------------------------------------------------------------------
register({
  label: "Write a file",
  schema: { type: "function", function: {
    name: "write_file",
    description: "Create or overwrite a file in the workspace. Creates parent directories automatically. Use this to write code, specs, configs, etc.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  } },
  async run(args, ctx) {
    const abs = resolvePath(ctx.workspace, String(args.path));
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(args.content ?? ""));
    ctx.log(`wrote ${args.path} (${String(args.content ?? "").length} bytes)`);
    return `File written: ${args.path}`;
  },
});

register({
  label: "Edit a file",
  schema: { type: "function", function: {
    name: "edit_file",
    description: "Replace an exact substring in an existing workspace file. Prefer this for small targeted edits.",
    parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
  } },
  async run(args, ctx) {
    const abs = resolvePath(ctx.workspace, String(args.path));
    try {
      let body = await fs.readFile(abs, "utf-8");
      if (!body.includes(String(args.old_text))) return `Error: old_text not found in ${args.path}`;
      body = body.replace(String(args.old_text), String(args.new_text));
      await fs.writeFile(abs, body);
      return `File edited: ${args.path}`;
    } catch { return `Error: file not found: ${args.path}`; }
  },
});

// ----------------------------------------------------------------------------
// "Display a thing" — surface a reviewable artifact to the human
// ----------------------------------------------------------------------------
register({
  label: "Display an artifact",
  schema: { type: "function", function: {
    name: "display_artifact",
    description: "Show the human a deliverable for this state: a spec, a plan, an HTML mockup, a QA report, JSON, etc. It renders IN the UI for review. ALWAYS display before requesting approval. For a UI mockup use kind 'html'. IMPORTANT: to show an HTML mock, set file to the workspace path (e.g. 'option-1.html') and the FULL file content is loaded and rendered — do NOT just write 'see the file' in body. Use body only for inline content you typed yourself.",
    parameters: { type: "object", properties: {
      name: { type: "string", description: "A short title, e.g. 'Option 1 — Stacked studio', 'QA Report'" },
      kind: { type: "string", enum: ["markdown", "html", "json", "text", "image", "video", "file"], description: "How to render it. A screenshot/recording: pass via 'file' (.png/.jpg/.mp4) → shown as a picture/video. A DOWNLOADABLE artifact the human should save (a .zip / .csv / archive / dataset): use kind 'file' with 'file' set to its workspace path → the UI shows a Download button (no URL needed). Never inline binary as text." },
      file: { type: "string", description: "Workspace path of a file to load and render (HTML mock, a .png/.jpg/.mp4 capture, or — with kind 'file' — a .zip/.csv/etc. to present as a download)" },
      body: { type: "string", description: "Inline content (use this OR file)" },
    }, required: ["name", "kind"] },
  } },
  async run(args, ctx) {
    let kind = String(args.kind || "markdown");
    let body = String(args.body ?? "");
    if (args.file) {
      const f = String(args.file);
      // An image/video can't be inlined as text — present it as a file the run's file
      // route serves (body = the workspace-relative path).
      if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f) || /\.(mp4|webm|mov|m4v)$/i.test(f)) {
        kind = /\.(mp4|webm|mov|m4v)$/i.test(f) ? "video" : "image";
        // The file is served from the workspace, not inlined — so it MUST actually
        // exist and be non-empty, or the human sees a broken image / 0:00 video.
        let buf: Buffer | null = null;
        try { buf = await fs.readFile(resolvePath(ctx.workspace, f)); } catch { /* missing */ }
        if (!buf || buf.length === 0) return `Error: the ${kind} file "${f}" doesn't exist (or is empty) in the workspace. Actually produce it first — e.g. record_walkthrough / screenshot_page must have really written a file — then present that exact path. Do NOT present a deliverable whose file isn't there.`;
        // FREEZE the deliverable at present-time. A path like docs/demo.mp4 gets reused and
        // OVERWRITTEN by the next re-cut, which would silently collapse every past attempt's
        // video onto the newest file — so old "attempts" all resolve to the same bytes and the
        // viewer can't tell them apart. (Text/HTML deliverables are already immutable: they
        // inline their content into `body` below.) Snapshot the media to a content-addressed
        // path so each present keeps its own frame; identical bytes dedupe to one file,
        // different bytes get distinct URLs the UI can actually switch between.
        try {
          const ext = (f.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
          const rel = join(".deliverables", `${createHash("sha1").update(buf).digest("hex").slice(0, 16)}${ext}`);
          const snap = resolvePath(ctx.workspace, rel);
          await fs.mkdir(dirname(snap), { recursive: true });
          try { await fs.access(snap); } catch { await fs.writeFile(snap, buf); }
          body = rel;
        } catch { body = f; } // snapshot failed — fall back to the live (mutable) path
      }
      // A downloadable artifact (archive/dataset/binary): present it as a 'file' the run's
      // file route serves with a download button — body = the workspace-relative path, NOT inlined.
      else if (kind === "file" || /\.(zip|tar|t?gz|bz2|7z|rar|csv|tsv|pdf|xlsx?|parquet|bin|jsonl)$/i.test(f)) {
        kind = "file";
        let sz = -1; try { sz = (await fs.stat(resolvePath(ctx.workspace, f))).size; } catch { /* missing */ }
        if (sz <= 0) return `Error: the file "${f}" doesn't exist (or is empty) in the workspace. Actually produce it first, then present that exact path.`;
        body = f;
      }
      else {
        try { body = await fs.readFile(resolvePath(ctx.workspace, f), "utf-8"); }
        catch { return `Error: could not read file "${f}" to display. Write it first, or pass body instead.`; }
      }
    }
    kind = (["markdown", "html", "json", "text", "image", "video", "file"].includes(kind) ? kind : "markdown") as any;
    if (!body.trim()) return `Error: nothing to display — pass file (a workspace path) or body.`;
    ctx.emitArtifact({ name: String(args.name || "Artifact"), kind: kind as any, body });
    return `Displayed "${args.name}" to the human${kind === "image" || kind === "video" ? ` (${kind})` : kind === "file" ? ` (downloadable: ${body})` : ` (${body.length} chars)`}, rendered in the UI.`;
  },
});

// ----------------------------------------------------------------------------
// Return a finished FILE to the human — the generic "here's your output" tool.
// ----------------------------------------------------------------------------
register({
  label: "Return a file",
  schema: { type: "function", function: {
    name: "return_file",
    description: "Deliver a FINISHED output file to the human — ANY file type (an .mp3, .mp4, .zip, .csv, .pdf, dataset, …). Give the path to a real file you produced in your workspace; the factory copies it into a persistent store (so it survives after this run) and shows it in the run's Downloads section with a Download button the human taps. Call this in the final/deliver phase once the file is verified. Safe to call multiple times to return several files. This is how a loop hands a real file back — not display_artifact.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Path to the file to return, relative to your workspace root (e.g. 'output/song.mp3'). Must be a real, non-empty file inside the workspace." },
      label: { type: "string", description: "Optional short human title for the download (e.g. 'Song — MP3, 320kbps'). Defaults to the filename." },
      description: { type: "string", description: "Optional one-line note about what this file is (e.g. duration/bitrate/source)." },
      filename: { type: "string", description: "Optional download filename to present it as (defaults to the file's own name). Use to give a clean, human name." },
    }, required: ["path"] },
  } },
  async run(args, ctx) {
    const rel = String(args.path || "").trim();
    if (!rel) return `Error: return_file needs a "path" to the file you produced in the workspace.`;
    // Resolve inside the workspace sandbox and REJECT anything that escapes it.
    const abs = resolvePath(ctx.workspace, rel);
    const root = resolve(ctx.workspace);
    if (abs !== root && !abs.startsWith(root + "/"))
      return `Error: "${rel}" resolves outside your workspace — you can only return files you produced inside it.`;
    let st;
    try { st = await fs.stat(abs); } catch { return `Error: no such file "${rel}" in your workspace. Produce it first, then return that exact path.`; }
    if (!st.isFile()) return `Error: "${rel}" is not a file.`;
    if (st.size <= 0) return `Error: "${rel}" is empty (0 bytes). A real deliverable must have content — check the previous step actually produced it.`;

    // Present-name + mime. Copy the file OUT of the (transient) worktree into the
    // persistent deliverables store so it stays downloadable after the run ends.
    const rawName = String(args.filename || basename(abs)).trim() || basename(abs);
    const safeName = rawName.replace(/[/\\]/g, "_").replace(/^\.+/, "").slice(0, 200) || "download";
    const mime = inferMime(safeName);
    const id = nanoid();
    const destDir = join(DELIVERABLES_DIR, ctx.runId);
    await fs.mkdir(destDir, { recursive: true });
    const dest = join(destDir, `${id}__${safeName}`);
    await fs.copyFile(abs, dest);

    const label = args.label ? String(args.label).slice(0, 200) : null;
    const description = args.description ? String(args.description).slice(0, 500) : null;
    ctx.emitDeliverable({ id, filename: safeName, storedPath: dest, size: st.size, mime, label, description });
    return `Returned "${safeName}" (${humanSize(st.size)}, ${mime}) to the human — it's now in this run's Downloads with a Download button. It was copied to a persistent store, so it stays available after the run finishes.`;
  },
});

// ----------------------------------------------------------------------------
// Expose the FINAL output — the one/few files that ARE the result.
// ----------------------------------------------------------------------------
register({
  label: "Expose the final output",
  schema: { type: "function", function: {
    name: "expose_output",
    description: "Designate the DEFINITIVE final output of this loop — the one or few files that ARE the result the human asked for. The human sees THESE (and only these) as 'the output', instead of every intermediate file returned along the way. Call this ONCE, at the very end, after the deliverable is verified. It REPLACES any previously-exposed output, so pass the COMPLETE final set in a single call. Prefer this over return_file for the final hand-off; use return_file only for extra/intermediate files.",
    parameters: { type: "object", properties: {
      files: { type: "array", description: "The complete final output set, in the order to show. Each is a real, non-empty file you produced in your workspace.", items: { type: "object", properties: {
        path: { type: "string", description: "Path to the file, relative to your workspace root (e.g. 'output/final.mp4'). Must be a real, non-empty file." },
        label: { type: "string", description: "Optional short human title (e.g. 'Atelier demo reel — MP4')." },
        description: { type: "string", description: "Optional one-line note about what this file is." },
        filename: { type: "string", description: "Optional clean download filename (defaults to the file's own name)." },
      }, required: ["path"] } },
    }, required: ["files"] },
  } },
  async run(args, ctx) {
    const files: any[] = Array.isArray(args.files) ? args.files : [];
    if (!files.length) return `Error: expose_output needs a non-empty "files" array — the final file(s) that ARE the output.`;
    const root = resolve(ctx.workspace);
    const destDir = join(DELIVERABLES_DIR, ctx.runId);
    await fs.mkdir(destDir, { recursive: true });
    const out: { id: string; filename: string; storedPath: string; size: number; mime: string; label: string | null; description: string | null }[] = [];
    for (const f of files) {
      const rel = String(f?.path || "").trim();
      if (!rel) return `Error: each item in "files" needs a "path" to a real file in your workspace.`;
      const abs = resolvePath(ctx.workspace, rel);
      if (abs !== root && !abs.startsWith(root + "/")) return `Error: "${rel}" resolves outside your workspace — you can only expose files you produced inside it.`;
      let st;
      try { st = await fs.stat(abs); } catch { return `Error: no such file "${rel}" in your workspace. Produce it first, then expose that exact path.`; }
      if (!st.isFile()) return `Error: "${rel}" is not a file.`;
      if (st.size <= 0) return `Error: "${rel}" is empty (0 bytes) — a real deliverable must have content.`;
      const rawName = String(f?.filename || basename(abs)).trim() || basename(abs);
      const safeName = rawName.replace(/[/\\]/g, "_").replace(/^\.+/, "").slice(0, 200) || "download";
      const id = nanoid();
      const dest = join(destDir, `${id}__${safeName}`);
      await fs.copyFile(abs, dest);
      out.push({ id, filename: safeName, storedPath: dest, size: st.size, mime: inferMime(safeName), label: f?.label ? String(f.label).slice(0, 200) : null, description: f?.description ? String(f.description).slice(0, 500) : null });
    }
    ctx.emitFinalDeliverables(out);
    return `Exposed ${out.length} final output file${out.length > 1 ? "s" : ""} to the human: ${out.map((d) => d.filename).join(", ")}. These are now shown as THE output (replacing any previously-exposed set); intermediate files stay available under "earlier versions".`;
  },
});

// ----------------------------------------------------------------------------
// Run the real app — boot its dev server and WAIT until it serves
// ----------------------------------------------------------------------------
register({
  label: "Start the dev server",
  schema: { type: "function", function: {
    name: "start_dev_server",
    description: "Boot the project's dev server inside the workspace and WAIT until it actually answers (Next's first compile is slow — don't hand-roll this with sleep). Returns the base URL to screenshot_page / record_walkthrough against. Use this in QA before recording the real app. One server per run; it's torn down when the phase ends.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "Dev command (default 'npm run dev')" },
      port: { type: "number", description: "Port (default auto, stable per run)" },
      readyPath: { type: "string", description: "Path to poll for readiness (default '/')" },
      timeoutSec: { type: "number", description: "How long to wait for it to come up (default 150)" },
    } },
  } },
  async run(args, ctx) {
    try {
      const r = await startDevServer({
        workspace: ctx.workspace, runId: ctx.runId,
        command: args.command ? String(args.command) : undefined,
        port: args.port ? Number(args.port) : undefined,
        readyPath: args.readyPath ? String(args.readyPath) : undefined,
        timeoutMs: args.timeoutSec ? Number(args.timeoutSec) * 1000 : undefined,
        log: ctx.log,
      });
      return r.note + (r.ok ? `\nNow record_walkthrough with url:"${r.url}/<the feature route>".` : "");
    } catch (e) { return `Error starting dev server: ${e instanceof Error ? e.message : String(e)}`; }
  },
});

register({
  label: "Log in (pre-auth)",
  schema: { type: "function", function: {
    name: "authenticate",
    description: "Log into an auth-walled app ONCE and persist the session, so screenshot_page / record_walkthrough then run AUTHENTICATED (no login wall in your captures). Use in QA after start_dev_server when the app requires login. Find test credentials in the repo's fixtures (.env.test, e2e/auth.setup.ts, scripts/seed-test-users.sql or db-reset.sh) — do NOT invent users. Pass the dev-server URL + the login path.",
    parameters: { type: "object", properties: {
      loginUrl: { type: "string", description: "Full login URL, e.g. http://localhost:3121/auth/login" },
      email: { type: "string", description: "Test account email (from fixtures)" },
      password: { type: "string", description: "Test account password (from fixtures)" },
      authedRoute: { type: "string", description: "Full URL of a protected route to verify, e.g. http://localhost:3121/dashboard" },
      emailSelector: { type: "string" }, passwordSelector: { type: "string" }, submitSelector: { type: "string" },
    }, required: ["loginUrl", "email", "password"] },
  } },
  async run(args, ctx) {
    const r = await authenticateAndSave({
      workspace: ctx.workspace, loginUrl: String(args.loginUrl), email: String(args.email), password: String(args.password),
      authedRoute: args.authedRoute ? String(args.authedRoute) : undefined,
      emailSelector: args.emailSelector ? String(args.emailSelector) : undefined,
      passwordSelector: args.passwordSelector ? String(args.passwordSelector) : undefined,
      submitSelector: args.submitSelector ? String(args.submitSelector) : undefined,
    });
    return r.message;
  },
});

register({
  label: "Test-drive the app",
  schema: { type: "function", function: {
    name: "test_drive",
    description: "Open the RUNNING app in a real, visible Chrome window — logged in (restores the session saved by `authenticate`) and on the feature — and leave it open so the HUMAN can click around and test it themselves. Use on the final/PR phase after start_dev_server (+ authenticate if the app needs login). Pass the full feature URL.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full URL to land on, e.g. http://localhost:3121/dashboard" },
    }, required: ["url"] },
  } },
  async run(args, ctx) {
    const r = await openLiveBrowser(ctx.runId, ctx.workspace, String(args.url));
    return r.message;
  },
});

// ----------------------------------------------------------------------------
// Watch a PR — poll its CI checks + mergeability until they SETTLE, then report.
// The "did it actually go green / merge cleanly?" capability, the same idea as a
// PR watcher: it POLLS GitHub for you so the model never hand-rolls a sleep loop.
// It ONLY OBSERVES (read-only `gh`) — how to react (rebase, fix a check, finish)
// stays the model's judgement, per CLAUDE.md. Nothing stage-specific lives here.
// ----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CheckBucket = "pass" | "fail" | "pending";
interface PrCheck { name: string; bucket: CheckBucket; detail: string; url: string }

/** Fold a `gh pr view --json statusCheckRollup` array (a mix of GitHub Actions
 *  CheckRuns and legacy commit StatusContexts) into a simple pass/fail/pending list. */
function classifyRollup(rollup: unknown[]): PrCheck[] {
  const out: PrCheck[] = [];
  for (const raw of rollup || []) {
    const c = (raw || {}) as Record<string, string>;
    const isStatusContext = c.__typename === "StatusContext" || (!c.status && !c.conclusion && !!c.state);
    if (isStatusContext) {
      const state = String(c.state || "").toUpperCase();
      const bucket: CheckBucket = ["PENDING", "EXPECTED"].includes(state) ? "pending" : ["ERROR", "FAILURE"].includes(state) ? "fail" : "pass";
      out.push({ name: c.context || c.name || "status", bucket, detail: state || "?", url: c.targetUrl || "" });
    } else {
      const status = String(c.status || "").toUpperCase();        // QUEUED / IN_PROGRESS / COMPLETED
      const concl = String(c.conclusion || "").toUpperCase();     // SUCCESS / FAILURE / NEUTRAL / SKIPPED / …
      let bucket: CheckBucket;
      if (status && status !== "COMPLETED") bucket = "pending";
      else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(concl)) bucket = "fail";
      else bucket = "pass";                                        // SUCCESS / NEUTRAL / SKIPPED / completed-clean
      out.push({ name: c.name || c.context || "check", bucket, detail: concl || status || "?", url: c.detailsUrl || c.targetUrl || "" });
    }
  }
  return out;
}

register({
  label: "Watch the PR (CI + rebase)",
  schema: { type: "function", function: {
    name: "watch_pr",
    description: "Monitor the open pull request until its CI checks CONCLUDE, then report the result so you can react — the same job a PR watcher does. It POLLS GitHub for you (read-only `gh`), so do NOT hand-roll a sleep loop or repeated `gh` calls: this one call blocks until every check has finished (success/failure) or the wait budget elapses, then reports each check's outcome, whether the PR is mergeable, and whether the branch has fallen BEHIND its base (a rebase is needed) or CONFLICTS with it. It changes NOTHING — YOU decide how to react: rebase onto the latest base, fix a failing check and push, or finish once it's green. After you push a fix, call it AGAIN to re-verify. Use on the final PR/watch phase, after the PR is open.",
    parameters: { type: "object", properties: {
      pr: { type: "string", description: "PR number or URL (default: the PR for the current branch)" },
      timeoutSec: { type: "number", description: "Max seconds to wait for checks to conclude THIS call (default 300, max 1200). If checks are still pending when it elapses, it returns what it has so you can decide (and call again to keep waiting)." },
      intervalSec: { type: "number", description: "Seconds between polls (default 30, min 10)" },
    } },
  } },
  async run(args, ctx) {
    const ref = args.pr ? String(args.pr).trim() : "";
    const maxWaitMs = Math.min(Math.max(Number(args.timeoutSec) || 300, 10), 1200) * 1000;
    const intervalMs = Math.max(Number(args.intervalSec) || 30, 10) * 1000;
    const fields = "number,url,state,mergeable,mergeStateStatus,baseRefName,headRefName,statusCheckRollup";
    const view = () => run_command_exec(`gh pr view ${ref ? `"${ref.replace(/"/g, "")}" ` : ""}--json ${fields} 2>&1`, ctx.workspace, 30000);

    const start = Date.now();
    let last: Record<string, unknown> | null = null;
    while (true) {
      const rawOut = await view();
      let data: Record<string, unknown>;
      try { data = JSON.parse(rawOut); }
      catch {
        return `Error: could not read PR status via \`gh pr view\`. Output:\n${rawOut.slice(0, 800)}\n\nMake sure a PR is open for this branch (open it first) and \`gh\` is authenticated.`;
      }
      last = data;
      const checks = classifyRollup((data.statusCheckRollup as unknown[]) || []);
      const pending = checks.filter((c) => c.bucket === "pending");
      const failed = checks.filter((c) => c.bucket === "fail");
      const state = String(data.state || "").toUpperCase();
      const waited = Math.round((Date.now() - start) / 1000);
      ctx.log(`watch_pr: PR #${data.number} ${state} — ${checks.length - pending.length}/${checks.length} checks done${failed.length ? `, ${failed.length} failing` : ""}${pending.length ? `, waiting on ${pending.map((c) => c.name).join(", ")}` : ""} (${waited}s)`);
      // Settled = the PR left "open", or every check has concluded. Otherwise keep polling
      // until one more interval would blow the wait budget.
      const settled = state !== "OPEN" || pending.length === 0;
      if (settled || Date.now() - start + intervalMs >= maxWaitMs) break;
      await sleep(intervalMs);
    }

    // Format the report from the final snapshot.
    const d = last!;
    const checks = classifyRollup((d.statusCheckRollup as unknown[]) || []);
    const pending = checks.filter((c) => c.bucket === "pending");
    const failed = checks.filter((c) => c.bucket === "fail");
    const passed = checks.filter((c) => c.bucket === "pass");
    const state = String(d.state || "").toUpperCase();
    const mergeable = String(d.mergeable || "UNKNOWN").toUpperCase();
    const mss = String(d.mergeStateStatus || "").toUpperCase();
    const behind = mss === "BEHIND";
    const conflicts = mergeable === "CONFLICTING" || mss === "DIRTY";
    const glyph = (b: CheckBucket) => (b === "pass" ? "✓" : b === "fail" ? "✗" : "…");

    const lines: string[] = [];
    lines.push(`PR #${d.number} — ${state}${d.url ? `  ${d.url}` : ""}`);
    lines.push(`Base: ${d.baseRefName} ← ${d.headRefName}`);
    lines.push(`Checks: ${checks.length} total — ${passed.length} passed, ${failed.length} failed, ${pending.length} pending${pending.length ? " (wait budget elapsed — still running)" : ""}`);
    for (const c of checks) lines.push(`  ${glyph(c.bucket)} ${c.name} — ${c.detail}${c.url ? `  ${c.url}` : ""}`);
    if (!checks.length) lines.push("  (no CI checks are configured on this repo / PR)");
    lines.push(`Mergeable: ${mergeable}   Merge state: ${mss || "?"}`);

    const rec: string[] = [];
    if (state === "MERGED") rec.push("The PR is already MERGED — nothing left to watch. You're done.");
    else if (state === "CLOSED") rec.push("The PR is CLOSED without merging — stop watching and check with the human.");
    else {
      if (conflicts) rec.push("It CONFLICTS with the base branch — rebase onto the latest base, resolve the conflicts keeping BOTH intents, re-verify (`npx tsc --noEmit` + fast checks), then `git push --force-with-lease` and call watch_pr again.");
      else if (behind) rec.push("The branch is BEHIND its base — rebase/update onto the latest base and push (`git fetch origin <base>` → `git rebase origin/<base>` → `git push --force-with-lease`) so it merges cleanly and CI re-runs against the current base.");
      if (failed.length) rec.push(`${failed.length} check(s) FAILING (${failed.map((c) => c.name).join(", ")}) — inspect the failing job's logs (\`gh run view --log-failed\`, or open the check URL above), fix the ROOT CAUSE in the code, commit only the source you changed, push, then call watch_pr again.`);
      if (pending.length && !failed.length && !conflicts && !behind) rec.push(`${pending.length} check(s) still running — call watch_pr again (optionally a longer --timeoutSec) to keep waiting for them to conclude.`);
      if (!failed.length && !pending.length && !conflicts && !behind) rec.push(checks.length ? "All checks are GREEN and the branch is clean/mergeable — the PR is ready. Finish: display a short status note and request_approval." : "No CI checks to wait on and the branch is clean/mergeable — nothing to fix. Finish: display a short status note and request_approval.");
    }
    lines.push("", "→ " + (rec.join("\n→ ") || "See status above; decide your next step."));
    return lines.join("\n");
  },
});

// ----------------------------------------------------------------------------
// Visual capture — render a real browser and SEE / RECORD the result
// ----------------------------------------------------------------------------
register({
  label: "Screenshot a page",
  schema: { type: "function", function: {
    name: "screenshot_page",
    description: "Render a page in a real headless browser and capture a screenshot so you (and the vision helper) can SEE it. Target EITHER a workspace HTML file (path) OR a running dev-server URL (url). By DEFAULT this is a SCRATCH self-check — it shows in the activity log but is NOT added to Deliverables, so your repeated checks don't flood it. Set present:true ONLY for a final image you want to formally present as a deliverable. To judge it when you can't view images, follow up with analyze_image on the returned path.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative .html file to render (use this OR url)" },
      url: { type: "string", description: "A running page URL to render (use this OR path)" },
      name: { type: "string", description: "Title for the image" },
      present: { type: "boolean", description: "true = add to Deliverables as a presented image; false (default) = scratch self-check" },
      width: { type: "number", description: "Viewport width (default 1280)" },
      height: { type: "number", description: "Viewport height (default 800)" },
    } },
  } },
  async run(args, ctx) {
    const target = args.url ? String(args.url) : resolvePath(ctx.workspace, String(args.path || ""));
    if (!args.url && !args.path) return "Error: provide either path or url.";
    const rel = join(".captures", `shot-${Date.now()}.png`);
    const out = join(ctx.workspace, rel);
    const name = String(args.name || "Screenshot");
    try {
      await captureScreenshot(target, out, { width: Number(args.width) || undefined, height: Number(args.height) || undefined });
      if (args.present) ctx.emitArtifact({ name, kind: "image", body: rel });
      else ctx.emitScreenshot(name, rel);
      return `Captured ${args.url || args.path} → ${rel}${args.present ? " (presented as a deliverable)" : " (scratch — in the activity log only)"}. If you can't view images, call analyze_image on "${rel}" to judge it.`;
    } catch (e) { return `Error capturing screenshot: ${e instanceof Error ? e.message : String(e)}`; }
  },
});

register({
  label: "Analyze an image (vision helper)",
  schema: { type: "function", function: {
    name: "analyze_image",
    description: "Ask the multimodal vision helper to LOOK at an image (a screenshot or recorded frame) and answer a question about it. Use this for visual judgment and QA when you cannot see images yourself — e.g. 'Does this look like a polished, working version of this feature? List anything broken.' Pass the path returned by screenshot_page.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative path to the image (e.g. a .captures/*.png from screenshot_page)" },
      question: { type: "string", description: "What you want judged about the image" },
    }, required: ["path", "question"] },
  } },
  async run(args, ctx) {
    const abs = resolvePath(ctx.workspace, String(args.path));
    try { return await analyzeImage({ imagePath: abs, question: String(args.question || "Describe this UI and flag any problems."), visionModel: ctx.visionModel }); }
    catch (e) { return `Error analyzing image: ${e instanceof Error ? e.message : String(e)}`; }
  },
});

register({
  label: "Evaluate an image/video with Gemini",
  schema: { type: "function", function: {
    name: "gemini_eval",
    description: "Have Google Gemini LOOK AT an image or a VIDEO and judge it against your question/criteria — an objective visual + MOTION evaluation you can't do yourself (and that analyze_image can't do for video). Use it to score a generated image, a rendered frame, a sprite sheet, or a recorded walkthrough against the goal's success criteria (e.g. 'Is this a smooth, professional loading spinner? Score 1-10 and list every defect.'). Pass workspace-relative path(s) + a specific, criteria-driven question. Returns Gemini's judgment as text.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative path to ONE image (png/jpg/webp/gif) or video (mp4/mov/webm)" },
      paths: { type: "array", items: { type: "string" }, description: "Multiple files to judge/compare together (optional; use instead of path)" },
      question: { type: "string", description: "What to judge — specific and criteria-driven. Ask for a score and a concrete list of defects vs the success criteria." },
      model: { type: "string", description: "Gemini model (default gemini-2.5-pro; pass gemini-2.5-flash for a faster, cheaper check)" },
    }, required: ["question"] },
  } },
  async run(args, ctx) {
    const rels = Array.isArray(args.paths) && args.paths.length ? args.paths : (args.path ? [args.path] : []);
    if (!rels.length) return "Error: provide `path` or `paths` to the image/video to evaluate.";
    const abs = rels.map((r: unknown) => resolvePath(ctx.workspace, String(r)));
    return await geminiEvaluate({ paths: abs, question: String(args.question || "Evaluate this output. Score 1-10 and list every defect."), model: args.model ? String(args.model) : undefined });
  },
});

// Self-learning's tool: fold a durable lesson into the loop itself.
register({
  label: "Record a loop principle",
  schema: { type: "function", function: {
    name: "record_principles",
    description: "Record durable, GENERALIZED principle(s) onto THIS loop so it improves over time — each a standing rule the loop should follow on EVERY future run (e.g. distilled from the human's feedback). NOT a one-off fix for this run: phrase each as a short, imperative, reusable rule. Recorded principles show in the loop's Self-learning settings and are injected into future runs, so the same feedback isn't needed twice.",
    parameters: { type: "object", properties: {
      principles: { type: "array", items: { type: "string" }, description: "One or more short, general, imperative principles to add to the loop." },
    }, required: ["principles"] },
  } },
  async run(args, ctx) {
    const run = getRun(ctx.runId);
    if (!run) return "Error: no run in context.";
    const list = Array.isArray(args.principles) ? args.principles.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
    if (!list.length) return "Error: provide one or more principles (short, general, imperative rules).";
    const all = recordPrinciples(run.machine_id, list.map(t => ({ text: t, source: "feedback" as const })));
    return `Recorded ${list.length} principle(s) onto this loop. It now carries ${all.length} principle(s); they'll be injected into future runs.`;
  },
});

// North Star's tool: report where the run stands against its acceptance criteria. The human
// authors the criteria; the AGENT keeps their STATUS honest and current (no deterministic
// pass/fail anywhere — the model decides, this just records it).
register({
  label: "Assess North Star criteria",
  schema: { type: "function", function: {
    name: "north_star",
    description: "Report where this run stands against its NORTH STAR acceptance criteria (the run's definition of done, listed in the phase prompt). Mark each criterion met or leave it pending, with a one-line reason. Match a criterion by its exact text OR its 1-based number. Call it as you work and especially at review/QA/acceptance so the human sees real, current status. Never claim the goal is done while any criterion is still pending.",
    parameters: { type: "object", properties: {
      criteria: { type: "array", description: "One or more { criterion, status, note } assessments.", items: { type: "object", properties: {
        criterion: { type: "string", description: "The criterion's exact text, or its 1-based number." },
        status: { type: "string", enum: ["met", "pending"], description: "met | pending" },
        note: { type: "string", description: "One short line of evidence/reason for this status." },
      }, required: ["criterion", "status"] } },
    }, required: ["criteria"] },
  } },
  async run(args, ctx) {
    const run = getRun(ctx.runId);
    if (!run) return "Error: no run in context.";
    if (!getCriteria(run).length) return "This run has no North Star acceptance criteria yet — nothing to assess. (The human adds them in the run's North Star panel.)";
    const updates = Array.isArray(args.criteria)
      ? (args.criteria as unknown[]).map((u) => { const o = (u ?? {}) as Record<string, unknown>; return { criterion: String(o.criterion ?? ""), status: String(o.status ?? ""), note: o.note ? String(o.note) : undefined }; }).filter(u => u.criterion && u.status)
      : [];
    if (!updates.length) return "Error: provide a non-empty criteria array of { criterion, status, note }.";
    const after = setCriteriaStatus(ctx.runId, updates);
    const met = after.filter(c => c.status === "met").length;
    const summary = after.map((c, i) => `${i + 1}. [${c.status}] ${c.text}`).join("\n");
    ctx.log(`✦ North Star — ${met}/${after.length} met:\n${summary}`);
    return `North Star updated — ${met}/${after.length} criteria met:\n${summary}`;
  },
});

register({
  label: "Record a walkthrough video",
  schema: { type: "function", function: {
    name: "record_walkthrough",
    description: "Open a page in a real headless browser, drive it through a scripted sequence of interactions, and record an MP4 walkthrough video. Use in QA to produce visual PROOF the built feature actually works — the video must SHOW the feature, not just the landing page. Make it long enough to actually DEMONSTRATE the feature: for anything animated (a walk cycle, a transition, a spinner→result) add `wait` steps so the motion plays for several seconds and is clearly visible — a 1–2s clip that flashes by is not acceptable proof; aim for the recording to run long enough (≈8s+) to read what happened. Target a workspace HTML file (path) OR a running dev-server URL (url). Steps run in order. CRITICAL for async features (e.g. a generation that takes seconds): after you TRIGGER it, add a 'waitFor' step on the element that proves success (the result's <canvas>, a result card, etc.) so the recording captures the RESULT rather than ending on a spinner/empty page. By default the video goes to Deliverables; set present:false for a throwaway exploration probe.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative .html file (use this OR url)" },
      url: { type: "string", description: "Running page URL to record (use this OR path)" },
      name: { type: "string", description: "Title for the video, e.g. 'QA walkthrough'" },
      present: { type: "boolean", description: "true (default) = add to Deliverables as the QA video; false = throwaway probe, activity log only (use for exploration so you don't clutter Deliverables with probes)" },
      steps: { type: "array", description: "Ordered interactions. Each: { do: 'click'|'hover'|'drag'|'scroll'|'wait'|'waitFor'|'type'|'key', selector?, x?, y?, dx?, dy?, text?, ms?, caption? }. Use CSS selectors when possible. 'waitFor' BLOCKS until selector is visible (ms = timeout, default 60s) — use it right after triggering an async action so the video captures the result. 'drag' from a selector by (dx,dy) rotates a 3D view. 'wait' holds ms (up to 20s).",
        items: { type: "object", properties: {
          do: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" },
          dx: { type: "number" }, dy: { type: "number" }, text: { type: "string" }, ms: { type: "number" }, caption: { type: "string" },
        }, required: ["do"] } },
    }, required: ["steps"] },
  } },
  async run(args, ctx) {
    const target = args.url ? String(args.url) : resolvePath(ctx.workspace, String(args.path || ""));
    if (!args.url && !args.path) return "Error: provide either path or url.";
    const rel = join(".captures", `walkthrough-${Date.now()}.mp4`);
    const out = join(ctx.workspace, rel);
    const steps = (Array.isArray(args.steps) ? args.steps : []) as CaptureStep[];
    const present = args.present !== false;
    ctx.log(`recording ${present ? "" : "scratch "}walkthrough of ${args.url || args.path} (${steps.length} steps)…`);
    try {
      await recordWalkthrough(target, steps, out);
      // The encode must have produced a real, non-empty MP4 on disk — otherwise we'd
      // present a 0:00 / un-loadable video. Verify before emitting.
      let sz = 0; try { sz = (await fs.stat(out)).size; } catch { /* missing */ }
      if (sz === 0) return `Error: the walkthrough encoded to no file (or an empty one) at ${rel}. The page likely didn't render, no frames were captured, or the write didn't persist. Probe the target with screenshot_page first, then retry record_walkthrough.`;
      if (present) { ctx.emitArtifact({ name: String(args.name || "Walkthrough"), kind: "video", body: rel }); return `Recorded the walkthrough of ${args.url || args.path} (${Math.round(sz / 1024)} KB) and added it to Deliverables as the QA video.`; }
      ctx.emitScreenshot(`${args.name || "probe"} (scratch video)`, rel);
      return `Recorded a SCRATCH walkthrough at ${rel} (activity log only, NOT a deliverable). analyze_image a frame to judge it.`;
    } catch (e) { return `Error recording walkthrough: ${e instanceof Error ? e.message : String(e)}. The file may not render or a selector was wrong — check with screenshot_page first.`; }
  },
});

// ----------------------------------------------------------------------------
// Control tools — ALWAYS available; they END the agent loop. Handled in agent.ts.
// ----------------------------------------------------------------------------
register({
  label: "Request approval (gate)",
  control: true,
  schema: { type: "function", function: {
    name: "request_approval",
    description: "Call this when you have finished this state's work and displayed your deliverable. It pauses the loop and asks the human to approve before advancing to the next state. Provide a concise summary of what you did and what they're approving.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "What you accomplished and what the human is approving" } }, required: ["summary"] },
  } },
  async run() { return ""; }, // handled by the loop
});

register({
  label: "Complete (no gate)",
  control: true,
  schema: { type: "function", function: {
    name: "complete",
    description: "Finish this phase WITHOUT a human approval gate and advance automatically. Only use when the phase explicitly says it does not need approval; otherwise prefer request_approval.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  } },
  async run() { return ""; },
});

register({
  label: "Reject → loop back",
  control: true,
  schema: { type: "function", function: {
    name: "reject",
    description: "Use in a REVIEW/QA/security/acceptance phase when the work FAILS to meet the bar. This sends the ticket BACK to an earlier phase (e.g. Build) to fix the problems, then it will come forward through the checks again. Give specific, actionable reasons — they become the instructions for the fix. Only reject for real defects, not nitpicks.",
    parameters: { type: "object", properties: {
      reasons: { type: "string", description: "Concrete defects that must be fixed before this can pass" },
    }, required: ["reasons"] },
  } },
  async run() { return ""; },
});

// ----------------------------------------------------------------------------
export function getTool(name: string): ToolDef | undefined { return REGISTRY[name]; }
export function controlToolNames(): string[] { return Object.values(REGISTRY).filter(t => t.control).map(t => t.schema.function!.name!); }
/** Tools a state can attach (everything except the always-on control tools). */
export function attachableTools(): { name: string; label: string; description: string }[] {
  return Object.values(REGISTRY).filter(t => !t.control).map(t => ({
    name: t.schema.function!.name!, label: t.label, description: String(t.schema.function!.description || ""),
  }));
}
/** Resolve the schemas to hand the model for a state: attached tools + all control tools. */
export function schemasFor(toolNames: string[]): Tool[] {
  const names = new Set<string>([...toolNames, ...controlToolNames()]);
  return [...names].map(n => REGISTRY[n]?.schema).filter(Boolean) as Tool[];
}
