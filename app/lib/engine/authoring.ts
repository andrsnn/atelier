/**
 * AI loop authoring — generate a loop (state machine) from a plain-English description,
 * and edit an existing one from a chat instruction. Both are one-shot calls through the
 * Claude Code harness (harnessOneShot), so they use the same auth path as everything else.
 * A loop is just data (name + states[]); these return validated StateDef[] the UI renders
 * on the graph — no deterministic pipeline code.
 */
import { harnessOneShot } from "./oneshot";
import { attachableTools } from "./tools";
import type { StateDef } from "../db";

const MODEL = "claude:sonnet"; // Sonnet 5 (latest); resolved by the harness

const slug = (s: string): string =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "phase";

function toolCatalog(): string {
  return attachableTools().map((t) => `- ${t.name}: ${t.label}`).join("\n");
}

/** Pull the first JSON object/array out of a model reply (tolerates prose / code fences). */
function extractJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text.match(/[[{][\s\S]*[\]}]/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  return null;
}

/** Sanitize model-proposed states into valid StateDef[] (real ids, known tools, sane rejectTo). */
function sanitizeStates(raw: unknown): StateDef[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(attachableTools().map((t) => t.name));
  const used = new Set<string>();
  const states: StateDef[] = [];
  raw.forEach((s: Record<string, unknown>, i) => {
    if (!s || typeof s !== "object") return;
    let id = slug(String(s.id || s.name || `phase-${i + 1}`));
    while (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    const tools = (Array.isArray(s.tools) ? s.tools : []).map(String).filter((t) => valid.has(t));
    const st: StateDef = {
      id,
      name: String(s.name || id).slice(0, 40),
      prompt: String(s.prompt || "Do the work for this phase, display_artifact your result, then request_approval.").slice(0, 4000),
      tools: tools.length ? tools : ["read_file", "write_file", "display_artifact"],
    };
    if (s.gate === true) st.gate = true;
    if (s.rejectTo) st.rejectTo = slug(String(s.rejectTo));
    if (s.model && typeof s.model === "string") st.model = s.model;
    states.push(st);
  });
  const ids = new Set(states.map((s) => s.id));
  for (const s of states) if (s.rejectTo && !ids.has(s.rejectTo)) delete s.rejectTo;
  return states;
}

export interface DraftLoop { name: string; description: string; states: StateDef[] }

/** Draft a whole loop from a plain-English description. */
export async function generateLoop(description: string, model = MODEL): Promise<DraftLoop | { error: string }> {
  const prompt = `You design "loops" for Atelier — a state machine that moves a GOAL through ordered phases. Each phase is a PROMPT (what to accomplish) plus a set of TOOLS the AI may use. There is NO deterministic code — behaviour lives entirely in the prompt + the attached tools.

Design a loop for this request:
"""
${description}
"""

TOOLS you may attach to a phase (use ONLY these names):
${toolCatalog()}

Output ONLY a JSON object — no prose, no code fence — of this exact shape:
{
  "name": "<short, clickable loop name, 2-5 words>",
  "description": "<one plain sentence>",
  "states": [
    { "id": "<kebab-case>", "name": "<short phase name>",
      "prompt": "<concrete instructions for THIS phase, specific to the request; end by telling it to display_artifact its result and request_approval>",
      "tools": ["<names from the list above>"],
      "gate": true,            // include ONLY if this phase should pause for human approval when it finishes
      "rejectTo": "<id of an earlier phase>" }  // include ONLY on a review/eval phase, so the loop iterates
  ]
}

Rules:
- 3 to 6 phases. Make at least one a review/evaluate phase with a "rejectTo" pointing back to an earlier phase, so the loop can iterate until it's good.
- Every phase attaches display_artifact. Prompts must be SPECIFIC to this request, not generic boilerplate.
- Output the JSON object and nothing else.`;
  const raw = await harnessOneShot(model, prompt);
  if (!raw.trim()) return { error: "the model returned nothing — try again or rephrase." };
  const obj = extractJson(raw) as { name?: string; description?: string; states?: unknown } | null;
  const states = sanitizeStates(obj?.states);
  if (!states.length) return { error: "couldn't draft a valid loop from that — try naming the phases you want." };
  return { name: String(obj?.name || "New loop").slice(0, 60), description: String(obj?.description || ""), states };
}

export interface EditResult { reply: string; states: StateDef[] }

/** Apply a chat instruction to an existing loop's states. Returns a short reply + new states. */
export async function editLoop(current: { name: string; states: StateDef[] }, instruction: string, model = MODEL): Promise<EditResult | { error: string }> {
  const prompt = `You are editing an Atelier "loop" (a state machine: ordered phases, each a prompt + tools). Here is the current loop as JSON:

${JSON.stringify({ name: current.name, states: current.states }, null, 1)}

TOOLS available (use ONLY these names in a phase's "tools"):
${toolCatalog()}

The user asks for this change:
"""
${instruction}
"""

Apply it. You may add / remove / reorder phases, and change any phase's name, prompt, tools, gate, rejectTo, or model. Keep everything the user didn't ask to change. Output ONLY a JSON object — no prose, no code fence — of this shape:
{ "reply": "<one short sentence: what you changed>", "states": [ <the full updated states array, same shape as above> ] }`;
  const raw = await harnessOneShot(model, prompt);
  if (!raw.trim()) return { error: "the model returned nothing — try again." };
  const obj = extractJson(raw) as { reply?: string; states?: unknown } | null;
  const states = sanitizeStates(obj?.states);
  if (!states.length) return { error: "couldn't apply that edit — try rephrasing the change." };
  return { reply: String(obj?.reply || "Updated the loop.").slice(0, 300), states };
}
