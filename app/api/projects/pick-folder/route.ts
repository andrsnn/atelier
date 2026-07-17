import { NextResponse } from "next/server";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";

// Open the host OS's native folder picker and return the chosen absolute path.
// The factory runs locally, so the dialog appears on the same machine as the
// dashboard. This is the only way a browser can hand us a real filesystem path
// (a webkitdirectory <input> only exposes relative file names, never the dir's
// absolute path). macOS only for now; elsewhere, type the path into the field.
export async function POST() {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "Folder picker is macOS-only — type the directory path instead." }, { status: 400 });
  }
  const script = 'POSIX path of (choose folder with prompt "Select a project folder")';
  try {
    const path = await new Promise<string>((resolve, reject) => {
      execFile("osascript", ["-e", script], (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      });
    });
    // osascript returns the folder with a trailing slash; drop it for tidiness.
    return NextResponse.json({ path: path.replace(/\/$/, "") });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // User hit Cancel in the dialog → not an error, just nothing chosen.
    if (/-128|User canceled/i.test(msg)) return NextResponse.json({ canceled: true });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
