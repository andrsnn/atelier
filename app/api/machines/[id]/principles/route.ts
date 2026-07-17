import { NextRequest, NextResponse } from "next/server";
import { getMachine, setPrinciples, type Principle } from "@/app/lib/db";

export const dynamic = "force-dynamic";

/** A loop's learned principles, managed independently of the machine PUT so the Reflect &
 *  Record node (which writes them live) is never clobbered by a plain loop save. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = getMachine(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ principles: m.settings.principles || [] });
}

/** Replace the loop's principles wholesale (editor add/edit/remove). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = getMachine(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body.principles) ? (body.principles as Principle[]) : [];
  const principles = setPrinciples(id, incoming);
  return NextResponse.json({ principles });
}
