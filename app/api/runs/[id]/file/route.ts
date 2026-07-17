import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import { resolve, join, extname, basename } from "path";
import { getRun } from "@/app/lib/db";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
};

/** Serve a capture (screenshot/video) from a run's workspace. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return new Response("not found", { status: 404 });
  const p = req.nextUrl.searchParams.get("p") || "";
  const abs = resolve(join(run.workspace, p));
  if (!abs.startsWith(resolve(run.workspace))) return new Response("forbidden", { status: 403 });
  let buf: Buffer;
  try { buf = await fs.readFile(abs); }
  catch { return new Response("not found", { status: 404 }); }

  const type = TYPES[extname(abs).toLowerCase()] || "application/octet-stream";
  const total = buf.length;

  // A <video> element needs Content-Length + byte-range support to read duration,
  // seek, and play — without it the player just sits at 0:00 / 0:00. Honor Range
  // requests with 206 Partial Content; always advertise Accept-Ranges + a length.
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === "" ? 0 : parseInt(m[1], 10);
    let end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total)
      return new Response("range not satisfiable", { status: 416, headers: { "content-range": `bytes */${total}`, "accept-ranges": "bytes" } });
    end = Math.min(end, total - 1);
    const slice = buf.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        "content-type": type, "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${total}`, "accept-ranges": "bytes", "cache-control": "no-store",
      },
    });
  }
  // Non-media files (zips, csv, …) are downloads — give them a proper filename instead of
  // saving as "file". Media (png/mp4/…) stays inline so the run page can embed it.
  const download = !(extname(abs).toLowerCase() in TYPES);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": type, "content-length": String(total), "accept-ranges": "bytes", "cache-control": "no-store",
      ...(download ? { "content-disposition": `attachment; filename="${basename(abs).replace(/"/g, "")}"` } : {}),
    },
  });
}
