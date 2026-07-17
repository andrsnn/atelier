#!/usr/bin/env node
/**
 * atelier — the full-screen terminal interface for the factory.
 *
 * A pure client of the same HTTP API the web UI uses: leave it up on a
 * monitor to watch every loop in flight, open a run's cockpit, approve /
 * revise / route phases, edit loops, and start new runs.
 *
 *   node cli/atelier.mjs                     # board, http://localhost:7777
 *   node cli/atelier.mjs --url http://host:7777 --user maria
 *   node cli/atelier.mjs --run <id>          # open one run's cockpit
 *
 * Env: ATELIER_URL, ATELIER_USER, ATELIER_PASSWORD (for ACCESS_PASSWORD-gated
 * instances). Prefs persist in ~/.config/atelier/cli.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { Term } from "./lib/term.mjs";
import { Api } from "./lib/api.mjs";
import { App } from "./lib/app.mjs";
import { BoardView } from "./views/board.mjs";
import { RunView } from "./views/run.mjs";

const CONFIG_DIR = join(homedir(), ".config", "atelier");
const CONFIG_FILE = join(CONFIG_DIR, "cli.json");

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  } catch { /* prefs are best-effort */ }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--user" || a === "--name") args.user = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--run") args.run = argv[++i];
    else args._.push(a);
  }
  return args;
}

const HELP = `atelier — terminal interface for the factory

usage
  atelier [--url http://localhost:7777] [--user <name>] [--run <run id>]

options
  --url <url>        factory base URL   (env ATELIER_URL, saved to config)
  --user <name>      your display name — presence + comment authorship
                     (env ATELIER_USER, saved to config)
  --password <pw>    access password for gated instances (env ATELIER_PASSWORD)
  --run <id>         open straight into one run's cockpit
  -h, --help         this text

keys are discoverable in-app: press ? on any screen.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("atelier is a full-screen TUI and needs a terminal (TTY).\n");
    process.exit(1);
  }

  const cfg = loadConfig();
  const baseUrl = args.url || process.env.ATELIER_URL || cfg.url || "http://localhost:7777";
  const user = args.user || process.env.ATELIER_USER || cfg.user || userInfo().username || "cli";
  const password = args.password || process.env.ATELIER_PASSWORD || "";
  saveConfig({ ...cfg, url: baseUrl, user });

  const api = new Api({ baseUrl, user, password });

  // Fail fast with a readable message before taking over the screen.
  try {
    await api.runs();
  } catch (e) {
    process.stderr.write(`atelier: ${e.message}\n`);
    if (e.status === 401) process.stderr.write("this instance is password-gated — pass --password or set ATELIER_PASSWORD\n");
    else process.stderr.write(`start the factory first: npm run dev  (then atelier --url ${baseUrl})\n`);
    process.exit(1);
  }

  const term = new Term();
  const app = new App({ term, api, cfg });

  const bail = (err) => {
    term.stop();
    if (err) console.error(err);
    process.exit(err ? 1 : 0);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
  process.on("SIGTERM", () => bail());
  process.on("SIGINT", () => bail());

  app.start(new BoardView());
  if (args.run) app.push(new RunView(args.run));
}

main();
