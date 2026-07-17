import { NextRequest, NextResponse } from "next/server";
import { parseWorkflow } from "@/app/lib/workflows/parse";

export const dynamic = "force-dynamic";

/** Live-preview parse of a pasted Claude Code workflow script — no persistence.
 *  Powers the editor's "paste a workflow → see its phases" affordance. */
export async function POST(req: NextRequest) {
  const { script } = await req.json().catch(() => ({}));
  if (typeof script !== "string" || !script.trim()) {
    return NextResponse.json({ error: "no script" }, { status: 400 });
  }
  return NextResponse.json({ workflow: parseWorkflow(script) });
}
