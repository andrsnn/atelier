import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { generateLoop } from "@/app/lib/engine/authoring";
import { upsertMachine } from "@/app/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "loop";

/** Draft a whole loop from a plain-English description (AI), persist it, return the new loop. */
export async function POST(req: NextRequest) {
  const { description } = await req.json().catch(() => ({}));
  if (typeof description !== "string" || !description.trim()) {
    return NextResponse.json({ error: "describe the loop you want" }, { status: 400 });
  }
  const d = await generateLoop(description);
  if ("error" in d) return NextResponse.json({ error: d.error }, { status: 422 });
  const machine = upsertMachine({
    id: `loop-${slug(d.name)}-${nanoid(4)}`,
    name: d.name, description: d.description, states: d.states,
  });
  return NextResponse.json({ machine });
}
