import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { listMachines, upsertMachine } from "@/app/lib/db";
import { attachableTools } from "@/app/lib/engine/tools";
import { ensureDefaults } from "@/app/lib/machines/defaults";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureDefaults();
  return NextResponse.json({ machines: listMachines(), tools: attachableTools() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const id = body.id || nanoid(8);
  const machine = upsertMachine({
    id,
    name: body.name || "Untitled machine",
    description: body.description || "",
    states: Array.isArray(body.states) ? body.states : [],
  });
  return NextResponse.json({ machine });
}
