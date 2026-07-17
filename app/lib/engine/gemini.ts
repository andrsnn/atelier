/**
 * Gemini image / VIDEO evaluation — a one-shot "look at this output and judge it" via
 * Google's Gemini API.
 *
 * ⚠️ DELIBERATE EXCEPTION to the repo rule that all model calls go through the Claude Code
 * harness (see CLAUDE.md). Gemini is NOT a harness-backed provider; this makes a direct API
 * call. It exists by explicit user request because Gemini reliably evaluates image AND VIDEO
 * outputs — which the harness vision helper (`analyze_image`, backed by claude/ollama) does
 * not do for video. Use it only through the `gemini_eval` tool as an evaluation capability,
 * never to DRIVE a phase's agentic loop.
 *
 * The API key is read from disk, never hardcoded: env (GEMINI_API_KEY / GOOGLE_AI_API_KEY),
 * then this project's ./.env.local.
 */
import { promises as fs, readFileSync } from "fs";
import { join } from "path";

const ENV_FILES = [join(process.cwd(), ".env.local")];

function findKey(): string | null {
  for (const k of ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"]) {
    if (process.env[k]) return process.env[k]!.trim();
  }
  for (const f of ENV_FILES) {
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^\s*(?:GEMINI_API_KEY|GOOGLE_AI_API_KEY)\s*=\s*(.+)/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* file absent */ }
  }
  return null;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
const MAX_INLINE = 18 * 1024 * 1024; // Gemini inline-data cap (~20MB request); guard below it

/** Send image/video file(s) + a question to Gemini and return its text judgment. */
export async function geminiEvaluate(opts: { paths: string[]; question: string; model?: string }): Promise<string> {
  const key = findKey();
  if (!key) return "Error: no Gemini API key found. Set GEMINI_API_KEY / GOOGLE_AI_API_KEY, or add it to ./.env.local.";
  const model = opts.model || "gemini-2.5-pro";

  const parts: unknown[] = [{ text: opts.question }];
  for (const p of opts.paths) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    const mime = MIME[ext];
    if (!mime) return `Error: unsupported file type ".${ext}" for ${p} — images: png/jpg/webp/gif; video: mp4/mov/webm.`;
    let data: Buffer;
    try { data = await fs.readFile(p); } catch { return `Error: could not read ${p}.`; }
    if (data.length > MAX_INLINE) return `Error: ${p} is ${(data.length / 1048576).toFixed(1)}MB — over Gemini's inline cap. Downsample/trim it first (e.g. a shorter/smaller clip).`;
    parts.push({ inline_data: { mime_type: mime, data: data.toString("base64") } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  // gemini-2.5-pro spends "thinking" tokens from this budget before the answer — keep it
  // generous so a long analysis (e.g. a beat-by-beat video breakdown) isn't truncated to empty.
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } });
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) return `Error: Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`;
    const j = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("").trim();
    return text || "(Gemini returned no text — the output may have been blocked or empty.)";
  } catch (e) {
    return `Error calling Gemini: ${e instanceof Error ? e.message : String(e)}`;
  }
}
