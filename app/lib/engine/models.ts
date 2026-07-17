/**
 * Model selection. A model string is "<provider>:<model>" — e.g. "claude:opus",
 * "ollama:qwen3-coder:480b", "ollama:kimi-k2.6". A bare string with no known
 * provider prefix is treated as an Ollama model (back-compat).
 *
 * One PRIMARY model drives a whole ticket (single agent). A VISION model is a
 * multimodal helper the agent calls for visual/QA work when the primary can't
 * see images itself. Nothing here is repo-specific.
 */
export type Provider = "ollama" | "claude";
export interface ModelRef { provider: Provider; model: string }

export function parseModel(s: string | null | undefined, fallback = "ollama:qwen3-coder:480b"): ModelRef {
  const raw = (s || fallback).trim();
  if (raw.startsWith("claude:")) return { provider: "claude", model: raw.slice("claude:".length) || "default" };
  if (raw === "claude") return { provider: "claude", model: "default" };
  if (raw.startsWith("ollama:")) return { provider: "ollama", model: raw.slice("ollama:".length) };
  return { provider: "ollama", model: raw };
}

/**
 * The single source of truth for the model roster offered in the UI. Every model
 * dropdown — create-a-ticket, the run page (agent / vision / governor), and the
 * per-phase override on the machine editor — imports these lists. Do NOT hardcode
 * a copy anywhere; add a model HERE and it appears everywhere at once.
 *
 * Claude Opus/Sonnet and the Kimi models are multimodal (they can see images and
 * drive visual/QA work themselves); the Ollama coding models are text-only and
 * lean on the vision helper for anything visual.
 */
export const PRIMARY_MODELS: { value: string; label: string; multimodal: boolean }[] = [
  { value: "ollama:glm-5.2:cloud", label: "GLM 5.2 — coding/design (text-only)", multimodal: false },
  { value: "ollama:qwen3-coder:480b", label: "Qwen3-Coder 480B — coding (text-only)", multimodal: false },
  { value: "ollama:deepseek-v4-pro:cloud", label: "DeepSeek V4 Pro — coding, 1M ctx (text-only)", multimodal: false },
  { value: "ollama:kimi-k2.6", label: "Kimi K2.6 (multimodal)", multimodal: true },
  { value: "ollama:kimi-k2.7-code:cloud", label: "Kimi K2.7 Code — cloud (multimodal)", multimodal: true },
  { value: "claude:opus", label: "Claude Opus — solo, end-to-end (multimodal)", multimodal: true },
  { value: "claude:sonnet", label: "Claude Sonnet 5 (multimodal)", multimodal: true },
];

/** Multimodal models usable as the vision/QA helper. A vision helper MUST be able
 *  to see images — text-only primaries (GLM, Qwen, DeepSeek) never belong here. */
export const VISION_MODELS: { value: string; label: string }[] = [
  { value: "ollama:kimi-k2.6", label: "Kimi K2.6 (vision/QA helper)" },
  { value: "ollama:kimi-k2.7-code:cloud", label: "Kimi K2.7 Code — cloud (vision/QA helper)" },
  { value: "ollama:gemma3:27b", label: "Gemma 3 27B (vision)" },
  { value: "claude:sonnet", label: "Claude Sonnet 5 (vision)" },
  { value: "claude:opus", label: "Claude Opus (vision)" },
];

/** Phase-override option list: any primary model, plus "inherit the run's model". */
export const PHASE_MODEL_OPTS: { value: string; label: string }[] = [
  { value: "", label: "Inherit (run's model)" },
  ...PRIMARY_MODELS.map(m => ({ value: m.value, label: m.label })),
];

export function isMultimodalPrimary(model: string | null | undefined): boolean {
  return PRIMARY_MODELS.find(m => m.value === model)?.multimodal ?? false;
}
