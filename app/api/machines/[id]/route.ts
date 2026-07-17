import { NextRequest, NextResponse } from "next/server";
import { getMachine, upsertMachine } from "@/app/lib/db";
import { attachableTools } from "@/app/lib/engine/tools";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const machine = getMachine(id);
  if (!machine) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ machine, tools: attachableTools() });
}

/** Patch just a few loop SETTINGS (e.g. the Self-learning toggle) without a full save —
 *  merges into the DB's current settings, so it never touches states/prompts or clobbers
 *  in-progress editor edits or learned principles. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = getMachine(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const settings = { ...m.settings, ...(body.settings && typeof body.settings === "object" ? body.settings : {}) };
  const machine = upsertMachine({ id, name: m.name, description: m.description, states: m.states, settings });
  return NextResponse.json({ machine });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const settings = { ...(body.settings || {}) };
  // Principles are owned by the /principles endpoint and written live by the loop's Reflect &
  // Record node — a plain machine save must never wipe learned principles. Carry the existing
  // ones over unless this payload explicitly includes a principles array.
  if (!("principles" in settings)) {
    const existing = getMachine(id);
    if (existing?.settings.principles?.length) settings.principles = existing.settings.principles;
  }
  const machine = upsertMachine({
    id,
    name: body.name || "Untitled loop",
    description: body.description || "",
    states: Array.isArray(body.states) ? body.states : [],
    settings,
  });
  return NextResponse.json({ machine });
}
