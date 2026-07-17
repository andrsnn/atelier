import { realpathSync } from "fs";
import { resolve, relative, isAbsolute } from "path";

/**
 * The Atelier factory's own install directory (where the running server + source live).
 *
 * Agent work — builds, dev servers, installs, file writes — must NEVER happen inside here
 * or under it. A run's dev server booted in the factory tree (or the factory's own dev
 * server watching a workspace nested under it) triggers recursive HMR reloads that pin the
 * CPU and OOM the machine. Run workspaces belong OUTSIDE this directory.
 */
export const FACTORY_ROOT = (() => {
  try { return realpathSync(process.cwd()); } catch { return resolve(process.cwd()); }
})();

function realResolve(p: string): string {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
}

/** true when `child` is `parent` or lives anywhere under it (no `..` escape). */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** true when `p` is the factory install dir or lives anywhere under it. */
export function isInsideFactory(p: string): boolean {
  if (!p) return false;
  return within(realResolve(p), FACTORY_ROOT);
}

/** true when `p` is the factory dir, inside it, OR an ancestor that CONTAINS it —
 *  i.e. any path whose scope overlaps the factory install. Used to reject targets. */
export function overlapsFactory(p: string): boolean {
  if (!p) return false;
  const rp = realResolve(p);
  return within(rp, FACTORY_ROOT) || within(FACTORY_ROOT, rp);
}

/** Throw if `p` is inside the factory install dir. `what` names the operation. */
export function assertOutsideFactory(p: string, what = "work"): void {
  if (isInsideFactory(p)) {
    throw new Error(
      `Refused: ${what} inside the Atelier factory directory (${FACTORY_ROOT}) is not allowed. ` +
      `Building or serving in the factory tree causes recursive dev-server reloads and can OOM the machine. ` +
      `Point the run at a folder OUTSIDE the factory install, and set FACTORY_WORKSPACES_DIR to a location outside it.`
    );
  }
}
