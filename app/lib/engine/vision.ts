/**
 * The vision/QA helper — describes / judges an image for the agent.
 *
 * It runs through the SAME Claude Code harness as the agent and the conductor's
 * one-shots: `claude` for Claude-native models, `ollama launch claude --model <tag> -- …`
 * for Ollama models (the model backs the harness; auth is the ollama CLI's own login).
 * It does NOT make a direct in-process Ollama Cloud call (no `getClient()` / OLLAMA_API_KEY /
 * https://ollama.com) — that bypasses the harness and breaks with no cloud key set.
 * The harness model Reads the image file with its native Read tool and returns text.
 */
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { parseModel } from "./models";

/** One-shot "look at this image and answer" through the Claude Code harness. */
async function harnessDescribe(visionModel: string | null | undefined, imagePath: string, instruction: string): Promise<string> {
  const ref = parseModel(visionModel, "ollama:kimi-k2.6");
  const prompt = `${instruction}\n\nRead the image file at ${imagePath} with your Read tool, and base your answer ONLY on what you actually see in it.`;
  const claudeArgs = ["-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"];
  let command: string, args: string[];
  if (ref.provider === "ollama") {
    // ollama models back the harness via `ollama launch claude` (cloud tag for launch);
    // this uses the ollama CLI's own login, never the in-process client / OLLAMA_API_KEY.
    const tag = ref.model.includes(":cloud") ? ref.model : `${ref.model}:cloud`;
    command = "ollama"; args = ["launch", "claude", "--model", tag, "--", ...claudeArgs];
  } else {
    if (ref.model && ref.model !== "default") claudeArgs.push("--model", ref.model);
    command = "claude"; args = claudeArgs;
  }
  return await new Promise<string>((resolve) => {
    const cp = spawn(command, args, { cwd: dirname(imagePath), env: process.env });
    let out = "", err = "";
    cp.stdout?.on("data", (d: Buffer) => (out += d));
    cp.stderr?.on("data", (d: Buffer) => (err += d));
    cp.on("error", (e: Error) => resolve(`Error analyzing image: ${e.message}`));
    cp.on("close", (code: number | null) => resolve(out.trim() || (code === 0 ? "(no description)" : `Error analyzing image: ${(err.trim() || "exit " + code).slice(0, 200)}`)));
  });
}

export async function analyzeImage(opts: { imagePath: string; question: string; visionModel?: string | null }): Promise<string> {
  try { await fs.access(opts.imagePath); } catch { return `Error: could not read image at ${opts.imagePath}`; }
  return harnessDescribe(
    opts.visionModel,
    opts.imagePath,
    `You are a meticulous visual QA reviewer. ${opts.question}\n\nDescribe exactly what you see, call out anything broken/empty/misaligned/low-quality, and answer the question directly.`,
  );
}

// A faithful, EXHAUSTIVE description that transcribes all visible text verbatim, so a
// text-only agent can reason about (and build from) an image it can't see. General —
// works for a UI mock, a screenshot, a diagram, or a photo.
const DESCRIBE_PROMPT =
  "Describe this image thoroughly so a TEXT-ONLY model can reason about it and build from it. " +
  "First TRANSCRIBE ALL visible text VERBATIM — titles, labels, buttons, captions, code, numbers, fine print. " +
  "Then describe the visual content: overall layout/structure and reading order, the regions/sections, components/objects, people, and colors. " +
  "If it is a UI or mockup, list each screen, section, and control with its state (selected/disabled/active). " +
  "The exact text matters more than adjectives. Be exhaustive and faithful; never invent details that aren't there.";

/** Describe a reference image (a data URL) to text via the harness, for a text-only
 *  primary agent. Returns "" on failure (caller falls back gracefully). */
export async function describeImage(opts: { dataUrl: string; visionModel?: string | null }): Promise<string> {
  const m = (opts.dataUrl || "").match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return "";
  const path = join(tmpdir(), `vision-${process.pid}-${Date.now()}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
  try { await fs.writeFile(path, Buffer.from(m[2], "base64")); } catch { return ""; }
  try {
    const r = await harnessDescribe(opts.visionModel, path, DESCRIBE_PROMPT);
    return r.startsWith("Error") || r === "(no description)" ? "" : r;
  } finally { fs.unlink(path).catch(() => {}); }
}
