# Atelier — This is a State Machine with Tools

This is the single most important rule in this codebase. Read it before writing any code.

## The one rule: STATE MACHINE WITH TOOLS — no deterministic pipeline code

Factory v3 moves a **goal** through a series of **states** (spec → mock → build → qa → …).
Every state is nothing more than:

1. **A prompt** — what to accomplish in this state ("do a thing"), and
2. **A set of attached tools** — the capabilities the AI may use to pursue it.

The engine runs an **agentic tool-loop**: it hands the state's prompt + tools to the model,
the model decides what to do, calls tools, and signals completion. A human reviews the result
("wait for approval") and advances the machine.

**Do NOT write deterministic, stage-specific business logic.** There is no `runSpecStage()` that
hard-codes how a spec is produced, no `if (state === 'mock')` branching in the runner, no parser
that interprets a state's output in a special way. The runner is generic. It does not know or care
what "spec" or "qa" means — those are just rows of config (a prompt + a tool list).

When you want the system to do something new, you have exactly two levers:

- **Add or improve a TOOL** (`app/lib/engine/tools.ts`) — a real, well-described capability the AI
  can choose to use. Tools are the only place imperative code lives.
- **Write a better PROMPT** for a state, or **attach different tools** to it (in the machine config).

If you find yourself special-casing a state name in the engine, stop — you are violating the rule.
Express it as a tool or a prompt instead.

## When the model does something you don't want — AGENTIC-FIRST, ALWAYS

The model will sometimes do undesirable things: produce 10 mock variations instead of a few,
flood the UI with intermediate screenshots, loop too long, skip a step. The instinct is to "fix"
it with deterministic code (cap the count, filter the output, hard-code the flow). **Don't.** That
instinct is the thing this codebase exists to resist.

When behaviour is off, you have exactly two correct moves:

1. **Change the TOOL.** Reshape the capability so the right thing is natural. (Example: instead of
   code that keeps only 4 mocks, `screenshot_page` defaults to a *scratch* check that doesn't clutter
   Deliverables, and the model marks finals with `present:true`. The model still decides how much to
   screenshot — the tool just separates "looking" from "presenting.")
2. **Change the GUIDANCE.** Improve the state's prompt to state the intent and the bar. (Example:
   "give the human ~3–4 distinct options, present only the finals." A target, not an enforced limit.)

The model stays in control of *how many* and *how*. If it judges that 10 is right, it can — we
shaped the tool and the intent, we did not legislate the outcome. The ONLY non-agentic code that's
acceptable is a genuine correctness bug fix (e.g. events were sorted by a random id, so the activity
log was shuffled — that's a bug, not a judgement override) or a safety backstop (a turn ceiling so a
runaway can't burn forever). Neither overrides what the model is trying to do.

Litmus test before you write imperative code: *"Am I fixing a bug / adding a capability, or am I
overriding the model's judgement about how to do its task?"* If the latter — stop, and move it into
a tool or a prompt instead.

## Why

LLMs are good at deciding *how* to reach a goal when given good tools and a clear objective. They
are bad at being forced down a rigid script. Leaning into the agentic nature — expose great tools,
write clear state prompts, let the model drive — produces a system that is simpler, more flexible,
and more capable than a hand-coded pipeline. A new kind of work needs a new prompt and maybe a new
tool, never a new branch in the orchestrator.

## NEVER QA, test, record, or drive the app yourself — only the factory's agent does

When you (the developer/assistant working on this codebase) need to verify the factory — run a
ticket, QA a feature, record a walkthrough, log into the target app, drive the browser — **you do
NOT do it by hand.** No hand-driving puppeteer, no calling `factool` yourself, no ad-hoc scripts
that screenshot/record the app. **The factory's agent does the work; you direct it.**

- To change what the agent does → change a **tool** or a **state prompt**, then **re-run the agent**
  (create a run, or `revise`/`reviseFrom` the relevant phase) and let it produce the artifacts.
- To verify something works → read the agent's events/artifacts/logs and the app's server logs / DB.
  Reading logs and the DB is fine. *Operating the app yourself is not.*
- If the agent captured the wrong thing (e.g. recorded the dashboard instead of the result page),
  the fix is a better prompt/tool — not you stepping in to record it correctly by hand.

Why: hand-driving hides the real bug (the agent still can't do it), produces throwaway artifacts the
factory doesn't own, and defeats the entire point of the system. If the agent can't do it, the
factory is broken — fix the factory, then let the agent do it.

## Engine shape (for orientation, not for special-casing)

- `app/lib/engine/tools.ts` — the tool registry: each tool = { schema, run() }. The ONLY imperative code.
- `app/lib/engine/agent.ts`  — the generic agentic tool-loop (model ⇄ tools until it asks for approval).
- `app/lib/engine/runner.ts` — the generic state driver: load state config, run the loop, await approval, advance.
- `app/lib/db.ts`            — persistence (runs, states, events, artifacts, machines).
- A **machine** is data: an ordered list of states, each `{ name, prompt, tools[], model? }`.

## Project constraints

- Next.js 16 App Router. Route handler params are a Promise: `{ params }: { params: Promise<{id}> }`, then `await params`.
- Never block the event loop in routes/engine. The agentic loop runs in the background; the UI polls.

## LLM calls ALWAYS go through the Claude Code harness — NEVER call Ollama Cloud directly

Every model call — the agent (`runClaudePhase`), the Conductor's one-shots (`conductor.ts callOnce`),
and the vision/QA helper (`vision.ts`) — runs through the Claude Code harness:
- **Claude-native models** → spawn the `claude` CLI.
- **Ollama models** → spawn `ollama launch claude --model <tag> -- …` — the model BACKS the full
  Claude Code harness. `ollama serve` is pointed at Claude; auth is the **ollama CLI's own login**.

Do **NOT** make direct in-process calls to Ollama (`getClient()` in `app/lib/engine/ollama.ts`, the
`OLLAMA_API_KEY` env, or `https://ollama.com`). That bypasses the harness and breaks when no cloud
key is set (e.g. the vision helper used to 404 with "OLLAMA_API_KEY not set"). For ANY one-shot model
call (describe/judge an image, answer a question), spawn the harness the way `conductor.ts callOnce`
and `vision.ts` do — never `getClient()`. (`ollama.ts` / `agent.ts` are legacy; treat them as off-limits.)

## Demo & marketing copy — keep it restrained

Do NOT enshittify the demo/README/marketing copy. No hype, no superlatives, no exclamation-y
taglines, no "boom"/growth-speak. State plainly what the thing does and let it speak. Prefer the
fewest, truest words. When in doubt, cut the adjective. The brand intro is just the name "Atelier"
and its plain English translation ("workshop") — nothing more on that slide.
