import { NextRequest, NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { join } from "path";
import { resolveInHome, isDir } from "@/app/api/fs/guard";

export const dynamic = "force-dynamic";

// Create ONE new sub-folder inside a browsed directory, so a phone user can make
// a fresh folder to point a loop at (there's no OS "new folder" button on the
// web). Scoped to $HOME (same guard as /api/fs/list). Non-recursive: exactly one
// new level, safe names only.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Enter a folder name." }, { status: 400 });
  if (name.includes("/") || name.includes("..") || name.startsWith(".") || name.length > 255) {
    return NextResponse.json({ error: "Use a simple folder name (no “/”, “..”, or leading dot)." }, { status: 400 });
  }

  let parent: string;
  try { parent = resolveInHome(body.path); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Bad path." }, { status: 400 }); }
  if (!isDir(parent)) return NextResponse.json({ error: "That parent folder doesn’t exist." }, { status: 400 });

  const target = join(parent, name);
  try {
    mkdirSync(target); // non-recursive → throws EEXIST if it already exists
    return NextResponse.json({ path: target });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return NextResponse.json({ error: `“${name}” already exists here.` }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not create the folder." }, { status: 400 });
  }
}
