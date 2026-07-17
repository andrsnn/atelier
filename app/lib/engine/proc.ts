import type { ChildProcess } from "child_process";

/** Kill a child process AND all its descendants.
 *
 *  We drive models through launchers — `ollama launch claude` forks a child `claude`, which
 *  in turn does the work. SIGKILL on just the top process orphans the children: they keep
 *  running and keep the stdout pipe open, so the ChildProcess "close" event never fires and
 *  whoever is awaiting the call hangs forever (this is why the Conductor "Stop" / phase
 *  pause appeared to do nothing).
 *
 *  Spawn the child with { detached: true } so it leads its own process GROUP, then signal
 *  the whole group via the negative pid. Falls back to killing just the parent if the group
 *  signal isn't possible (e.g. spawn failed, or it wasn't detached). */
export function killTree(cp: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (!cp.pid) { try { cp.kill(signal); } catch {} return; }
  try { process.kill(-cp.pid, signal); }      // whole process group (requires a detached spawn)
  catch { try { cp.kill(signal); } catch {} } // fallback: at least the parent
}
