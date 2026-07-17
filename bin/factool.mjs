#!/usr/bin/env node
/**
 * factool — the factory tool bridge for the Claude-driven agent.
 *
 * The single agent (when its primary is Claude) calls this via its Bash tool to
 * use the SAME factory tools as the Ollama path: show deliverables, screenshot,
 * record a walkthrough, ask the vision helper, and end a phase. It just POSTs to
 * the factory's internal route, which runs the real tool in-process.
 *
 * Usage (env FACTORY_BASE_URL / FACTORY_RUN_ID / FACTORY_STATE / FACTORY_SECRET are
 * injected by the runner):
 *   node factool.mjs display  --name "Spec" --kind markdown (--file spec.md | --text "...")
 *   node factool.mjs return_file --path output/song.mp3 [--label "Song — MP3"] [--description "3:12, 320kbps"] [--filename song.mp3]
 *   node factool.mjs dev_server [--command "npm run dev"] [--port 3121] [--readyPath /] [--timeoutSec 150]
 *   node factool.mjs authenticate --loginUrl http://127.0.0.1:3121/auth/login --email free@test.local --password testpass123 [--authedRoute http://127.0.0.1:3121/dashboard]
 *   node factool.mjs screenshot --name "Render" (--path src/index.html | --url http://localhost:3100)
 *   node factool.mjs record   --name "QA walkthrough" --url http://localhost:3100 --steps '[...]'
 *   node factool.mjs analyze  --path .captures/shot.png --question "..."
 *   node factool.mjs watch    [--pr 123] [--timeoutSec 300] [--intervalSec 30]
 *   node factool.mjs approval --summary "..."
 *   node factool.mjs reject   --reasons "..."
 *   node factool.mjs complete --summary "..."
 */
import { readFileSync } from "fs";

const [, , cmd, ...rest] = process.argv;
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { const k = rest[i].slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true"; flags[k] = v; }
}

const ACTIONS = {
  display: "display_artifact",
  return_file: "return_file",
  expose_output: "expose_output",
  dev_server: "start_dev_server",
  authenticate: "authenticate",
  screenshot: "screenshot_page",
  record: "record_walkthrough",
  test_drive: "test_drive",
  north_star: "north_star",
  watch: "watch_pr",
  analyze: "analyze_image",
  approval: "request_approval",
  reject: "reject",
  complete: "complete",
};
const action = ACTIONS[cmd];
if (!action) { console.error(`factool: unknown command "${cmd}". One of: ${Object.keys(ACTIONS).join(", ")}`); process.exit(2); }

const args = {};
if (cmd === "display") {
  args.name = flags.name || "Artifact";
  args.kind = flags.kind || "markdown";
  // Pass the file PATH to the server, which reads/routes it — so an image stays an
  // image instead of being inlined here as garbled UTF-8 text.
  if (flags.file) args.file = flags.file;
  else args.body = flags.text || "";
} else if (cmd === "return_file") {
  args.path = flags.path;
  if (flags.label) args.label = flags.label;
  if (flags.description) args.description = flags.description;
  if (flags.filename) args.filename = flags.filename;
  if (!args.path) { console.error("factool return_file: --path <workspace-relative file> is required"); process.exit(2); }
} else if (cmd === "expose_output") {
  // The DEFINITIVE final output set. Pass a JSON array of files, or a single --path.
  if (flags.files) { try { args.files = JSON.parse(flags.files); } catch { console.error("factool expose_output: --files must be valid JSON — an array of {path,label?,description?,filename?}"); process.exit(2); } }
  else if (flags.path) { args.files = [{ path: flags.path, ...(flags.label ? { label: flags.label } : {}), ...(flags.description ? { description: flags.description } : {}), ...(flags.filename ? { filename: flags.filename } : {}) }]; }
  if (!Array.isArray(args.files) || !args.files.length) { console.error("factool expose_output: needs --files '<json array>' or --path <file>"); process.exit(2); }
} else if (cmd === "dev_server") {
  if (flags.command) args.command = flags.command;
  if (flags.port) args.port = Number(flags.port);
  if (flags.readyPath) args.readyPath = flags.readyPath;
  if (flags.timeoutSec) args.timeoutSec = Number(flags.timeoutSec);
} else if (cmd === "authenticate") {
  args.loginUrl = flags.loginUrl || flags.url;
  args.email = flags.email; args.password = flags.password;
  if (flags.authedRoute) args.authedRoute = flags.authedRoute;
  if (flags.emailSelector) args.emailSelector = flags.emailSelector;
  if (flags.passwordSelector) args.passwordSelector = flags.passwordSelector;
  if (flags.submitSelector) args.submitSelector = flags.submitSelector;
  if (!args.loginUrl || !args.email || !args.password) { console.error("factool authenticate: --loginUrl --email --password are required"); process.exit(2); }
} else if (cmd === "screenshot") {
  args.name = flags.name || "Screenshot";
  if (flags.path) args.path = flags.path;
  if (flags.url) args.url = flags.url;
  if (flags.width) args.width = Number(flags.width);
  if (flags.height) args.height = Number(flags.height);
} else if (cmd === "record") {
  args.name = flags.name || "Walkthrough";
  if (flags.path) args.path = flags.path;
  if (flags.url) args.url = flags.url;
  if (flags.present !== undefined) args.present = flags.present !== "false";
  try { args.steps = JSON.parse(flags.steps || "[]"); } catch { console.error("factool: --steps must be valid JSON"); process.exit(2); }
} else if (cmd === "north_star") {
  // Report criterion status. Pass a JSON array of { criterion, status, note? }.
  if (flags.criteria) { try { args.criteria = JSON.parse(flags.criteria); } catch { console.error("factool north_star: --criteria must be valid JSON — an array of {criterion,status,note?}"); process.exit(2); } }
  if (!Array.isArray(args.criteria) || !args.criteria.length) { console.error("factool north_star: needs --criteria '<json array of {criterion,status,note?}>'"); process.exit(2); }
} else if (cmd === "watch") {
  if (flags.pr) args.pr = flags.pr;
  if (flags.timeoutSec) args.timeoutSec = Number(flags.timeoutSec);
  if (flags.intervalSec) args.intervalSec = Number(flags.intervalSec);
} else if (cmd === "analyze") {
  args.path = flags.path; args.question = flags.question || "Describe this and flag any problems.";
} else if (cmd === "approval" || cmd === "complete") {
  args.summary = flags.summary || "";
} else if (cmd === "reject") {
  args.reasons = flags.reasons || flags.summary || "";
}

const base = process.env.FACTORY_BASE_URL || "http://localhost:7777";
try {
  const r = await fetch(`${base}/api/internal/tool`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: process.env.FACTORY_SECRET, runId: process.env.FACTORY_RUN_ID, state: process.env.FACTORY_STATE, action, args }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`factool: ${d.error || r.status}`); process.exit(1); }
  console.log(typeof d.result === "string" ? d.result : JSON.stringify(d.result ?? d));
} catch (e) {
  console.error(`factool: could not reach factory at ${base}: ${e.message}`);
  process.exit(1);
}
