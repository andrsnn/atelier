/**
 * Project registry. A project is just a directory + the branch to cut work from.
 * The factory is repo-AGNOSTIC — these are conveniences for the picker, not
 * special cases. You can run a goal against any directory path; the agent figures
 * out the codebase with its generic tools. It need not even be a git repo.
 *
 * Projects live in `atelier.projects.json` (repo root, gitignored) so you point at
 * YOUR repos without editing source. See atelier.projects.example.json. The file is
 * read fresh on every access, so entries added through the UI (POST /api/projects →
 * addProject) show up immediately — no server restart needed.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
/** How QA brings up + signs into a project. Human-configured (settings), used by
 *  the agent — the engine never logs in deterministically; it hands the agent the
 *  recipe + a tool. Mirrors the original factory's stage auth config. */
export interface ProjectAuth {
  loginPath: string;          // e.g. /auth/login
  emailEnv?: string;          // env var in the repo (.env.test) holding the test email
  passwordEnv?: string;
  email?: string;             // …or a literal test email/password (less preferred)
  password?: string;
  authedRoutes?: string[];    // protected routes to verify/record, e.g. /dashboard
}
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  note?: string;
  devCommand?: string;        // default: npm run dev
  /** Command(s) to bring the app's backend up before QA (e.g. start Supabase + seed). */
  setupCommand?: string;
  /** Login recipe for auth-walled apps. */
  auth?: ProjectAuth;
}

const PROJECTS_FILE = () => join(process.cwd(), "atelier.projects.json");

// Read fresh from atelier.projects.json (gitignored) on every call. The file is
// tiny and reads are infrequent (picker + run creation), so there's no cache to
// invalidate when the UI adds a project.
function loadProjects(): Project[] {
  try {
    const arr = JSON.parse(readFileSync(PROJECTS_FILE(), "utf8"));
    if (Array.isArray(arr)) return arr as Project[];
    console.error("atelier.projects.json: expected a JSON array");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.error("atelier.projects.json:", e instanceof Error ? e.message : e);
  }
  return []; // none configured yet — copy atelier.projects.example.json → atelier.projects.json
}

export function getProjects(): Project[] {
  return loadProjects();
}

export function getProject(id: string): Project | undefined {
  return loadProjects().find(p => p.id === id);
}
export function getProjectByRepoPath(repoPath: string | null | undefined): Project | undefined {
  if (!repoPath) return undefined;
  return loadProjects().find(p => p.repoPath === repoPath);
}

/** Expand a leading `~` to the user's home dir so people can type `~/code/app`. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Append a project to atelier.projects.json and return it. Throws on bad input
 * or a duplicate repoPath. The id is derived from the name (or the directory's
 * basename) and made unique. The caller is responsible for any path validation
 * (e.g. the directory exists) — this just persists config.
 */
export function addProject(input: { name?: string; repoPath: string; baseBranch?: string; note?: string }): Project {
  const repoPath = expandHome((input.repoPath || "").trim());
  if (!repoPath) throw new Error("repoPath is required");
  const projects = loadProjects();
  if (projects.some(p => p.repoPath === repoPath)) throw new Error(`A project already points at ${repoPath}`);

  const name = (input.name || "").trim() || repoPath.split("/").filter(Boolean).pop() || "project";
  const base = slug(name) || "project";
  let id = base;
  for (let n = 2; projects.some(p => p.id === id); n++) id = `${base}-${n}`;

  const project: Project = {
    id,
    name,
    repoPath,
    baseBranch: (input.baseBranch || "").trim() || "main",
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  writeFileSync(PROJECTS_FILE(), JSON.stringify([...projects, project], null, 2) + "\n", "utf8");
  return project;
}
