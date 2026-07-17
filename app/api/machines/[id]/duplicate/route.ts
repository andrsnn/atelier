import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getMachine, upsertMachine } from "@/app/lib/db";

export const dynamic = "force-dynamic";

/** Duplicate a loop: a fresh id and a "(copy)" name, everything else — states, tools, routing,
 *  settings, learned principles — copied verbatim, so the copy is a ready-to-edit starting point.
 *  A new id means upsertMachine does a clean insert (fresh created_at), leaving the original
 *  untouched. State ids are kept as-is; they're scoped within the machine, so intra-loop routing
 *  (rejectTo / returnTo) stays intact. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const src = getMachine(id);
  if (!src) return NextResponse.json({ error: "not found" }, { status: 404 });

  const machine = upsertMachine({
    id: nanoid(8),
    name: `${src.name} (copy)`,
    description: src.description,
    states: JSON.parse(JSON.stringify(src.states)),
    settings: JSON.parse(JSON.stringify(src.settings)),
  });
  return NextResponse.json({ machine });
}
