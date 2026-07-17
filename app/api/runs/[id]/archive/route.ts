import { NextRequest, NextResponse } from "next/server";
import { getRun, setArchived } from "@/app/lib/db";

export const dynamic = "force-dynamic";

// Archive a loop (hide it from the board) or restore it. Body: { archived: boolean }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  setArchived(id, body.archived !== false);
  return NextResponse.json({ ok: true });
}
