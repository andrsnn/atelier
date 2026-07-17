import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import { getRun, getDeliverable } from "@/app/lib/db";

export const dynamic = "force-dynamic";

/**
 * Download a run DELIVERABLE — a finished file an agent returned via `return_file`.
 * Streams the PERSISTENT stored copy (not the transient worktree) with the right
 * Content-Type and `Content-Disposition: attachment` so it downloads with a clean
 * filename — works over the tailnet from a phone. Honors Range so audio/video can
 * seek if the browser asks.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  const run = getRun(id);
  if (!run) return new Response("run not found", { status: 404 });
  const d = getDeliverable(fileId);
  if (!d || d.run_id !== id) return new Response("deliverable not found", { status: 404 });

  let buf: Buffer;
  try { buf = await fs.readFile(d.stored_path); }
  catch { return new Response("file missing on disk", { status: 410 }); }

  const total = buf.length;
  // Quote-safe filename for the header; RFC5987 filename* covers unicode names too.
  const asciiName = d.filename.replace(/["\\\r\n]/g, "_");
  // ?inline=1 → render in-page (preview an image/video/text without downloading);
  // default → attachment (download with a clean filename).
  const kind = _req.nextUrl.searchParams.get("inline") ? "inline" : "attachment";
  const disposition = `${kind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`;

  const range = _req.headers.get("range");
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
        "content-type": d.mime, "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${total}`, "accept-ranges": "bytes",
        "content-disposition": disposition, "cache-control": "no-store",
      },
    });
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": d.mime, "content-length": String(total), "accept-ranges": "bytes",
      "content-disposition": disposition, "cache-control": "no-store",
    },
  });
}
