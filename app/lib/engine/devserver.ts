/**
 * Boot a project's dev server inside the run workspace and WAIT until it actually
 * serves — then hand back the URL so QA can drive/record the real app. This is the
 * capability the old factory had for its observe/QA stages (the agent kept giving
 * up before Next finished its slow first compile). One server per run; tracked so
 * it's torn down when the phase ends.
 */
import { spawn, exec } from "child_process";
import { dirname, join } from "path";
import { existsSync, readdirSync, mkdirSync, openSync } from "fs";
import { homedir } from "os";
import { isInsideFactory, FACTORY_ROOT } from "../sandbox";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Make sure the spawned dev server can find node + npm regardless of how the
// factory was launched. The running node's own bin may lack npm (e.g. an nvm
// version whose npm was removed), so pick the first node bin that actually HAS
// npm, then homebrew, then the inherited PATH.
function devPath(): string {
  const cands = [dirname(process.execPath)];
  try {
    const nvm = join(homedir(), ".nvm/versions/node");
    for (const v of readdirSync(nvm)) cands.push(join(nvm, v, "bin"));
  } catch { /* no nvm */ }
  const withNpm = cands.find(b => existsSync(join(b, "npm"))) || dirname(process.execPath);
  return [withNpm, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].filter(Boolean).join(":");
}
const running = new Map<string, { pid: number; port: number }>(); // runId -> dev server

function pickPort(runId: string): number {
  let h = 0; for (const c of runId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 3120 + (h % 60); // 3120–3179, stable per run
}

export interface DevServerResult { url: string; port: number; ok: boolean; status: number; note: string }

export async function startDevServer(opts: {
  workspace: string; runId: string; command?: string; port?: number;
  readyPath?: string; timeoutMs?: number; env?: Record<string, string>;
  log?: (s: string) => void;
}): Promise<DevServerResult> {
  const log = opts.log || (() => {});
  // HARD GUARD: never boot a dev server inside the factory's own install tree. A dev
  // server watching the factory dir (or a workspace nested under it) recursively HMR-reloads
  // and OOMs the box. Workspaces belong OUTSIDE the factory (set FACTORY_WORKSPACES_DIR).
  if (isInsideFactory(opts.workspace)) {
    const note = `Refused to boot a dev server: the workspace (${opts.workspace}) is inside the Atelier factory directory (${FACTORY_ROOT}). Building or serving in the factory tree causes recursive dev-server reloads and OOMs the machine. This run must operate in a folder OUTSIDE the factory install — set FACTORY_WORKSPACES_DIR to an external path, or point the run at an external repo.`;
    log(note);
    return { url: "", port: 0, ok: false, status: 0, note };
  }
  killDevServer(opts.runId); // never run two for the same ticket
  const port = opts.port || pickPort(opts.runId);
  const cmd = opts.command || "npm run dev";
  log(`booting dev server: PORT=${port} ${cmd}`);

  // bash -c (NOT login) so it inherits our PATH (node/npm) without a profile reset.
  // Log the dev server's output so failures are diagnosable (not swallowed).
  let outFd = "ignore" as number | "ignore";
  try { mkdirSync(join(opts.workspace, ".captures"), { recursive: true }); outFd = openSync(join(opts.workspace, ".captures", "devserver.log"), "w"); } catch {}
  // CRITICAL: strip the factory's own Next/Turbopack env so it doesn't leak into
  // the spawned dev server. With TURBOPACK leaked in, Next uses Turbopack, which
  // fatals on a node_modules symlink that points across filesystems (worktree on
  // an external drive → repo's node_modules on local disk). Clean env → Webpack →
  // it follows the symlink fine.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(__NEXT|NEXT_|TURBOPACK|TURBO_|VERCEL)/.test(k)) continue;
    cleanEnv[k] = v;
  }
  delete (cleanEnv as Record<string, unknown>).NODE_OPTIONS;
  const child = spawn("bash", ["-c", `exec ${cmd}`], {
    cwd: opts.workspace,
    env: { ...cleanEnv, ...opts.env, PATH: devPath(), NODE_ENV: "development", PORT: String(port) },
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });
  child.unref();
  if (child.pid) running.set(opts.runId, { pid: child.pid, port });

  // Use `localhost` (not the 127.0.0.1 IP): Next 16 dev only serves its /_next JS
  // bundles to trusted origins, and `localhost` is trusted by default while the raw
  // IP is blocked — navigating to 127.0.0.1 leaves the app SSR-only (no hydration,
  // dead interactions), which silently breaks QA captures. localhost resolves to
  // 127.0.0.1 anyway, so this also works for the readiness poll.
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 150000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + (opts.readyPath || "/"), { signal: AbortSignal.timeout(8000) });
      // Any HTTP response means it's listening + serving (even a 500 is "up").
      return { url, port, ok: true, status: r.status, note: `Dev server is up at ${url} (GET ${opts.readyPath || "/"} -> ${r.status}). Use this exact host (localhost) for screenshots/records so the app HYDRATES — navigating via the 127.0.0.1 IP leaves a Next dev app SSR-only and non-interactive. It keeps running for this phase. Probe specific routes before recording; a 5xx on a route is a runtime-error finding you should reject on.` };
    } catch { await sleep(2000); }
  }
  return { url, port, ok: false, status: 0, note: `Dev server did not answer on ${url} within the timeout. Check the command/env, or fall back to recording the mock.` };
}

export function killDevServer(runId: string): void {
  const d = running.get(runId);
  if (!d) return;
  try { process.kill(-d.pid, "SIGKILL"); } catch {}  // kill the process group
  try { process.kill(d.pid, "SIGKILL"); } catch {}
  running.delete(runId);
}

/** Kill every TRACKED dev server (in-memory map). Returns how many. */
export function reapTrackedDevServers(): number {
  let n = 0;
  for (const runId of [...running.keys()]) { killDevServer(runId); n++; }
  return n;
}

/** Scan the OS for ORPHANED factory dev servers that survived a restart (the in-memory
 *  map is lost on restart but the processes live on) and kill them. Strictly scoped:
 *  only `next dev` / `npm run dev` running UNDER a factory workspace — never the factory's
 *  own `next start` server (it runs in the app dir, not a workspace) or unrelated apps. */
export function reapOrphanDevServers(): Promise<number> {
  return new Promise(resolve => {
    exec("ps -eo pid=,command=", (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const mine = process.pid;
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]), cmd = m[2];
        if (!pid || pid === mine) continue;
        if (/(factory[-/]workspaces|\.atelier[-/]workspaces|atelier[-/]workspaces)/.test(cmd) && /(next dev|next-server|npm run dev|\/\.bin\/next\b)/.test(cmd)) pids.add(pid);
      }
      for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
      resolve(pids.size);
    });
  });
}
