import { NextRequest, NextResponse } from "next/server";
import { statSync } from "fs";
import { getProjects, addProject, expandHome } from "@/app/lib/projects";
import { overlapsFactory, FACTORY_ROOT } from "@/app/lib/sandbox";

export const dynamic = "force-dynamic";

// List the registered repos (same data the dashboard already gets via /api/runs).
export async function GET() {
  return NextResponse.json({ projects: getProjects() });
}

// Register a repo from the UI's "+ Add new repo…" form. The target is any
// directory on disk — it does NOT have to be a git repo (the agent works the
// codebase with generic tools). We just sanity-check the path exists and is a
// directory, then persist to atelier.projects.json.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const repoPathRaw: string = (body.repoPath || "").trim();
  if (!repoPathRaw) return NextResponse.json({ error: "A directory path is required." }, { status: 400 });

  const repoPath = expandHome(repoPathRaw);
  try {
    if (!statSync(repoPath).isDirectory()) {
      return NextResponse.json({ error: `${repoPath} is not a directory.` }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: `No such directory: ${repoPath}` }, { status: 400 });
  }
  // Never let a run target the factory's own install dir (or a parent of it): the agent
  // building/dev-serving there recursively HMR-reloads the factory and OOMs the machine.
  if (overlapsFactory(repoPath)) {
    return NextResponse.json({ error: `Refused: ${repoPath} is (or contains) the Atelier factory directory (${FACTORY_ROOT}). Pick a different folder — the agent must not build or run dev servers inside the factory install.` }, { status: 400 });
  }

  try {
    const project = addProject({ name: body.name, repoPath: repoPathRaw, baseBranch: body.baseBranch, note: body.note });
    return NextResponse.json({ project });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not add project." }, { status: 400 });
  }
}
