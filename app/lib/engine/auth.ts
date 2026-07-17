/**
 * Deterministic pre-auth for QA, modelled on the original factory. The agent
 * (not this code) decides WHEN to authenticate and supplies the creds it found in
 * the project's fixtures (.env.test, e2e setup, seed scripts) or the configured
 * auth recipe. This module just does the fiddly part reliably: drive the app's
 * real login form (handling the hydration race that silently no-ops a too-early
 * click), verify it actually logged in, and persist the session so the capture
 * tools (screenshot_page / record_walkthrough) start authenticated.
 */
import puppeteer from "puppeteer-core";
import { promises as fs } from "fs";
import { join } from "path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STATE_FILE = ".captures/auth-state.json";
const CREDS_FILE = ".captures/auth-creds.json"; // the test login the agent used — surfaced in "Test it" so the human can log in too

export interface AuthState { cookies: any[]; localStorage: { origin: string; items: Record<string, string> }[] }

export interface AuthenticateOpts {
  workspace: string;
  loginUrl: string;              // full URL, e.g. http://127.0.0.1:3121/auth/login
  email: string;
  password: string;
  emailSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  authedRoute?: string;          // full URL of a protected route to verify, e.g. .../dashboard
}

const EMAIL_SELECTORS = ['input#email', 'input[name=email]', 'input[type=email]', "input[autocomplete='email']", "input[autocomplete='username']"];
const PASS_SELECTORS = ['input#password', 'input[name=password]', 'input[type=password]', "input[autocomplete='current-password']"];
const SUBMIT_SELECTORS = ['button[type=submit]', 'button'];

async function fillFirst(page: any, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click({ clickCount: 3 }).catch(() => {}); await el.type(value, { delay: 25 }); return true; }
  }
  return false;
}

/** Pick the credentials-form submit button — explicitly AVOIDING social/OAuth
 *  buttons ("Continue with Google", etc.) that share the <form>. Prefer a
 *  type=submit whose label looks like sign-in; else the first non-social submit. */
async function findSubmit(page: any, override?: string): Promise<any> {
  if (override) return page.$(override);
  const btns = await page.$$("button");
  const meta = await Promise.all(btns.map(async (b: any) => ({
    b,
    type: await page.evaluate((e: any) => e.type, b).catch(() => ""),
    text: ((await page.evaluate((e: any) => e.textContent || "", b).catch(() => "")) as string).toLowerCase(),
  })));
  const social = /google|github|apple|facebook|sso|microsoft|continue with/;
  return (
    meta.find(m => m.type === "submit" && /sign in|log ?in|continue|submit/.test(m.text) && !social.test(m.text)) ||
    meta.find(m => m.type === "submit" && !social.test(m.text)) ||
    meta.find(m => !social.test(m.text))
  )?.b || null;
}

/** Read every cookie the browser holds (page.cookies() is URL-scoped and misses
 *  the chunked sb-*-auth-token cookie @supabase/ssr writes), via CDP. */
async function allCookies(page: any): Promise<any[]> {
  try {
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    return cookies || [];
  } catch { return (await page.cookies().catch(() => [])) as any[]; }
}

