import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { prepareAndOpen, stopTestDrive } from "@/app/lib/engine/testdrive";
import { emitLog } from "@/app/lib/engine/runner";
import { getRun, listEvents } from "@/app/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// "Test it": boot the app, restore login, open a real Chrome + a LAN URL.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prepareAndOpen(id, (s) => emitLog(id, s));
  // surface the test login the agent used so the human can sign in too.
  let creds: { email: string; password: string; loginUrl?: string } | null = null;
  const run = getRun(id);
  // 1) the creds file authenticate saves (runs authenticated after this shipped)
  try { if (run) creds = JSON.parse(await fs.readFile(join(run.workspace, ".captures", "auth-creds.json"), "utf8")); } catch { /* none */ }
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  // 2) fallback: the app's E2E TEST creds (what the agent signs in with). ONLY the test
  //    env files + ONLY the TEST_EMAIL/PASSWORD keys — never .env.local/.env real secrets.
  if (!creds && run) {
    for (const f of [".env.test", ".env.test.local"]) {
      try {
        const txt = await fs.readFile(join(run.workspace, f), "utf8");
        const em = txt.match(/^(?:E2E_)?TEST_EMAIL=(.+)$/m);
        const pw = txt.match(/^(?:E2E_)?TEST_PASSWORD=(.+)$/m);
        if (em && pw) { creds = { email: clean(em[1]), password: clean(pw[1]) }; break; }
      } catch { /* no such file */ }
    }
  }
  // 3) last resort: the explicit authenticate command in the events
  if (!creds) {
    const evs = listEvents(id);
    for (let i = evs.length - 1; i >= 0 && !creds; i--) {
      const blob = typeof (evs[i] as any).content === "string" ? (evs[i] as any).content : JSON.stringify((evs[i] as any).content);
      const em = blob.match(/--email[=\s]+"?([^\s"\\]+)/) || blob.match(/(?:E2E_)?TEST_EMAIL=([^\s\\"]+)/);
      const pw = blob.match(/--password[=\s]+"?([^\s"\\]+)/) || blob.match(/(?:E2E_)?TEST_PASSWORD=([^\s\\"]+)/);
      if (em && pw) creds = { email: clean(em[1]), password: clean(pw[1]) };
    }
  }
  return NextResponse.json({ ...r, creds }, { status: r.ok ? 200 : 400 });
}

// Stop testing: close the browser, the LAN proxy, and the dev server.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await stopTestDrive(id);
  emitLog(id, "Stopped the test server.");
  return NextResponse.json({ ok: true });
}
