/**
 * Headless-Chrome capture for the visual states (mock / qa). Renders a
 * self-contained HTML file from the workspace, optionally drives it through a
 * scripted walkthrough, and produces a PNG screenshot or an MP4 video (via
 * ffmpeg). This is a real TOOL capability — see tools.ts. No state logic here.
 */
import puppeteer from "puppeteer-core";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { exec } from "child_process";
import { applyAuthState } from "./auth";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--hide-scrollbars",
];

async function launch() {
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: LAUNCH_ARGS });
}

// A capture target is either an http(s) URL (a running dev server) or an absolute
// file path (a self-contained .html). Resolve to a navigable URL.
function toUrl(target: string) { return /^https?:\/\//.test(target) ? target : "file://" + target; }
function fileUrl(abs: string) { return toUrl(abs); }

export interface CaptureStep {
  do: "click" | "hover" | "drag" | "scroll" | "wait" | "waitFor" | "type" | "key";
  selector?: string;
  x?: number; y?: number;       // explicit coordinates (fallback when no selector)
  dx?: number; dy?: number;     // drag/scroll delta
  text?: string;                // for type / key
  ms?: number;                  // wait duration (wait) or timeout (waitFor)
  caption?: string;
}

const sh = (cmd: string) => new Promise<string>((res, rej) =>
  exec(cmd, { maxBuffer: 1 << 24, timeout: 120000 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));

/** Flush a file's bytes to disk. External/removable volumes can lose un-fsync'd
 *  writes on a remount, which silently leaves dangling capture artifacts. */
async function fsyncFile(p: string) {
  const fh = await fs.open(p, "r").catch(() => null);
  if (!fh) return;
  try { await fh.sync(); } catch { /* best effort */ } finally { await fh.close(); }
}

/** Stat a file and throw if it's missing or empty — a produced capture must be real. */
async function assertNonEmpty(p: string, what: string) {
  const st = await fs.stat(p).catch(() => null);
  if (!st || st.size === 0) throw new Error(`${what} produced no file (or an empty one) at ${p}`);
}

/** Single screenshot of an HTML file. Returns the output path. */
export async function screenshot(absHtml: string, outAbs: string, opts: { width?: number; height?: number } = {}) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    // Capture at 2x density (retina) — the product renders crisp at HiDPI, so a 1x grab
    // makes text look soft/blurry, especially once compressed. 2x keeps UI text legible.
    await page.setViewport({ width: opts.width ?? 1280, height: opts.height ?? 800, deviceScaleFactor: 2 });
    await applyAuthState(page, dirname(dirname(outAbs))).catch(() => {}); // authed if a session was saved
    await page.goto(fileUrl(absHtml), { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    await fs.mkdir(dirname(outAbs), { recursive: true });
    await page.screenshot({ path: outAbs as `${string}.png`, type: "png" });
    await assertNonEmpty(outAbs, "screenshot");
    await fsyncFile(outAbs);
    return outAbs;
  } finally { await browser.close(); }
}

async function resolveTarget(page: any, step: CaptureStep): Promise<{ x: number; y: number } | null> {
  if (step.selector) {
    const el = await page.$(step.selector).catch(() => null);
    if (el) { const b = await el.boundingBox(); if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
  }
  if (typeof step.x === "number" && typeof step.y === "number") return { x: step.x, y: step.y };
  return null;
}

/**
 * Record a walkthrough: open the file, sample frames at a fixed interval while
 * running the scripted steps, then encode an MP4 with ffmpeg. Returns the mp4 path.
 */
export async function recordWalkthrough(
  absHtml: string,
  steps: CaptureStep[],
  outMp4: string,
  opts: { width?: number; height?: number; fps?: number } = {},
): Promise<string> {
  const width = opts.width ?? 1280, height = opts.height ?? 800, fps = opts.fps ?? 10;
  const browser = await launch();
  const frameDir = join(dirname(outMp4), "_frames_" + Date.now());
  await fs.mkdir(frameDir, { recursive: true });
  try {
    const page = await browser.newPage();
    // 2x (retina) capture — a 1x grab of the product's HiDPI UI looks soft, and text
    // blurs further under h264. Sampling at 2x makes every frame (and the encode) crisp.
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await applyAuthState(page, dirname(dirname(outMp4))).catch(() => {}); // authed if a session was saved
    await page.goto(fileUrl(absHtml), { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // Fixed-interval frame sampler running in the background.
    let frame = 0, sampling = true;
    const recStart = Date.now();
    const intervalMs = Math.round(1000 / fps);
    const sampler = (async () => {
      while (sampling) {
        const t0 = Date.now();
        try { await page.screenshot({ path: join(frameDir, `f-${String(frame).padStart(4, "0")}.png`) as `${string}.png` }); frame++; } catch {}
        const dt = Date.now() - t0;
        if (dt < intervalMs) await new Promise(r => setTimeout(r, intervalMs - dt));
      }
    })();

    const hold = (ms: number) => new Promise(r => setTimeout(r, ms));
    await hold(700); // let the opening frames breathe
    for (const step of steps.slice(0, 40)) {
      try {
        if (step.do === "wait") { await hold(Math.min(step.ms ?? 600, 20000)); continue; }
        // waitFor: block until a selector appears (e.g. the 3D <canvas> after a
        // generation finishes) so the recording actually CAPTURES the result
        // instead of ending on a still-loading/empty page. The frame sampler keeps
        // running, so the wait is visible in the video.
        if (step.do === "waitFor") { if (step.selector) await page.waitForSelector(step.selector, { visible: true, timeout: Math.min(step.ms ?? 60000, 180000) }).catch(() => {}); continue; }
        const pt = await resolveTarget(page, step);
        if (step.do === "click" && pt) { await page.mouse.click(pt.x, pt.y); }
        else if (step.do === "hover" && pt) { await page.mouse.move(pt.x, pt.y); }
        else if (step.do === "type" && step.text) { if (step.selector) await page.click(step.selector).catch(() => {}); await page.keyboard.type(step.text, { delay: 30 }); }
        else if (step.do === "key" && step.text) { await page.keyboard.press(step.text as any); }
        else if (step.do === "scroll") { await page.mouse.wheel({ deltaY: step.dy ?? 300 }); }
        else if (step.do === "drag" && pt) {
          // Drag from the point by (dx,dy) in several increments — good for orbit/rotate.
          await page.mouse.move(pt.x, pt.y); await page.mouse.down();
          const dx = step.dx ?? 220, dy = step.dy ?? 0, N = 24;
          for (let i = 1; i <= N; i++) { await page.mouse.move(pt.x + (dx * i) / N, pt.y + (dy * i) / N); await hold(18); }
          await page.mouse.up();
        }
        await hold(step.ms ?? 450);
      } catch { /* a flaky step must not kill the recording */ }
    }
    await hold(700);
    // Quality backstop: a smoke walkthrough must run long enough to actually SHOW the
    // feature working (e.g. a walk animation cycling a few times), not flash by. If the
    // scripted steps were brief, keep sampling the final state up to a useful minimum.
    const MIN_MS = 8000;
    { const e = Date.now() - recStart; if (e < MIN_MS) await hold(MIN_MS - e); }

    sampling = false; await sampler;
    if (frame < 2) throw new Error("no frames captured");

    // Encode at the REAL captured rate, not a fixed fps: screenshots are slower than
    // `fps`, so encoding at `fps` fast-forwards the clip into a too-short 1–2s blur.
    // Matching the wall-clock rate makes the video play at true speed and full length.
    const realFps = Math.max(5, Math.min(fps, frame / ((Date.now() - recStart) / 1000)));
    // Encode for screen text, not a fixed low bitrate: -crf 18 (near visually-lossless) with
    // libx264's default rate control keeps UI text sharp — static screen content still
    // compresses small, so this stays a reasonable size without the default CRF-23 mush.
    await sh(`ffmpeg -y -framerate ${realFps.toFixed(3)} -i ${JSON.stringify(join(frameDir, "f-%04d.png"))} -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -r 24 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart ${JSON.stringify(outMp4)}`);
    // ffmpeg can exit 0 yet leave no usable file (and removable volumes can drop the
    // write) — verify it's real, then flush it to disk so it survives a remount.
    await assertNonEmpty(outMp4, "ffmpeg encode");
    await fsyncFile(outMp4);
    return outMp4;
  } finally {
    await browser.close();
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}