/** Log in and persist the session into the workspace. Returns a human-readable result. */
export async function authenticateAndSave(opts: AuthenticateOpts): Promise<{ ok: boolean; message: string }> {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const loginPath = new URL(opts.loginUrl).pathname;
    // networkidle2 (not domcontentloaded) so the framework actually HYDRATES — a
    // click before the onSubmit handler attaches does a native no-op form post and
    // silently fails to log in (the #1 cause of QA capturing the login page).
    await page.goto(opts.loginUrl, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
    await page.waitForSelector((opts.emailSelector ? [opts.emailSelector] : EMAIL_SELECTORS).join(", "), { visible: true, timeout: 20000 });
    await new Promise(r => setTimeout(r, 800));

    if (!await fillFirst(page, opts.emailSelector ? [opts.emailSelector] : EMAIL_SELECTORS, opts.email)) return { ok: false, message: `no email field at ${opts.loginUrl}` };
    if (!await fillFirst(page, opts.passwordSelector ? [opts.passwordSelector] : PASS_SELECTORS, opts.password)) return { ok: false, message: `no password field at ${opts.loginUrl}` };

    const submit = await findSubmit(page, opts.submitSelector);
    if (!submit) return { ok: false, message: `no submit button at ${opts.loginUrl}` };

    // Success signals: leaving the login path, OR a 2xx from an auth/token endpoint.
    const navAway = page.waitForFunction((lp: string) => !location.pathname.startsWith(lp), { timeout: 25000 }, loginPath).then(() => "nav").catch(() => null);
    const tokenOk = page.waitForResponse((r: any) => /auth|token|login|session|signin/i.test(r.url()) && r.status() >= 200 && r.status() < 300 && r.request().method() !== "GET", { timeout: 25000 }).then(() => "token").catch(() => null);
    await submit.click();
    const signal = await Promise.race([navAway, tokenOk]);
    await Promise.allSettled([navAway, tokenOk]);
    await new Promise(r => setTimeout(r, 2000)); // let the session persist to cookies/storage

    // Persist cookies (CDP — all of them) + localStorage so captures start authenticated.
    const cookies = await allCookies(page);
    let ls: Record<string, string> = {};
    try { ls = await page.evaluate(() => { const o: Record<string, string> = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; o[k] = localStorage.getItem(k)!; } return o; }); } catch {}

    // Verify against a protected route: it must render the app, NOT the login form.
    const probe = opts.authedRoute || new URL("/dashboard", opts.loginUrl).toString();
    await page.goto(probe, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    const onLoginPath = new URL(page.url()).pathname.startsWith(loginPath);
    const showsLoginForm = await page.$((opts.passwordSelector ? [opts.passwordSelector] : PASS_SELECTORS).join(", ")).then((e: any) => !!e).catch(() => false);
    const authedCookie = cookies.some(c => /auth-token|session|sb-/.test(c.name));
    if (!signal && !authedCookie) {
      return { ok: false, message: `login did not take at ${opts.loginUrl} — no nav/auth response and no session cookie (check creds / backend up?).` };
    }
    if (onLoginPath || showsLoginForm) {
      return { ok: false, message: `login failed — ${probe} still shows the login form (bounced to ${page.url()}). Check creds / that the backend is up + seeded.` };
    }

    const state: AuthState = { cookies, localStorage: [{ origin: new URL(probe).origin, items: ls }] };
    await fs.mkdir(join(opts.workspace, ".captures"), { recursive: true });
    await fs.writeFile(join(opts.workspace, STATE_FILE), JSON.stringify(state));
    await fs.writeFile(join(opts.workspace, CREDS_FILE), JSON.stringify({ email: opts.email, password: opts.password, loginUrl: opts.loginUrl }));
    return { ok: true, message: `Logged in as ${opts.email}; verified ${probe} renders the real app (no login form). Session saved (${cookies.length} cookie(s)) — screenshot_page / record_walkthrough now run authenticated.` };
  } catch (e) {
    return { ok: false, message: `authenticate error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await browser.close();
  }
}

/** Apply a saved session to a page before navigation (used by the capture tools). */
export async function applyAuthState(page: any, workspace: string): Promise<boolean> {
  let state: AuthState;
  try { state = JSON.parse(await fs.readFile(join(workspace, STATE_FILE), "utf-8")); } catch { return false; }
  // Restore cookies via CDP (it round-trips the full cookie shape from
  // getAllCookies — name/value/domain/path/expires/httpOnly/secure/sameSite —
  // which page.setCookie can choke on). Fall back to page.setCookie.
  if (state.cookies?.length) {
    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.setCookies", { cookies: state.cookies });
    } catch {
      try {
        const sane = state.cookies.map((c: any) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
          sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : undefined,
        }));
        await page.setCookie(...sane);
      } catch {}
    }
  }
  // localStorage must be set per-origin once the document for that origin loads.
  for (const o of state.localStorage || []) {
    try {
      await page.evaluateOnNewDocument((origin: string, items: Record<string, string>) => {
        if (location.origin === origin) { try { for (const k in items) localStorage.setItem(k, items[k]); } catch {} }
      }, o.origin, o.items);
    } catch {}
  }
  return true;
}
