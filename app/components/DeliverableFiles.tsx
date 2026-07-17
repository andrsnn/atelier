"use client";
/**
 * The run's OUTPUT files, shown the same way in Studio and Live.
 *
 * It does NOT `ls` every file a run ever returned. It shows the agent's EXPOSED
 * final set (the expose_output tool → is_final=1); if nothing was exposed, it
 * falls back to the last loop's files (or the last returned batch for older runs).
 * Everything else collapses under "earlier versions". Each file previews inline
 * (image / video / audio / text) without a download; download stays one tap away.
 */
import { useEffect, useState } from "react";

export type Deliv = {
  id: string; filename: string; size: number; mime: string;
  label: string | null; description: string | null;
  is_final?: number; loop?: number; created_at?: number;
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function icon(mime: string) {
  if (mime?.startsWith("audio/")) return "🎵";
  if (mime?.startsWith("video/")) return "🎬";
  if (mime?.startsWith("image/")) return "🖼";
  if (/\/(json|markdown|xml|csv)$|^text\//.test(mime || "")) return "📄";
  return "📦";
}
export function canPreview(mime: string, filename: string) {
  if (/^(image|video|audio|text)\//.test(mime || "")) return true;
  if (/\/(json|markdown|xml|javascript|x-yaml|yaml|csv)$/.test(mime || "")) return true;
  return /\.(txt|md|json|csv|log|ya?ml|xml|html?|css|js|ts|tsx|py|sh|mjs)$/i.test(filename || "");
}

/** The output set to show vs. the earlier versions to collapse. Never an ls of all files. */
export function selectOutput<T extends Deliv>(deliverables: T[]): { primary: T[]; earlier: T[] } {
  if (!deliverables.length) return { primary: [], earlier: [] };
  const finals = deliverables.filter((d) => d.is_final);
  if (finals.length) return { primary: finals, earlier: deliverables.filter((d) => !d.is_final) };
  // No exposed output — fall back to the last loop, else the last returned batch.
  const maxLoop = Math.max(0, ...deliverables.map((d) => d.loop || 0));
  if (maxLoop > 0) return {
    primary: deliverables.filter((d) => (d.loop || 0) === maxLoop),
    earlier: deliverables.filter((d) => (d.loop || 0) !== maxLoop),
  };
  const newest = Math.max(...deliverables.map((d) => d.created_at || 0));
  const WINDOW = 3 * 60 * 1000; // files returned within ~3 min of the newest ≈ the last batch
  const primary = deliverables.filter((d) => (d.created_at || 0) >= newest - WINDOW);
  const earlier = deliverables.filter((d) => (d.created_at || 0) < newest - WINDOW);
  return primary.length ? { primary, earlier } : { primary: deliverables, earlier: [] };
}

function Card({ d, runId, onOpen }: { d: Deliv; runId: string; onOpen: () => void }) {
  const dl = `/api/runs/${runId}/deliverables/${d.id}`;
  const preview = canPreview(d.mime, d.filename);
  return (
    <div className="dlv-card">
      <button type="button" className="dlv-card-main" onClick={onOpen} title={preview ? "Preview" : "Open"}>
        <span className="dlv-card-ic">{icon(d.mime)}</span>
        <span className="dlv-card-meta">
          <b>{d.label || d.filename}</b>
          <span>{fmtBytes(d.size)} · {preview ? "tap to preview" : "tap to open"}</span>
          {d.description ? <span className="dlv-card-desc">{d.description}</span> : null}
        </span>
      </button>
      <a href={dl} download={d.filename} className="dlv-card-dl" title="Download" onClick={(e) => e.stopPropagation()}>⬇</a>
    </div>
  );
}

/** Full-screen inline preview — image / video / audio / text, plus Download. */
export function DeliverablePreview({ deliverable: d, runId, onClose }: { deliverable: Deliv; runId: string; onClose: () => void }) {
  const src = `/api/runs/${runId}/deliverables/${d.id}?inline=1`;
  const dl = `/api/runs/${runId}/deliverables/${d.id}`;
  const isImg = d.mime?.startsWith("image/");
  const isVid = d.mime?.startsWith("video/");
  const isAud = d.mime?.startsWith("audio/");
  const isText = !isImg && !isVid && !isAud && canPreview(d.mime, d.filename);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!isText) return;
    let alive = true;
    fetch(src).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => { if (alive) setText(t.slice(0, 200000)); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [src, isText]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dlv-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dlv-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="dlv-modal-head">
          <span className="dlv-modal-title">{d.label || d.filename}</span>
          <a href={dl} download={d.filename} className="dlv-modal-dl">⬇ Download</a>
          <button type="button" className="dlv-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dlv-modal-body">
          {isImg && <img src={src} alt={d.label || d.filename} />}
          {isVid && <video src={src} controls autoPlay playsInline />}
          {isAud && <audio src={src} controls autoPlay />}
          {isText && (err
            ? <div className="dlv-modal-note">Couldn’t load a preview — use Download.</div>
            : text === null ? <div className="dlv-modal-note">Loading…</div>
            : <pre className="dlv-modal-pre">{text}</pre>)}
          {!isImg && !isVid && !isAud && !isText && <div className="dlv-modal-note">No inline preview for this file type.<br />Use Download to open it.</div>}
        </div>
      </div>
    </div>
  );
}

export default function DeliverableFiles({ deliverables, runId }: { deliverables: Deliv[]; runId: string }) {
  const { primary, earlier } = selectOutput(deliverables);
  const [showEarlier, setShowEarlier] = useState(false);
  const [open, setOpen] = useState<Deliv | null>(null);
  if (!primary.length && !earlier.length) return null;
  return (
    <div className="dlv-files">
      <div className="dlv-files-h">The output{primary.length > 1 ? ` · ${primary.length} files` : ""}</div>
      <div className="dlv-list">
        {primary.map((d) => <Card key={d.id} d={d} runId={runId} onOpen={() => setOpen(d)} />)}
      </div>
      {earlier.length > 0 && (
        <div className="dlv-earlier">
          <button type="button" className="dlv-earlier-t" onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? "▾" : "▸"} earlier versions ({earlier.length})
          </button>
          {showEarlier && <div className="dlv-list">{earlier.map((d) => <Card key={d.id} d={d} runId={runId} onOpen={() => setOpen(d)} />)}</div>}
        </div>
      )}
      {open && <DeliverablePreview deliverable={open} runId={runId} onClose={() => setOpen(null)} />}
    </div>
  );
}
