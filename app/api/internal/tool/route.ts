import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getRun, addEvent, addArtifact, addDeliverable, clearFinalDeliverables } from "@/app/lib/db";
import { getTool, type ToolContext, type ArtifactKind } from "@/app/lib/engine/tools";
import { setPendingControl, type ControlAction } from "@/app/lib/engine/control";
import { INTERNAL_SECRET } from "@/app/lib/engine/runner";

export const dynamic = "force-dynamic";

/**
 * The bridge that lets a Claude-driven phase use the SAME factory tools as the
 * Ollama path. `factool` (run by the agent via Bash) posts here; we run the named
 * tool in-process (so artifacts/events land identically) or record a phase-control
 * signal. Guarded by a shared secret.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.secret !== INTERNAL_SECRET) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const run = getRun(body.runId);
  if (!run) return NextResponse.json({ error: "no run" }, { status: 404 });
  const state: string = body.state || "system";
  const action: string = body.action;
  const args = body.args || {};

  // Phase-control signals (end the phase): record for the runner to pick up.
  if (action === "request_approval" || action === "reject" || action === "complete") {
    const summary = String(args.summary || args.reasons || "");
    setPendingControl(run.id, { action: action as ControlAction, summary });
    addEvent({ id: nanoid(), run_id: run.id, state, type: action === "reject" ? "reject" : "approval_request", content: { summary } });
    return NextResponse.json({ ok: true });
  }

  // Otherwise it's a normal tool call — run it with a real ToolContext.
  const tool = getTool(action);
  if (!tool) return NextResponse.json({ error: `unknown tool ${action}` }, { status: 400 });
  const ctx: ToolContext = {
    workspace: run.workspace, runId: run.id, state, visionModel: run.vision_model,
    emitArtifact: ({ name, kind, body }: { name: string; kind: ArtifactKind; body: string }) => {
      addArtifact({ id: nanoid(), run_id: run.id, state, name, kind, body });
      addEvent({ id: nanoid(), run_id: run.id, state, type: "artifact", content: { name, kind, size: body.length } });
    },
    emitScreenshot: (name: string, relPath: string) => addEvent({ id: nanoid(), run_id: run.id, state, type: "screenshot", content: { name, path: relPath } }),
    emitDeliverable: (d) => {
      addDeliverable({ id: d.id, run_id: run.id, state, filename: d.filename, stored_path: d.storedPath, size: d.size, mime: d.mime, label: d.label, description: d.description, loop: run.loop_count });
      addEvent({ id: nanoid(), run_id: run.id, state, type: "deliverable", content: { id: d.id, filename: d.filename, size: d.size, mime: d.mime, label: d.label, description: d.description } });
    },
    emitFinalDeliverables: (list) => {
      clearFinalDeliverables(run.id);
      for (const d of list) {
        addDeliverable({ id: d.id, run_id: run.id, state, filename: d.filename, stored_path: d.storedPath, size: d.size, mime: d.mime, label: d.label, description: d.description, is_final: true, loop: run.loop_count });
        addEvent({ id: nanoid(), run_id: run.id, state, type: "deliverable", content: { id: d.id, filename: d.filename, size: d.size, mime: d.mime, label: d.label, description: d.description, final: true } });
      }
    },
    log: (line: string) => addEvent({ id: nanoid(), run_id: run.id, state, type: "text", content: { text: line + "\n", channel: "log" } }),
  };
  try {
    const result = await tool.run(args, ctx);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, result: `Error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
