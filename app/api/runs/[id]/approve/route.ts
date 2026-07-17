import { NextRequest, NextResponse } from "next/server";
import { getRun, updateRun, getMachine, setCriteria, addRunLearning, removeRunLearning, promoteLearning } from "@/app/lib/db";
import { approve, requestChanges, start, setGateMode, pauseRun, resumeRun, goToPhase, updateGoal, reviseFrom, sendComments, setDisabledSteps, addCase, routeToPhase, recheckPhase, maybeReflect } from "@/app/lib/engine/runner";
import { generateCriteria } from "@/app/lib/engine/conductor";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const { action, message, gateMode, phase, goal, state, steps, title, images } = body;

  if (action === "rename") { const t = String(title || "").slice(0, 80).trim(); if (t) updateRun(id, { title: t } as any); return NextResponse.json({ run: getRun(id) }); }
  if (action === "setMode") {
    // generic: only accept a mode this run's machine actually declares; else null (machine default)
    const ids = (getMachine(run.machine_id)?.settings.modes || []).map(m => m.id);
    updateRun(id, { mode: ids.includes(body.mode) ? body.mode : null } as any);
    return NextResponse.json({ run: getRun(id) });
  }
  if (action === "setModels") {
    const patch: Record<string, unknown> = {};
    if (typeof body.primaryModel === "string" && body.primaryModel) patch.primary_model = body.primaryModel;
    if (typeof body.visionModel === "string" && body.visionModel) patch.vision_model = body.visionModel;
    if ("conductorModel" in body) patch.conductor_model = body.conductorModel || null; // "" / null = same as agent
    if (Object.keys(patch).length) updateRun(id, patch as any);
    return NextResponse.json({ run: getRun(id) });
  }

  if (action === "setDisabledSteps") { setDisabledSteps(id, Array.isArray(steps) ? steps : []); return NextResponse.json({ run: getRun(id) }); }
  // ── North Star & run-level learnings ──
  if (action === "setCriteria") { const list = setCriteria(id, Array.isArray(body.criteria) ? body.criteria : []); return NextResponse.json({ run: getRun(id), criteria: list }); }
  if (action === "generateCriteria") { const list = await generateCriteria(id); if (!list) return NextResponse.json({ error: "couldn't generate criteria" }, { status: 502 }); return NextResponse.json({ run: getRun(id), criteria: list }); }
  if (action === "addLearning") { const l = addRunLearning(id, String(message ?? body.text ?? "")); if (!l) return NextResponse.json({ error: "empty learning" }, { status: 400 }); return NextResponse.json({ run: getRun(id), learning: l }); }
  if (action === "removeLearning") { const list = removeRunLearning(id, String(body.learningId || "")); return NextResponse.json({ run: getRun(id), learnings: list }); }
  if (action === "promoteLearning") { const after = promoteLearning(id, String(body.learningId || "")); return NextResponse.json({ run: getRun(id), machine: getMachine(run.machine_id), principles: after }); }
  if (action === "sendComments") {
    const r = await sendComments(id, String(state || ""));
    if (!r.ok) return NextResponse.json({ error: "no open comments for that phase" }, { status: 400 });
    return NextResponse.json({ run: getRun(id), sent: r.count });
  }
  if (action === "approve") approve(id, message ? String(message) : undefined);
  else if (action === "changes") { requestChanges(id, String(message || "Please revise.")); if (message) maybeReflect(id, String(message)); }
  else if (action === "start") start(id);
  else if (action === "setGateMode") setGateMode(id, gateMode === "all" || gateMode === "none" ? gateMode : "machine");
  else if (action === "pause") pauseRun(id);
  else if (action === "resume") resumeRun(id);
  else if (action === "goto") goToPhase(id, Number(phase), message ? String(message) : undefined);
  else if (action === "revise") { reviseFrom(id, Number(phase), String(message || "")); if (message) maybeReflect(id, String(message)); }
  else if (action === "recheck") { if (!recheckPhase(id, Number(phase))) return NextResponse.json({ error: "phase is not watchable" }, { status: 400 }); }
  else if (action === "addCase") { if (!addCase(id, String(state || ""), String(message || ""))) return NextResponse.json({ error: "bad case target" }, { status: 400 }); }
  else if (action === "routeTo") { if (!(await routeToPhase(id, String(state || ""), String(message || ""), Array.isArray(images) ? images.filter((x: unknown) => typeof x === "string") as string[] : []))) return NextResponse.json({ error: "bad route target" }, { status: 400 }); }
  else if (action === "editGoal") updateGoal(id, String(goal || "").trim());
  else return NextResponse.json({ error: "unknown action" }, { status: 400 });

  return NextResponse.json({ run: getRun(id) });
}
