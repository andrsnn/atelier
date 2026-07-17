import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { parseWorkflow, workflowToMachine } from "@/app/lib/workflows/parse";
import { upsertMachine } from "@/app/lib/db";

export const dynamic = "force-dynamic";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** Import a Claude Code workflow script as a machine the app can visualize/manage.
 *  Statically parses the script (never executes it) and stores phases→states plus the
 *  original script. The app is the visualization + management layer over the workflow. */
export async function POST(req: NextRequest) {
  const { script, id } = await req.json().catch(() => ({}));
  if (typeof script !== "string" || !script.trim()) {
    return NextResponse.json({ error: "no script" }, { status: 400 });
  }
  const wf = parseWorkflow(script);
  if (!wf.ok) return NextResponse.json({ error: wf.error }, { status: 400 });
  const mid = (typeof id === "string" && id) || `wf-${slug(wf.name) || "workflow"}-${nanoid(4)}`;
  const built = workflowToMachine(wf, mid, script);
  const machine = upsertMachine({
    id: built.id, name: built.name, description: built.description,
    states: built.states, settings: built.settings,
  });
  return NextResponse.json({ machine });
}
