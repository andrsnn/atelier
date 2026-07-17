import { NextRequest, NextResponse } from "next/server";
import { getRun, listConductorMessages, clearConductorMessages } from "@/app/lib/db";
import { synthesize, talkToConductor, applyDirective, dismissDirective, setConductorMode, setConductorReact, setAutopilot, stopConductor, isConductorWorking, revertConductor, getConductorActivity, clearConductorActivity, catchUp } from "@/app/lib/engine/conductor";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payload = (id: string) => ({ conductor: listConductorMessages(id), run: getRun(id), working: isConductorWorking(id), activity: getConductorActivity(id) });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json(payload(id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  switch (action) {
    case "catchUp": {
      const sinceTs = Number(body.sinceTs) || 0;
      const r = await catchUp(id, sinceTs);
      return NextResponse.json(r);
    }
    case "synthesize": void synthesize(id); break; // non-blocking — the reply lands via polling
    case "talk": {
      // accept an array of data-URLs (multi-image); tolerate a legacy single `image`.
      const imgs = (Array.isArray(body.images) ? body.images : (typeof body.image === "string" ? [body.image] : []))
        .filter((s: unknown): s is string => typeof s === "string" && s.startsWith("data:image/"));
      await talkToConductor(id, String(body.text || ""), imgs);
      break;
    }
    case "stop": stopConductor(id); break;
    case "clear": stopConductor(id); clearConductorMessages(id); clearConductorActivity(id); break;
    case "revert": revertConductor(id); break;
    case "apply": {
      const r = await applyDirective(id, String(body.messageId || ""));
      if (!r.ok) return NextResponse.json({ error: r.error || "could not apply" }, { status: 400 });
      break;
    }
    case "dismiss": dismissDirective(String(body.messageId || "")); break;
    case "setMode": setConductorMode(id, body.mode === "auto" ? "auto" : "propose"); break;
    case "setReact": setConductorReact(id, body.react === "manual" ? "manual" : "auto"); break;
    case "setAutopilot": await setAutopilot(id, body.autopilot === "auto" ? "auto" : body.autopilot === "manual" ? "manual" : "propose"); break;
    default: return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json(payload(id));
}
