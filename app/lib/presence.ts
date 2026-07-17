/**
 * Lightweight presence — "who's on this run right now". The app is poll-based
 * (the run page GETs /api/runs/[id] every 1.5s); each poll carries the viewer's
 * display name (header `x-atelier-user`), which we record here. A name is
 * "present" if we've seen it within TTL. Ephemeral + in-memory: presence is
 * transient by nature, and the server is a single process. No DB, no websocket.
 */
const TTL_MS = 9000; // present if seen within the last ~9s (≈ 6 missed polls)

const store = new Map<string, Map<string, number>>(); // runId -> (name -> lastSeenMs)

export interface Presence { name: string; lastSeen: number }

/** Record that `name` is currently viewing `runId`. */
export function heartbeat(runId: string, name: string | null | undefined) {
  const who = (name || "").trim();
  if (!runId || !who) return;
  let m = store.get(runId);
  if (!m) { m = new Map(); store.set(runId, m); }
  m.set(who, Date.now());
}

/** The display names currently present on `runId` (self-pruning). */
export function presentUsers(runId: string): Presence[] {
  const m = store.get(runId);
  if (!m) return [];
  const cutoff = Date.now() - TTL_MS;
  const out: Presence[] = [];
  for (const [name, t] of m) {
    if (t >= cutoff) out.push({ name, lastSeen: t });
    else m.delete(name);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
