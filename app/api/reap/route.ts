import { NextResponse } from "next/server";
import { reapTrackedDevServers, reapOrphanDevServers } from "@/app/lib/engine/devserver";
import { reapTestDrives } from "@/app/lib/engine/testdrive";

export const dynamic = "force-dynamic";

// Reap leftover spun-up things: test-drive browsers, tracked dev servers, and any
// orphaned factory dev servers that survived a restart. Never touches the factory's
// own server or unrelated apps.
export async function POST() {
  const testDrives = await reapTestDrives();   // close live Chrome windows + their dev servers
  const tracked = reapTrackedDevServers();     // kill in-memory tracked dev servers
  const orphans = await reapOrphanDevServers(); // OS sweep for survivors under factory workspaces
  const total = testDrives + tracked + orphans;
  return NextResponse.json({ ok: true, testDrives, tracked, orphans, total });
}
