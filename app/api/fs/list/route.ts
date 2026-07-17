import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import { HOME, within, safePath } from "@/app/api/fs/guard";

export const dynamic = "force-dynamic";

// Browse directories on THIS Mac so a phone (which can't see the server's native
// folder dialog) can still pick a project folder by tapping. Read-only: lists
// sub-directories of `path` and never escapes above the user's home directory.
//
// `hereHasGit` tells the picker whether the CURRENT folder is a git repo, so the
// UI can say "not a git repo — will initialize" before you tap "Use this folder".

export async function GET(req: NextRequest) {
  const path = safePath(req.nextUrl.searchParams.get("path") || "");

  let names: string[];
  try {
    if (!statSync(path).isDirectory()) {
      return NextResponse.json({ error: `${path} is not a directory.` }, { status: 400 });
    }
    names = readdirSync(path);
  } catch {
    return NextResponse.json({ error: `Can't read ${path}` }, { status: 400 });
  }

  const entries = names
    .filter(name => !name.startsWith(".")) // hide dotfiles/dirs to keep the list tidy
    .map(name => {
      const full = join(path, name);
      try {
        if (!statSync(full).isDirectory()) return null; // follows symlinks → real dirs only
        return { name, path: full, hasGit: existsSync(join(full, ".git")) };
      } catch {
        return null; // unreadable (permissions) — skip
      }
    })
    .filter((e): e is { name: string; path: string; hasGit: boolean } => e !== null)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  // Parent = one level up, but never above HOME (null when we're already at HOME).
  const parent = path === HOME ? null : (() => {
    const up = dirname(path);
    return within(up, HOME) ? up : null;
  })();

  return NextResponse.json({ path, home: HOME, parent, hereHasGit: existsSync(join(path, ".git")), entries });
}
