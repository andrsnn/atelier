/**
 * A one-shot text→text call through the Claude Code harness — the SAME auth path as the
 * agent (claude.ts), the conductor's one-shots, and the vision helper: `claude` for
 * Claude-native models, `ollama launch claude --model <tag> -- …` for Ollama models (the
 * model backs the harness; auth is the ollama CLI's own login). It does NOT make a direct
 * in-process Ollama call (no getClient() / OLLAMA_API_KEY) — that bypasses the harness.
 *
 * No tools, no workspace: pure text in, text out (e.g. "compact this session log into a
 * handoff brief"). On any failure it resolves to "" so callers can degrade gracefully.
 */
import { spawn } from "child_process";
import { parseModel } from "./models";
import { killTree } from "./proc";

export function harnessOneShot(modelStr: string | null | undefined, prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const ref = parseModel(modelStr);
  const claudeArgs = ["-p", prompt, "--output-format", "text"];
  let command: string, args: string[];
  if (ref.provider === "ollama") {
    const tag = ref.model.includes(":cloud") ? ref.model : `${ref.model}:cloud`;
    command = "ollama"; args = ["launch", "claude", "--model", tag, "--", ...claudeArgs];
  } else {
    if (ref.model && ref.model !== "default") claudeArgs.push("--model", ref.model);
    command = "claude"; args = claudeArgs;
  }
  return new Promise((resolve) => {
    let out = "", err = "";
    const cp = spawn(command, args, { env: process.env, detached: true });
    const onAbort = () => killTree(cp);
    opts.signal?.addEventListener("abort", onAbort);
    const done = (v: string) => { opts.signal?.removeEventListener("abort", onAbort); resolve(v); };
    cp.stdout.on("data", d => (out += d));
    cp.stderr.on("data", d => (err += d));
    cp.on("close", () => done(out.trim()));
    cp.on("error", () => done(""));
  });
}
