// A per-process id. It changes every time the server (re)starts, which is every rebuild. The
// client stores the first value it sees and compares it on each poll; when it changes, the client
// hard-reloads so a stale or suspended tab automatically picks up the new build instead of showing
// old JS/data. Server-only (imported by the run API route); never bundled into the client.
export const SERVER_BOOT_ID = String(Date.now());
