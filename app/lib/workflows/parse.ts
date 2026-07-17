/**
 * Claude Code workflow scripts as machines. A "Claude Code workflow" is a JS
 * orchestration script (the kind saved under `.claude/workflows/*.js`): an
 * `export const meta = { name, description, phases }` block plus a body of
 * `phase()`, `agent()`, `parallel()`, `pipeline()` calls.
 *
 * This module STATICALLY parses such a script (via the TypeScript compiler API —
 * we never execute the untrusted code) and extracts its structure: ordered
 * phases, the agent tasks in each, and whether a phase fans out (parallel /
 * pipeline) or loops. That structure maps onto a factory machine (phase => state)
 * so the existing Cards/Canvas/graph visualizers can render it. This is exactly
 * parallel to the YAML loader in `../machines/load.ts`: a new INPUT FORMAT that
 * produces the same declarative machine data — no engine special-casing.
 */
import ts from "typescript";
import type { StateDef, MachineSettings } from "../db";

export type Orchestration = "sequential" | "parallel" | "pipeline";

export interface WfAgent {
  label: string;
  task: string;       // the agent() prompt (first arg), best-effort from the source
  fanout: boolean;    // true when the call is inside a .map()/loop => "one per item"
  model?: string;     // the agent()'s `model` option, if it pins a specific LLM for this task
}

export interface WfPhase {
  title: string;
  detail?: string;
  orchestration: Orchestration;
  looped: boolean;    // the phase (or its agents) run inside a while/for loop
  agents: WfAgent[];
}

export interface ParsedWorkflow {
  ok: boolean;
  error?: string;
  name: string;
  description: string;
  whenToUse?: string;
  phases: WfPhase[];
  totalAgents: number;
}

const ORCH_RANK: Record<Orchestration, number> = { sequential: 0, parallel: 1, pipeline: 2 };

/** Read a string out of a literal expression; undefined for non-literal/dynamic. */
function strOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      let expr = "…";
      try { expr = span.expression.getText(); } catch { /* keep … */ }
      s += "${" + expr.replace(/\s+/g, " ").trim() + "}" + span.literal.text;
    }
    return s;
  }
  return undefined;
}

/** Find a named string property on an object-literal arg. */
function propStr(obj: ts.Expression | undefined, key: string): string | undefined {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name && (p.name as ts.Identifier).text === key) return strOf(p.initializer);
  }
  return undefined;
}

const calleeName = (call: ts.CallExpression): string => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text; // e.g. .map, .then
  return "";
};

/** Compress whitespace + clip for display. */
const clip = (s: string, n = 240): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "phase";

/**
 * Parse a Claude Code workflow script. Never throws — returns { ok:false, error }
 * on a fatal parse problem so callers can surface it in the UI.
 */
