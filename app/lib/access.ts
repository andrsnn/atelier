// Shared helper for the optional ACCESS_PASSWORD gate (see middleware.ts).
// Edge-safe: uses only Web Crypto, so the SAME derivation runs in both the
// middleware (which checks the cookie) and the /api/access route (which sets it).
export const ACCESS_COOKIE = "atelier_access";

/** A non-reversible token derived from the password. The cookie stores THIS, never
 *  the password itself; the middleware re-derives it from ACCESS_PASSWORD and
 *  compares, so a stolen cookie never reveals the password. */
export async function accessToken(password: string): Promise<string> {
  const data = new TextEncoder().encode("atelier:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
