import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, join, relative, isAbsolute } from "path";

// Shared filesystem guards for the /api/fs/* endpoints. Everything is clamped to
// the user's home directory so the browser-based folder picker (used from a
// phone, where the native macOS dialog can't appear) can never read or mutate
// paths above $HOME.

export const HOME = (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })();

/** true when `child` is `parent` or lives somewhere under it (no `..` escape). */
export function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Expand a leading `~`, resolve, normalise through symlinks, and clamp inside
 *  HOME (returns HOME on an escape attempt). For read-only browsing. */
export function safePath(raw: string): string {
  let p = (raw || "").trim();
  if (!p) return HOME;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  p = resolve(p);
  try { p = realpathSync(p); } catch { /* may not exist — caller checks */ }
  return within(p, HOME) ? p : HOME;
}

/** Resolve a path and REJECT (throw) if it escapes HOME. For mutating ops
 *  (mkdir / git init) where silently clamping to HOME would be surprising. */
export function resolveInHome(raw: string): string {
  let p = (raw || "").trim();
  if (!p) throw new Error("A path is required.");
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  p = resolve(p);
  let real = p;
  try { real = realpathSync(p); } catch { /* may not exist yet */ }
  if (!within(real, HOME)) throw new Error("That folder is outside your home directory.");
  return real;
}

/** True if `p` is an existing directory. */
export function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