export function parseWorkflow(source: string): ParsedWorkflow {
  const empty = (error: string): ParsedWorkflow => ({
    ok: false, error, name: "", description: "", phases: [], totalAgents: 0,
  });
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile("workflow.js", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.JS);
  } catch (e) {
    return empty(e instanceof Error ? e.message : "could not parse script");
  }

  // ---- meta block ----
  let name = "", description = "", whenToUse: string | undefined;
  const metaPhases: { title: string; detail?: string }[] = [];
  const readMeta = (init: ts.Expression) => {
    if (!ts.isObjectLiteralExpression(init)) return;
    for (const p of init.properties) {
      if (!ts.isPropertyAssignment(p) || !p.name) continue;
      const k = (p.name as ts.Identifier).text;
      if (k === "name") name = strOf(p.initializer) ?? name;
      else if (k === "description") description = strOf(p.initializer) ?? description;
      else if (k === "whenToUse") whenToUse = strOf(p.initializer) ?? whenToUse;
      else if (k === "phases" && ts.isArrayLiteralExpression(p.initializer)) {
        for (const el of p.initializer.elements) {
          if (ts.isObjectLiteralExpression(el)) {
            const title = propStr(el, "title");
            if (title) metaPhases.push({ title, detail: propStr(el, "detail") });
          }
        }
      }
    }
  };
  const findMeta = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.name && ts.isIdentifier(d.name) && d.name.text === "meta" && d.initializer) readMeta(d.initializer);
      }
    }
    ts.forEachChild(node, findMeta);
  };
  findMeta(sf);

  // ---- phase registry (meta order first; phase()-only phases appended) ----
  const phases: WfPhase[] = metaPhases.map((m) => ({
    title: m.title, detail: m.detail, orchestration: "sequential", looped: false, agents: [],
  }));
  const byTitle = new Map<string, WfPhase>(phases.map((p) => [p.title, p]));
  const ensurePhase = (title: string): WfPhase => {
    let p = byTitle.get(title);
    if (!p) { p = { title, orchestration: "sequential", looped: false, agents: [] }; phases.push(p); byTitle.set(title, p); }
    return p;
  };

  // ---- walk the body, tracking current phase + orchestration/loop context ----
  let current = ""; // current phase title set by phase("X")
  interface Ctx { parallel: boolean; pipeline: boolean; loop: boolean; map: boolean; }
  const walk = (node: ts.Node, ctx: Ctx) => {
    let next = ctx;
    if (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isDoStatement(node)) {
      next = { ...ctx, loop: true };
    }
    if (ts.isCallExpression(node)) {
      const fn = calleeName(node);
      if (fn === "phase") {
        const t = strOf(node.arguments[0]);
        if (t) { current = t; ensurePhase(t); }
      } else if (fn === "agent") {
        const explicit = propStr(node.arguments[1], "phase");
        const title = explicit || current || metaPhases[0]?.title || "Workflow";
        const ph = ensurePhase(title);
        const task = strOf(node.arguments[0]) ?? clip(node.arguments[0]?.getText(sf) ?? "agent task");
        const label = propStr(node.arguments[1], "label") || clip(task, 48);
        const model = propStr(node.arguments[1], "model");
        ph.agents.push({ label, task: clip(task), fanout: ctx.map || ctx.loop, model });
        const orch: Orchestration = ctx.pipeline ? "pipeline" : ctx.parallel ? "parallel" : "sequential";
        if (ORCH_RANK[orch] > ORCH_RANK[ph.orchestration]) ph.orchestration = orch;
        if (ctx.loop) ph.looped = true;
      } else if (fn === "parallel") {
        next = { ...next, parallel: true };
      } else if (fn === "pipeline") {
        next = { ...next, pipeline: true };
      } else if (fn === "map" || fn === "flatMap" || fn === "forEach") {
        next = { ...next, map: true };
      }
    }
    ts.forEachChild(node, (c) => walk(c, next));
  };
  walk(sf, { parallel: false, pipeline: false, loop: false, map: false });

  const totalAgents = phases.reduce((n, p) => n + p.agents.length, 0);
  if (!name && phases.length === 0) {
    return empty("no `export const meta` and no phase()/agent() calls found — is this a Claude Code workflow script?");
  }
  return {
    ok: true,
    name: name || "Untitled workflow",
    description,
    whenToUse,
    phases,
    totalAgents,
  };
}

/** Per-state extra carried for workflow-sourced machines (opaque to the engine). */
export interface WorkflowStateMeta {
  orchestration: Orchestration;
  looped: boolean;
  agents: WfAgent[];
}

/** Machine-level marker stored in settings (settings is an opaque JSON blob). */
export interface WorkflowMachineMeta {
  source: "claude-workflow";
  whenToUse?: string;
  totalAgents: number;
  script: string;
}

export interface BuiltMachine {
  id: string;
  name: string;
  description: string;
  states: StateDef[];
  settings: Partial<MachineSettings> & { workflow: WorkflowMachineMeta };
}

/**
 * Turn a parsed workflow into a factory machine: each phase => a state. The
 * agents/orchestration ride along in `state.workflow` (StateDef is opaque JSON,
 * so no migration). Tools are empty — a workflow phase isn't a factory tool-loop;
 * the app renders these as a *visualization/management* layer over the script.
 */
export function workflowToMachine(wf: ParsedWorkflow, id: string, script: string): BuiltMachine {
  const used = new Set<string>();
  const states: StateDef[] = wf.phases.map((p, i) => {
    let sid = slug(p.title);
    while (used.has(sid)) sid = `${sid}-${i}`;
    used.add(sid);
    const summary = p.agents.length
      ? p.agents.map((a) => `• ${a.label}${a.fanout ? " (per item)" : ""}${a.model ? ` [${a.model}]` : ""}`).join("\n")
      : "";
    // If every agent in the phase pins the SAME model, surface it as the phase's model.
    const models = [...new Set(p.agents.map((a) => a.model).filter(Boolean))];
    return {
      id: sid,
      name: p.title,
      prompt: [p.detail, summary].filter(Boolean).join("\n\n"),
      tools: [],
      ...(models.length === 1 ? { model: models[0] } : {}),
      // opaque extra consumed by the visualizer:
      workflow: { orchestration: p.orchestration, looped: p.looped, agents: p.agents },
    };
  });
  return {
    id,
    name: wf.name,
    description: wf.description,
    states,
    settings: { workflow: { source: "claude-workflow", whenToUse: wf.whenToUse, totalAgents: wf.totalAgents, script } },
  };
}
