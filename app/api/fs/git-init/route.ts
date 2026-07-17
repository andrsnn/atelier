import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { resolveInHome, isDir } from "@/app/api/fs/guard";

export const dynamic = "force-dynamic";
const run = promisify(execFile);

// Make a folder worktree-ready. Loops run inside `git worktree add`, which needs
// a repo WITH at least one commit — a bare `git init` isn't enough (worktree add
// fails on a repo with zero commits, which is the exact error users hit). So we
// init + make an EMPTY initial commit (NO existing files staged, per product
// decision). No-op on folders that are already repos; scoped to $HOME.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  let dir: string;
  // Outside HOME → do nothing and let the register step validate; this keeps the
  // guard tight without blocking legit non-HOME repos that are already git repos.
  try { dir = resolveInHome(body.path); }
  catch { return NextResponse.json({ initialized: false, skipped: true }); }

  // Missing / not a dir → skip; the register step returns the authoritative
  // "no such directory" error, so we don't emit a duplicate message here.
  if (!isDir(dir)) return NextResponse.json({ initialized: false, skipped: true });
  if (existsSync(join(dir, ".git"))) return NextResponse.json({ initialized: false, alreadyRepo: true });

  try {
    await run("git", ["-C", dir, "init"]);
    // -c identity so the commit can't fail when the repo/user has no git identity.
    await run("git", ["-C", dir, "-c", "user.name=Atelier", "-c", "user.email=atelier@localhost",
      "commit", "--allow-empty", "-m", "Initial commit (Atelier)"]);
    return NextResponse.json({ initialized: true });
  } catch (e) {
    const raw = String((e as { stderr?: string })?.stderr || (e instanceof Error ? e.message : e) || "");
    const msg = raw.replace(/^fatal:\s*/i, "").trim() || "git init failed";
    return NextResponse.json({ error: `Couldn’t set up git in that folder: ${msg}` }, { status: 500 });
  }
}
