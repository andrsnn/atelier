import { NextRequest, NextResponse } from "next/server";
import { getMachine, upsertMachine } from "@/app/lib/db";
import { editLoop } from "@/app/lib/engine/authoring";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Chat-edit a loop: apply a plain-English change to its states (AI), persist, return the reply + updated loop. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = getMachine(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { message } = await req.json().catch(() => ({}));
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "say what to change" }, { status: 400 });
  }
  const r = await editLoop({ name: m.name, states: m.states }, message);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 422 });
  const machine = upsertMachine({ id, name: m.name, description: m.description, states: r.states, settings: m.settings });
  return NextResponse.json({ reply: r.reply, machine });
}
