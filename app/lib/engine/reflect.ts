/**
 * Self-learning — a loop's self-improvement brain, driven by a loop-level SETTING (not a node).
 *
 * When a loop has settings.selfLearn on, giving FEEDBACK on one of its runs fires a reflection:
 * it distills the DURABLE, GENERALIZED lesson behind the feedback and records it as a principle
 * on the loop (settings.principles). Those principles are then injected into every future run's
 * phase prompts — so the loop stops needing the same feedback twice.
 *
 * With settings.evolveStructure ALSO on, reflection can go a step further: when the feedback
 * exposes a SYSTEMIC GAP that a text principle can't fix — a whole missing STEP, e.g. a review
 * the loop never had — it can ADD A NEW NODE to the loop's flow. The loop evolves its own
 * structure, not just its rules. Still agentic: the reflection model DECIDES; a tool/db call
 * applies it. Toggleable, off by default.
 *
 * One-shot through the Claude Code harness (same auth path as everything else).
 */
import { getMachine, recordPrinciples, insertMachineState, type Principle, type StateDef } from "../db";
import { attachableTools } from "./tools";
import { harnessOneShot } from "./oneshot";
import { nanoid } from "nanoid";

/** The default reflection instructions (how it decides what to learn). A loop can override
 *  these via settings.reflectPrompt. */
export const DEFAULT_REFLECT_PROMPT =
  `You are this loop's self-improvement brain. When the human gives feedback on a run, find the ` +
  `DURABLE, GENERALIZABLE lesson behind it (the kind of thing you'd fold into a phase's ` +
  `instructions so the issue never recurs) and record it as a standing principle for the whole ` +
  `loop. Keep principles short, imperative, and general — a rule for ANY future run, never a ` +
  `one-off fix for this one. Skip feedback that's purely run-specific with no reusable lesson.`;

/** Pull the first JSON object out of a model reply (tolerates prose / code fences). */
function extractJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  return null;
}

/** Is self-learning ON for this loop (a loop-level setting)? */
export function isSelfLearning(machineId: string): boolean {
  return getMachine(machineId)?.settings.selfLearn === true;
}

export interface ReflectResult { added: Principle[]; addedNode?: { name: string; id: string }; reply: string }

/** Reflect over a piece of human feedback: distill durable, generalized principle(s) and record
 *  them onto the loop — and, if structural evolution is on, add a missing node. Returns what it
 *  added (empty if nothing generalizable), or null if the loop isn't self-learning. */
export async function reflectAndRecord(machineId: string, feedback: string, runGoal?: string): Promise<ReflectResult | null> {
  const m = getMachine(machineId);
  if (!m || m.settings.selfLearn !== true) return null;
  const fb = String(feedback || "").trim();
  if (!fb) return null;

  const current = (m.settings.principles || []).map(p => `- ${p.text}`).join("\n") || "(none yet)";
  const phases = m.states.map(s => s.name).join(" → ");
  const instructions = m.settings.reflectPrompt?.trim() || DEFAULT_REFLECT_PROMPT;
  const model = "claude:sonnet";

  // Structural evolution: only when the toggle is on and there's room to grow (runaway guard).
  const evolve = m.settings.evolveStructure === true && m.states.length < 12;
  const toolNames: string[] = evolve ? attachableTools().map(t => t.name) : [];

  const evolveBlock = evolve ? `

This loop can also EVOLVE ITS STRUCTURE. If — and ONLY if — the feedback exposes a SYSTEMIC GAP that a text principle can't close (a whole missing STEP, typically a review/verification phase the loop never had that would have CAUGHT this class of issue), propose ONE new node. Prefer a principle whenever a principle is enough; add a node only for a genuine missing step in the flow. Its tools MUST come from this list: ${toolNames.join(", ")}. Insert it after an existing phase (by that phase's exact name).` : "";

  const outSchema = evolve
    ? `{ "principles": ["<short imperative principle>", "..."], "newNode": { "name": "<short phase name>", "prompt": "<clear instruction for what this phase does>", "tools": ["<names from the allowed list>"], "insertAfter": "<exact existing phase name>", "gate": <true|false>, "rejectTo": "<existing phase name to loop back to on failure, or null>" } | null, "reply": "<one short sentence>" }`
    : `{ "principles": ["<short imperative principle>", "..."], "reply": "<one short sentence: what you learned, or that there was nothing durable>" }`;

  const prompt = `${instructions}

LOOP: "${m.name}"  (phases: ${phases})
${runGoal ? `The run's goal was: ${String(runGoal).slice(0, 400)}\n` : ""}CURRENT PRINCIPLES (do NOT duplicate; only add what's genuinely new):
${current}

THE HUMAN JUST GAVE THIS FEEDBACK on a run of this loop:
"""
${fb.slice(0, 2000)}
"""
${evolveBlock}

Distill ONLY durable, GENERALIZED principle(s) this loop should follow so it never needs this same feedback again — each phrased as a standing rule for ANY future run, not a one-off fix for this run. If the feedback has no generalizable lesson, return an empty list. Output ONLY JSON (no prose, no code fence):
${outSchema}`;

  const raw = await harnessOneShot(model, prompt).catch(() => "");
  const obj = extractJson(raw);

  // 1) Principles.
  const texts: string[] = Array.isArray(obj?.principles) ? obj.principles.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
  let added: Principle[] = [];
  if (texts.length) {
    const before = new Set((m.settings.principles || []).map(p => p.text));
    const all = recordPrinciples(machineId, texts.map(t => ({ text: t, source: "feedback" as const, note: fb.slice(0, 140) })));
    added = all.filter(p => !before.has(p.text));
  }

  // 2) Structural evolution — add a missing node, if warranted and allowed.
  let addedNode: { name: string; id: string } | undefined;
  if (evolve && obj?.newNode && typeof obj.newNode === "object") {
    const nn = obj.newNode;
    const name = String(nn.name || "").trim().slice(0, 60);
    const nprompt = String(nn.prompt || "").trim();
    if (name && nprompt) {
      const valid = new Set(toolNames);
      const ntools = (Array.isArray(nn.tools) ? nn.tools : []).map((x: unknown) => String(x)).filter((t: string) => valid.has(t));
      const after = m.states.find(s => s.name.toLowerCase() === String(nn.insertAfter || "").toLowerCase());
      const rejectTo = m.states.find(s => s.name.toLowerCase() === String(nn.rejectTo || "").toLowerCase());
      const state: StateDef = {
        id: `state-${nanoid(6)}`,
        name,
        prompt: nprompt,
        tools: ntools,
        ...(nn.gate === true ? { gate: true } : {}),
        ...(rejectTo ? { rejectTo: rejectTo.id } : {}),
        x: (after?.x ?? 0) + 260,
        y: after?.y ?? 0,
      };
      const updated = insertMachineState(machineId, state, after?.id);
      if (updated) addedNode = { name: state.name, id: state.id };
    }
  }

  const bits: string[] = [];
  if (added.length) bits.push(`${added.length} principle(s)`);
  if (addedNode) bits.push(`a new phase "${addedNode.name}"`);
  const reply = String(obj?.reply || (bits.length ? `Learned ${bits.join(" + ")}.` : "Nothing durable to learn from that."));
  return { added, addedNode, reply };
}
