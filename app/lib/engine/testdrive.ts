/**
 * Test-drive — open the running app in a REAL (non-headless) Chrome, logged in,
 * on the feature, and leave it open for a human to click around. The run page's
 * "Test it" button calls prepareAndOpen(); a "Stop" tears it all down.
 *
 * LAN sharing: the dev server is bound to 0.0.0.0 (HOSTNAME), so another computer on
 * the network can open it directly at this machine's LAN IP — Next serves it a fully
 * hydrated, interactive app.
 */
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import puppeteer from "puppeteer-core";
import { applyAuthState, authenticateAndSave } from "./auth";
import { startDevServer, killDevServer } from "./devserver";
import { getRun } from "../db";
import { getProjectByRepoPath } from "../projects";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Per-run live browser, so a second test-drive (or Stop) cleans up the first.
const live = new Map<string, any>();

/** Can this host show a window at all? (a headless server can't — share the URL instead) */
function hasDisplay(): boolean {
  if (process.platform === "linux") return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

/** This machine's primary LAN IPv4 (for the shareable URL). */
function lanIP(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (ni.family === "IPv4" && !ni.internal && !ni.address.startsWith("169.254.")) return ni.address;
    }
  }
  return null;
}

/** The hostname teammates should use to reach dev servers on this machine.
 *  FACTORY_PUBLIC_HOST (a DNS/Tailscale name or IP) wins on a shared/cloud host,
 *  where the auto-detected interface IP is often private/unreachable. */
function shareHost(): string | null {
  return process.env.FACTORY_PUBLIC_HOST || lanIP();
}

/** Launch a visible Chrome on localhost (hydrates here), leave it open. */
export async function openLiveBrowser(runId: string, workspace: string, url: string): Promise<{ ok: boolean; message: string }> {
  if (!hasDisplay()) return { ok: false, message: "no display on this host — open the URL from your own machine instead" };
  try {
    const prev = live.get(runId);
    if (prev) { try { await prev.close(); } catch {} live.delete(runId); }
    const browser = await puppeteer.launch({
      executablePath: CHROME, headless: false, defaultViewport: null,
      args: ["--no-sandbox", "--window-size=1440,960", "--no-first-run", "--no-default-browser-check"],
    });
    live.set(runId, browser);
    browser.on("disconnected", () => live.delete(runId));
    const page = (await browser.pages())[0] || await browser.newPage();
    await applyAuthState(page, workspace);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    return { ok: true, message: `Opened ${url} in a live Chrome window.` };
  } catch (e) {
    return { ok: false, message: `Could not open the browser: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Tear down a test-drive: close the browser and the dev server. */
export async function stopTestDrive(runId: string): Promise<{ ok: boolean }> {
  const b = live.get(runId); if (b) { try { await b.close(); } catch {} live.delete(runId); }
  killDevServer(runId);
  return { ok: true };
}

/** Close every live test-drive browser (+ its dev server). Returns how many. */
export async function reapTestDrives(): Promise<number> {
  let n = 0;
  for (const runId of [...live.keys()]) { await stopTestDrive(runId); n++; }
  return n;
}

async function readEnvVar(repoPath: string, key: string): Promise<string | undefined> {
  for (const f of [".env.test", ".env.local", ".env"]) {
    try {
      const m = (await fs.readFile(join(repoPath, f), "utf8")).match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return undefined;
}

export interface TestDriveResult { ok: boolean; message: string; localUrl?: string; lanUrl?: string; route?: string }

/** The "Test it" button: boot the dev server, restore auth, open a local Chrome,
 *  and expose a LAN URL so another computer can navigate to it. */
export async function prepareAndOpen(runId: string, log: (s: string) => void = () => {}): Promise<TestDriveResult> {
  const run = getRun(runId);
  if (!run) return { ok: false, message: "run not found" };
  if (!run.repo_path) return { ok: false, message: "this loop has no repo to run" };
  const project = getProjectByRepoPath(run.repo_path);

  log("Booting the app…");
  // Bind to all interfaces (HOSTNAME=0.0.0.0) so the LAN IP is reachable from another computer.
  const srv = await startDevServer({ workspace: run.workspace, runId, command: project?.devCommand, log, env: { HOSTNAME: "0.0.0.0", HOST: "0.0.0.0" } });
  if (!srv.ok) return { ok: false, message: `dev server didn't come up: ${srv.note}` };

  // Restore the session captured during QA; if none, log in with the repo's fixtures.
  const authFile = join(run.workspace, ".captures", "auth-state.json");
  const haveAuth = await fs.access(authFile).then(() => true).catch(() => false);
  if (!haveAuth && project?.auth) {
    log("Logging in with the test fixtures…");
    const email = project.auth.email || (project.auth.emailEnv && await readEnvVar(run.repo_path, project.auth.emailEnv));
    const password = project.auth.password || (project.auth.passwordEnv && await readEnvVar(run.repo_path, project.auth.passwordEnv));
    if (email && password) {
      await authenticateAndSave({
        workspace: run.workspace, loginUrl: `${srv.url}${project.auth.loginPath}`, email, password,
        authedRoute: project.auth.authedRoutes?.[0] ? `${srv.url}${project.auth.authedRoutes[0]}` : undefined,
      });
    }
  }

  const route = project?.auth?.authedRoutes?.[0] || "/";
  const localUrl = `${srv.url}${route}`;   // http://localhost:<devPort><route>

  // Shareable URL: same dev server, reachable from another computer at this
  // machine's LAN IP (or FACTORY_PUBLIC_HOST on a shared/cloud host).
  const host = shareHost();
  const lanUrl = host ? `http://${host}:${srv.port}${route}` : undefined;

  // A visible Chrome only makes sense on a machine with a screen. On a headless
  // host the dev server IS the deliverable — hand back the URLs.
  if (!hasDisplay()) {
    return { ok: true, route, localUrl, lanUrl, message: `App is up. Open it from your machine${lanUrl ? `: ${lanUrl}` : ` (no shareable address found — set FACTORY_PUBLIC_HOST)`}.` };
  }

  log("Opening it in Chrome…");
  const opened = await openLiveBrowser(runId, run.workspace, localUrl);

  // The dev server being up is the substance; a failed local window shouldn't
  // read as a failed test-drive when the URLs still work.
  return {
    ok: true, route, localUrl, lanUrl,
    message: opened.ok
      ? `Live in Chrome. Open on this computer, or from another on your network${lanUrl ? "" : " (no LAN address found)"}.`
      : `App is up at ${lanUrl || localUrl}, but a local Chrome window couldn't be opened: ${opened.message}`,
  };
}
