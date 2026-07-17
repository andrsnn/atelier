import { NextRequest, NextResponse } from "next/server";
import { getRun, getMachine, listEvents, listArtifacts, listComments, listConductorMessages, listDeliverables } from "@/app/lib/db";
import { isConductorWorking, getConductorActivity } from "@/app/lib/engine/conductor";
import { reconcile } from "@/app/lib/engine/runner";
import { heartbeat, presentUsers } from "@/app/lib/presence";
import { SERVER_BOOT_ID } from "@/app/lib/version";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Presence: each poll carries the viewer's name — record it, return who's here.
  heartbeat(id, req.headers.get("x-atelier-user"));
  // Self-heal the scheduler: re-adopt interrupted "running" runs and re-enqueue
  // stranded "queued" ones (the queue is in-memory and a restart loses it).
  reconcile();
  const machine = getMachine(run.machine_id);
  const since = req.nextUrl.searchParams.get("since") || undefined;
  return NextResponse.json({
    run,
    machine,
    events: listEvents(id, since),
    artifacts: listArtifacts(id),
    deliverables: listDeliverables(id),
    comments: listComments(id),
    conductor: listConductorMessages(id),
    conductorWorking: isConductorWorking(id),
    conductorActivity: getConductorActivity(id),
    presence: presentUsers(id),
    serverVersion: SERVER_BOOT_ID,
  });
}
