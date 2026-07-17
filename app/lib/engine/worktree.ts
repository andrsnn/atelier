/**
 * Per-run git worktree. A run that targets a repo gets an isolated worktree cut
 * from the base branch, on its own feature branch, so the agent works on the
 * REAL code without touching the user's checkout. node_modules is symlinked from
 * the repo when present (fast); otherwise the agent installs deps itself. Fully
 * repo-agnostic — no project-specific logic.
 */
import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";

function sh(cmd: string, cwd?: string, timeout = 180000): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    exec(cmd, { cwd, timeout, maxBuffer: 1 << 24 }, (err, so, se) =>
      res({ ok: !err, out: (so || "") + (se ? `\n${se}` : "") }));
  });
}

export interface WorktreeInfo { workspace: string; branch: string }

export async function setupWorktree(opts: {
  repoPath: string; baseBranch: string; runId: string; workspace: string;
  log?: (s: string) => void;
}): Promise<WorktreeInfo> {
  const { repoPath, baseBranch, runId, workspace } = opts;
  const log = opts.log || (() => {});
  const branch = `factory/${runId}`;

  // Make sure the base ref exists locally; fetch is best-effort.
  await sh(`git fetch --all --quiet`, repoPath, 60000).catch(() => {});

  // Remove any stale worktree/branch from a previous attempt with this id.
  await sh(`git worktree remove --force ${JSON.stringify(workspace)}`, repoPath).catch(() => {});
  await sh(`git branch -D ${branch}`, repoPath).catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  log(`creating worktree on ${branch} from ${baseBranch}…`);
  let r = await sh(`git worktree add -b ${branch} ${JSON.stringify(workspace)} ${JSON.stringify(baseBranch)}`, repoPath);
  if (!r.ok) {
    // base branch might be remote-only or named differently — try origin/<base>.
    r = await sh(`git worktree add -b ${branch} ${JSON.stringify(workspace)} ${JSON.stringify("origin/" + baseBranch)}`, repoPath);
  }
  if (!r.ok) throw new Error(`worktree add failed: ${r.out.slice(0, 400)}`);

  // Symlink node_modules from the repo if present (so the app can build/run fast).
  try {
    await fs.access(join(repoPath, "node_modules"));
    await fs.symlink(join(repoPath, "node_modules"), join(workspace, "node_modules"), "dir").catch(() => {});
    log(`linked node_modules from ${repoPath}`);
  } catch { log(`no node_modules in repo — the agent can run an install if it needs one`); }

  // Carry over local env files the dev server needs (never committed).
  for (const f of [".env", ".env.local", ".env.test", ".env.test.local", ".env.development.local"]) {
    try { await fs.copyFile(join(repoPath, f), join(workspace, f)); } catch { /* not present */ }
  }

  return { workspace, branch };
}

export async function removeWorktree(repoPath: string, workspace: string, branch?: string) {
  await sh(`git worktree remove --force ${JSON.stringify(workspace)}`, repoPath).catch(() => {});
  if (branch) await sh(`git branch -D ${branch}`, repoPath).catch(() => {});
}

/** A compact `git diff` of the run's work, for context + deliverables. */
export async function gitDiffStat(workspace: string): Promise<string> {
  const a = await sh(`git add -A && git diff --cached --stat`, workspace);
  return a.out.trim() || "(no changes yet)";
}
