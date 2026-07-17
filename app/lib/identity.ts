/**
 * Lightweight client identity — a display name kept in localStorage. No auth, no
 * accounts: the board is shared (one optional password), and this just lets each
 * person sign their comments and show up in presence. Sent to the server as the
 * `x-atelier-user` header on polls and as `author` on comments.
 */
const KEY = "atelier.name";

export function getMyName(): string {
  try { return (localStorage.getItem(KEY) || "").trim(); } catch { return ""; }
}

export function setMyName(name: string): string {
  const n = name.trim().slice(0, 40);
  try { localStorage.setItem(KEY, n); } catch { /* ignore */ }
  return n;
}

/** A stable color for an author name (deterministic hash → hue). */
export function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 42%)`;
}

/** Initials for an avatar chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}
