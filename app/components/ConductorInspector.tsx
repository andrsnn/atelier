"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown, InlineMD, AutopilotSelect, autopilotOf } from "./ui";

// The Conductor panel: chat on the left, the run's activity log on the right with a
// "since you last checked in" summary generated when you open it. An observability
// layer over data the run page already has — no stage-specific logic.

interface Ev { id: string; state: string; type: string; content: string; created_at: number }
interface CMsg { id: string; role: "you" | "conductor" | "system"; body: string; directive: string | null; status: string; image: string | null; created_at: number }
interface StateDef { id: string; name: string }
interface Machine { states: StateDef[] }
interface Run { id: string; goal: string; title: string; status: string; loop_count: number; conductor_mode: "propose" | "auto" | null; conductor_react: "auto" | "manual" | null }

type Src = "build" | "qa" | "cond" | "system" | "pass";
interface Item { key: string; src: Src; tag: string; text: string; thinking?: string; ts: number }

const MK: Record<Src, string> = { build: "✎", qa: "↻", cond: "◆", system: "•", pass: "✓" };

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// A stored `image` field is a JSON array of data URLs (tolerates a legacy single one).
function parseImgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw[0] === "[") { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [raw];
}

// A Conductor message may carry a directive (JSON) the human can approve/dismiss —
// either a route (re-run a phase of this run) or a proposed edit to the loop template.
function dirOf(m: CMsg): { action?: string; targetName?: string; loopEdit?: { summary?: string } } | null {
  if (!m.directive) return null;
  try { return JSON.parse(m.directive); } catch { return null; }
}

// Infra/system noise that must never render as a chat/log item: whole-line bracketed system logs
// (e.g. "[Session unusable, compacting it with the coding model to seed a fresh one]") and
// model-call/ollama connection errors. Conservative: only clear system noise, not real content.
function isInfraNoise(s: string): boolean {
  const t = String(s || "").trim();
  if (!t) return false;
  if (/^\[[^\]]*\]$/.test(t)) return true;
  return /could not connect to ollama|ollama serve|the model call produced no answer/i.test(t);
}

/** Turn the run's raw events + Conductor messages into milestone-level log items —
 *  the process and the model's own reasoning, never tool calls or shell commands. */
function buildItems(events: Ev[], conductor: CMsg[], machine: Machine): Item[] {
  const nameOf = (sid: string) => machine.states.find(s => s.id === sid)?.name || sid;
  const out: Item[] = [];
  for (const e of events) {
    let c: any = {}; try { c = JSON.parse(e.content); } catch { /* ignore */ }
    const nm = nameOf(e.state);
    switch (e.type) {
      case "state_enter": out.push({ key: e.id, src: "system", tag: nm, text: `Started ${nm}.`, ts: e.created_at }); break;
      case "reject": out.push({ key: e.id, src: "qa", tag: `${nm} · rejected`, text: String(c.reasons || "Sent it back."), ts: e.created_at }); break;
      case "approval_request": out.push({ key: e.id, src: "build", tag: `${nm} · ready`, text: String(c.summary || "Asked for approval."), ts: e.created_at }); break;
      case "approved": out.push({ key: e.id, src: "pass", tag: nm, text: String(c.message || "Approved."), ts: e.created_at }); break;
      case "done": out.push({ key: e.id, src: "pass", tag: nm, text: String(c.summary || c.message || "Finished."), ts: e.created_at }); break;
      case "feedback": out.push({ key: e.id, src: "system", tag: "feedback", text: String(c.message || ""), ts: e.created_at }); break;
      case "artifact": out.push({ key: e.id, src: "build", tag: `${nm} · made`, text: `Produced “${c.name}”.`, ts: e.created_at }); break;
      case "reflect": { // only the substantive "learned N principle(s)" entries — not the
        // "Reflect & Record — learning…/no durable lesson" status markers (pure noise).
        const msg = String(c.message || "");
        if (!/new principle/i.test(msg)) break;
        out.push({ key: e.id, src: "cond", tag: "learned", text: msg, ts: e.created_at }); break;
      }
      case "error": { const msg = String(c.message || ""); if (isInfraNoise(msg)) break; out.push({ key: e.id, src: "qa", tag: "error", text: msg, ts: e.created_at }); break; }
      case "text": {
        if (c.channel === "log") break; // system log line, not the model's words
        const t = String(c.text || "").replace(/\s+/g, " ").trim();
        if (isInfraNoise(t)) break; // drop bracketed system logs / connection noise
        if (t.length > 24) out.push({ key: e.id, src: "build", tag: `${nm} · note`, text: t.slice(0, 240), ts: e.created_at });
        break;
      }
    }
  }
  for (const m of conductor) {
    if (m.role === "system") continue;
    if (isInfraNoise(m.body)) continue; // never surface infra/system noise as a Conductor message
    out.push({ key: "c" + m.id, src: m.role === "you" ? "system" : "cond", tag: m.role === "you" ? "you" : "Conductor", text: m.body, ts: m.created_at });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Collapse a long block to a few lines with a "Show more" toggle. Keeps the verbose
 *  Conductor reasoning from becoming a wall of text — measures real height, so short
 *  messages are untouched and only genuinely long ones get an expander. */
function Clamp({ collapsedPx = 176, children }: { collapsedPx?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > collapsedPx + 12);
    check();
    const ro = new ResizeObserver(check); ro.observe(el);
    return () => ro.disconnect();
  }, [collapsedPx]);
  const clamp = overflowing && !expanded;
  return (
    <div className="ci-clamp">
      <div ref={ref} className={`ci-clampbody${clamp ? " clamped" : ""}`} style={clamp ? { maxHeight: collapsedPx } : undefined}>
        {children}
      </div>
      {overflowing && <button className="ci-more" onClick={() => setExpanded(v => !v)}>{expanded ? "Show less" : "Show more"}</button>}
    </div>
  );
}

export default function ConductorInspector({
  runId, run, events, conductor, machine, working, onClose, onChanged,
}: {
  runId: string; run: Run; events: Ev[]; conductor: CMsg[]; machine: Machine; working: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const SEEN_KEY = `atelier:lastseen:${runId}`;
  // The divider point: everything after `prevSeen` is "new since your last visit". Captured
  // once on open; we then mark now as seen so the next open re-draws the line.
  const [prevSeen] = useState<number>(() => { try { return Number(localStorage.getItem(SEEN_KEY) || 0); } catch { return 0; } });
  const [summary, setSummary] = useState<string>("");
  const [summarizing, setSummarizing] = useState(true);
  const [newCount, setNewCount] = useState<number>(0);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Attach one or MORE images to a Conductor message — file picker (multi) or paste (⌘V / Ctrl+V).
  const addFile = (file: File | null | undefined) => {
    if (!file || !file.type?.startsWith("image/")) return;
    const r = new FileReader(); r.onload = () => setImages(prev => [...prev, String(r.result)]); r.readAsDataURL(file);
  };
  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault(): void }) => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
    if (items.length) { e.preventDefault(); items.forEach(it => addFile(it.getAsFile())); }
  };

  const items = useMemo(() => buildItems(events, conductor, machine), [events, conductor, machine]);
  const latestTs = items.length ? items[items.length - 1].ts : Date.now();

  // Fire the catch-up summary when the panel opens, scoped to events since your last visit.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/runs/${runId}/conductor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "catchUp", sinceTs: prevSeen }) });
        const d = await r.json().catch(() => ({}));
        if (alive) { setSummary(d.summary || ""); setNewCount(d.newCount || 0); }
      } finally { if (alive) setSummarizing(false); }
    })();
    // Mark "seen up to now" so re-opening later re-draws the "new since" line correctly.
    try { localStorage.setItem(SEEN_KEY, String(latestTs)); } catch { /* ignore */ }
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight; }, [conductor.length]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);

  async function conductorPost(action: string, extra: Record<string, unknown> = {}) {
    setActing(true);
    await fetch(`/api/runs/${runId}/conductor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) }).catch(() => {});
    setActing(false);
    onChanged();
  }
  async function send(msg?: string) {
    // canned quick-reply chips pass their own text and carry no attachments.
    const canned = msg != null;
    const t = (msg ?? text).trim();
    const imgs = canned ? [] : images;
    if ((!t && !imgs.length) || sending) return;
    setSending(true); setText("");
    if (!canned) setImages([]);
    await conductorPost("talk", { text: t, images: imgs });
    setSending(false);
  }
  async function runAction(action: string, extra: Record<string, unknown> = {}) {
    await fetch(`/api/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) }).catch(() => {});
    onChanged();
  }

  const firstNewIdx = items.findIndex(it => it.ts > prevSeen);
  const hasNew = firstNewIdx >= 0 && prevSeen > 0;
  // Render newest-first.
  const ordered = [...items].reverse();
  const dividerAtNewest = hasNew; // if there are new items, they sit at the top

  return (
    <div className="ci-scrim" onClick={onClose}>
      <style>{CSS}</style>
      <div className="ci-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Conductor — chat and activity">
        <div className="ci-head">
          <div className="ci-badge lg">◆</div>
          <div style={{ minWidth: 0 }}>
            <div className="ci-ti">Conductor</div>
            <div className="ci-sub">chat &amp; activity · “{run.title || run.goal}”</div>
          </div>
          {(run.loop_count ?? 0) > 0 && <span className="ci-chip loop">↻ {run.loop_count} loops</span>}
          <button className="ci-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ci-body">
          {/* LEFT — chat */}
          <div className="ci-pane left">
            <div className="ci-paneh"><span className="ci-badge sm">◆</span><span className="ci-lbl">Chat</span>{working && <span className="ci-r">thinking…</span>}</div>
            <div className="ci-chat" ref={chatRef}>
              {conductor.length === 0 && <div className="ci-empty">Ask the Conductor why it’s looping, nudge it toward a different fix, or just check in.</div>}
              {conductor.map(m => (
                <div key={m.id} className={`ci-msg ${m.role}`}>
                  {m.role !== "system" && <div className={`ci-av ${m.role}`}>{m.role === "you" ? "You" : "◆"}</div>}
                  <div style={{ minWidth: 0 }}>
                    {m.role === "system"
                      ? <div className="ci-sys">{m.body}</div>
                      : <>
                          <div className={`ci-who ${m.role === "conductor" ? "c" : ""}`}>{m.role === "you" ? "You" : "Conductor"}<span className="t">{timeAgo(m.created_at)}</span></div>
                          {m.body && <div className={`ci-say ${m.role === "you" ? "you" : ""}`}>{m.role === "you" ? <Markdown>{m.body}</Markdown> : <Clamp><Markdown>{m.body}</Markdown></Clamp>}</div>}
                          {parseImgs(m.image).length > 0 && <div className="ci-msgimgs">{parseImgs(m.image).map((src, i) => <img key={i} src={src} alt="" />)}</div>}
                          {(() => { const d = dirOf(m); const isEdit = d?.action === "edit_loop";
                            // A loop edit rewrites the reusable loop TEMPLATE (every future run), so confirm
                            // before copying the proposed edits over. A route just re-runs the current run.
                            const applyEdit = () => { if (confirm("Copy these loop edits to the loop template?\n\nThis updates the loop itself — every future run of this loop will use the edited phases. It does not change the current run.")) conductorPost("apply", { messageId: m.id }); };
                            if (d && m.status === "proposed") return (
                              <div className="ci-dir">
                                <button className="ci-approve" disabled={acting} onClick={() => isEdit ? applyEdit() : conductorPost("apply", { messageId: m.id })}>{isEdit ? "✓ Apply to loop template" : `✓ Approve → ${d.targetName}`}</button>
                                <button className="ci-dismiss" disabled={acting} onClick={() => conductorPost("dismiss", { messageId: m.id })}>Dismiss</button>
                              </div>);
                            if (m.status === "applied") return <div className="ci-drouted">{isEdit ? "✓ loop template updated" : `✓ routed${d?.targetName ? ` to ${d.targetName}` : ""}`}</div>;
                            if (m.status === "dismissed") return <div className="ci-ddismissed">dismissed</div>;
                            return null; })()}
                        </>}
                  </div>
                </div>
              ))}
              {working && <div className="ci-msg conductor"><div className="ci-av conductor">◆</div><div className="ci-say" style={{ opacity: .7 }}><span className="ci-dots">looking things over</span></div></div>}
            </div>
            <div className="ci-composer">
              <div className="ci-quick">
                {run.status === "running" && <button className="ci-qc ghost" onClick={() => runAction("pause")}>⏸ Pause the run</button>}
                {run.status === "paused" && <button className="ci-qc ghost" onClick={() => runAction("resume")}>▶ Resume</button>}
              </div>
              {images.length > 0 && (
                <div className="ci-imgs">
                  {images.map((img, i) => (
                    <span key={i} className="ci-thumb">
                      <img src={img} alt="" />
                      <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))} title="Remove" aria-label="Remove image">✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="ci-crow">
                <label className="ci-attach" title="Attach image(s) — or paste with ⌘V / Ctrl+V">📎
                  <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { [...(e.target.files || [])].forEach(f => addFile(f)); e.currentTarget.value = ""; }} />
                </label>
                <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} onPaste={onPaste} placeholder="Message the Conductor — ⌘↵ or tap Send" />
                <button className="ci-send" onClick={() => send()} disabled={sending || (!text.trim() && !images.length)}>Send</button>
              </div>
            </div>
          </div>

          {/* RIGHT — activity */}
          <div className="ci-pane right">
            <div className="ci-paneh"><span className="ci-lbl">Activity</span><span className="ci-r">{summarizing ? "catching up…" : "↻ caught up · just now"}</span></div>
            <div className="ci-act">
              <div className="ci-summary">
                <div className="ci-sr"><div className="ci-badge sm">◆</div><span className="ci-st">Since you last checked in</span></div>
                <p>{summarizing ? <span className="ci-dots">Reading what happened while you were away</span> : (summary || "Nothing new since you last looked.")}</p>
                {!summarizing && newCount > 0 && <div className="ci-sf">{newCount} new event{newCount === 1 ? "" : "s"} below</div>}
              </div>

              {ordered.length === 0 && <div className="ci-empty" style={{ marginTop: 16 }}>No activity yet.</div>}
              {ordered.map((it, i) => {
                // Insert the "new / earlier" divider at the boundary (rendering newest-first).
                const isNew = prevSeen > 0 && it.ts > prevSeen;
                const prevWasNew = i > 0 && prevSeen > 0 && ordered[i - 1].ts > prevSeen;
                const showNewTop = i === 0 && isNew;
                const showEarlier = !isNew && (i === 0 || prevWasNew) && prevSeen > 0;
                return (
                  <div key={it.key}>
                    {showNewTop && <div className="ci-div"><span className="pl">New since your last visit</span><span className="ln" /></div>}
                    {showEarlier && <div className="ci-div old"><span className="pl">Earlier</span><span className="ln" /></div>}
                    <div className={`ci-le ${it.src} ${isNew ? "" : (prevSeen > 0 ? "faded" : "")}`}>
                      <div className="ci-mk">{MK[it.src]}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="ci-top"><span className="ci-tag">{it.tag}</span><span className="ci-when">{timeAgo(it.ts)}</span></div>
                        <div className="ci-txt"><Clamp collapsedPx={132}><InlineMD>{it.text}</InlineMD></Clamp></div>
                        {it.thinking && <div className="ci-think">{it.thinking}</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.ci-scrim{position:fixed;inset:0;background:rgba(26,24,20,.42);z-index:80;display:grid;place-items:center;padding:20px;}
.ci-modal{width:1080px;max-width:100%;height:min(680px,calc(100vh - 40px));background:var(--surface);border:1px solid var(--rule);border-radius:18px;
  box-shadow:0 8px 20px rgba(26,24,20,.16),0 40px 90px -20px rgba(26,24,20,.42);display:flex;flex-direction:column;overflow:hidden;}
.ci-head{display:flex;align-items:center;gap:11px;padding:13px 16px;border-bottom:1px solid var(--rule);background:linear-gradient(180deg,var(--cond-tint,#efe8fb),transparent);}
.ci-badge{border-radius:7px;background:var(--cond,#5848a0);color:#fff;display:grid;place-items:center;flex:0 0 auto;}
.ci-badge.lg{width:32px;height:32px;font-size:16px;box-shadow:0 0 0 3px var(--cond-tint,#efe8fb);}
.ci-badge.sm{width:18px;height:18px;font-size:10px;}
.ci-ti{font-family:var(--font-display);font-size:16px;font-weight:600;}
.ci-sub{font-size:11.5px;color:var(--ink-dim);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:460px;}
.ci-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:12px;border:1px solid var(--rule);background:var(--surface-2);color:var(--ink-soft);}
.ci-chip.loop{margin-left:auto;color:var(--warning);border-color:color-mix(in srgb,var(--warning) 36%,transparent);background:var(--warning-tint);font-weight:600;}
.ci-x{margin-left:12px;color:var(--ink-dim);font-size:14px;cursor:pointer;border:1px solid var(--rule);border-radius:8px;width:30px;height:30px;display:grid;place-items:center;background:var(--surface);}
.ci-x:hover{border-color:var(--ink-dim);}
.ci-body{flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0;min-width:0;}
.ci-pane{display:flex;flex-direction:column;min-height:0;min-width:0;}
.ci-pane.left{border-right:1px solid var(--rule);}
.ci-paneh{display:flex;align-items:center;gap:8px;padding:10px 15px 9px;border-bottom:1px solid var(--rule-soft);}
.ci-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--ink-dim);}
.ci-r{margin-left:auto;font-size:11px;color:var(--cond,#5848a0);font-weight:600;font-family:var(--font-mono);}
.ci-chat{flex:1;overflow-y:auto;padding:16px 16px;display:flex;flex-direction:column;gap:18px;}
.ci-empty{font-size:12.5px;color:var(--ink-dim);line-height:1.5;}
.ci-msg{display:flex;gap:10px;}
.ci-av{width:26px;height:26px;border-radius:7px;flex:0 0 auto;display:grid;place-items:center;font-size:11px;font-weight:700;}
.ci-av.you{background:var(--surface-3,#f3ecdd);color:var(--ink-soft);border:1px solid var(--rule);}
.ci-av.conductor{background:var(--cond,#5848a0);color:#fff;}
.ci-who{font-size:11.5px;font-weight:700;margin-bottom:3px;color:var(--ink);}
.ci-who.c{color:var(--cond,#5848a0);}
.ci-who .t{font-weight:400;color:var(--ink-dim);font-size:10.5px;margin-left:6px;font-family:var(--font-mono);}
.ci-say{font-size:13px;line-height:1.62;color:var(--ink-soft);overflow-wrap:anywhere;min-width:0;}
.ci-say.you{color:var(--ink);}
.ci-say .prose-doc{font-size:13px;line-height:1.62;color:inherit;max-width:none;}
.ci-clamp{min-width:0;}
.ci-clampbody.clamped{overflow:hidden;-webkit-mask-image:linear-gradient(180deg,#000 60%,transparent);mask-image:linear-gradient(180deg,#000 60%,transparent);}
.ci-more{margin-top:5px;border:none;background:none;color:var(--cond,#5848a0);font-size:11.5px;font-weight:600;cursor:pointer;padding:2px 0;font-family:inherit;}
.ci-more:hover{text-decoration:underline;}
.ci-say .prose-doc p{margin:.35rem 0;} .ci-say .prose-doc p:first-child{margin-top:0;} .ci-say .prose-doc p:last-child{margin-bottom:0;}
.ci-say .prose-doc ul,.ci-say .prose-doc ol{margin:.35rem 0;padding-left:1.25rem;} .ci-say .prose-doc li{margin:.15rem 0;}
.ci-say .prose-doc pre{margin:.4rem 0;font-size:11.5px;}
.ci-modes{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--rule-soft);background:var(--surface-2);}
.ci-dir{display:flex;gap:6px;margin-top:9px;}
.ci-approve{border:1px solid var(--success,#2f855a);background:var(--success,#2f855a);color:#fff;border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;}
.ci-dismiss{border:1px solid var(--rule);background:var(--surface);color:var(--ink-soft);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;}
.ci-approve:disabled,.ci-dismiss:disabled{opacity:.5;cursor:default;}
.ci-drouted{margin-top:6px;font-size:11.5px;color:var(--success,#2f855a);font-weight:600;}
.ci-ddismissed{margin-top:6px;font-size:11.5px;color:var(--ink-dim);}
.ci-sys{font-size:11.5px;color:var(--ink-dim);font-style:italic;padding:2px 0;}
.ci-composer{border-top:1px solid var(--rule);padding:10px 13px;background:var(--surface-2);}
.ci-quick{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;}
.ci-qc{font-size:11.5px;padding:4px 10px;border-radius:8px;border:1px solid var(--rule);background:var(--surface);color:var(--ink-soft);cursor:pointer;font-weight:500;font-family:inherit;}
.ci-qc:hover{border-color:var(--ink-dim);}
.ci-crow{display:flex;gap:8px;align-items:center;}
.ci-crow input[type=text],.ci-crow input:not([type]){flex:1;min-width:0;border:1px solid var(--rule);background:var(--surface);border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;color:var(--ink);outline:none;}
.ci-crow input:focus{border-color:var(--cond,#5848a0);box-shadow:0 0 0 3px var(--cond-tint,#efe8fb);}
.ci-attach{flex:0 0 auto;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--rule);border-radius:10px;background:var(--surface);cursor:pointer;font-size:15px;}
.ci-attach:hover{border-color:var(--ink-dim);}
.ci-imgs{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:8px;}
.ci-thumb{position:relative;display:inline-block;}
.ci-thumb img{height:44px;border-radius:6px;border:1px solid var(--rule);display:block;}
.ci-thumb button{position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:999px;border:1px solid var(--rule);background:var(--surface);cursor:pointer;font-size:10px;line-height:1;padding:0;color:var(--ink-soft);}
.ci-msgimgs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
.ci-msgimgs img{max-width:180px;max-height:150px;border-radius:7px;border:1px solid var(--rule);display:block;}
.ci-send{border:1px solid var(--cond,#5848a0);background:var(--cond,#5848a0);color:#fff;border-radius:10px;padding:0 15px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;flex:0 0 auto;height:36px;}
.ci-send:disabled{opacity:.5;cursor:default;}
.ci-act{flex:1;overflow-y:auto;padding:12px 15px 14px;}
.ci-summary{padding:13px 15px;border-radius:12px;background:linear-gradient(180deg,var(--cond-tint,#efe8fb),var(--surface) 92%);border:1px solid var(--cond-rule,#d8ccf2);}
.ci-sr{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.ci-st{font-size:11px;font-weight:700;color:var(--cond,#5848a0);}
.ci-summary p{margin:0;font-size:12.5px;line-height:1.55;color:var(--ink-soft);overflow-wrap:anywhere;}
.ci-sf{margin-top:9px;padding-top:8px;border-top:1px dashed var(--cond-rule,#d8ccf2);font-size:11px;color:var(--cond,#5848a0);font-weight:600;}
.ci-div{display:flex;align-items:center;gap:9px;margin:15px 0 6px;}
.ci-div .ln{flex:1;height:1px;background:var(--cond-rule,#d8ccf2);}
.ci-div .pl{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;color:var(--cond,#5848a0);background:var(--cond-tint,#efe8fb);border:1px solid var(--cond-rule,#d8ccf2);border-radius:999px;padding:2px 9px;}
.ci-div.old .ln{background:var(--rule-soft);}
.ci-div.old .pl{color:var(--ink-dim);background:var(--surface-2);border-color:var(--rule-soft);}
.ci-le{display:flex;gap:11px;padding:14px 0;border-bottom:1px solid var(--rule-soft);}
.ci-le.faded{opacity:.55;}
.ci-mk{width:19px;height:19px;border-radius:6px;flex:0 0 auto;display:grid;place-items:center;font-size:10px;font-weight:700;margin-top:1px;}
.ci-le.build .ci-mk{background:var(--surface-3,#f3ecdd);color:var(--ink-soft);border:1px solid var(--rule);}
.ci-le.qa .ci-mk{background:var(--warning-tint);color:var(--warning);}
.ci-le.cond .ci-mk{background:var(--cond-tint,#efe8fb);color:var(--cond,#5848a0);}
.ci-le.pass .ci-mk{background:var(--success-tint);color:var(--success);}
.ci-le.system .ci-mk{background:var(--surface-2);color:var(--ink-dim);border:1px solid var(--rule-soft);}
.ci-top{display:flex;align-items:baseline;gap:8px;}
.ci-tag{font-size:9px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:var(--ink-dim);}
.ci-when{font-family:var(--font-mono);font-size:10px;color:var(--ink-dim);margin-left:auto;}
.ci-txt{font-size:12.5px;color:var(--ink);line-height:1.55;margin-top:3px;overflow-wrap:anywhere;}
.ci-txt strong{font-weight:700;}
.ci-txt code{font-family:var(--font-mono);font-size:.9em;background:var(--surface-2);border:1px solid var(--rule-soft);padding:0 3px;border-radius:4px;}
.ci-txt a{color:var(--cond,#5848a0);}
.ci-think{font-size:11.5px;color:var(--ink-soft);font-style:italic;margin-top:4px;padding-left:9px;border-left:2px solid var(--cond-rule,#d8ccf2);line-height:1.42;}
.ci-dots::after{content:"…";animation:ci-dots 1.4s steps(4,end) infinite;}
@keyframes ci-dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
@media (max-width:720px){
  /* Block (not grid-centered): a grid item's min-width:auto lets the modal grow past the
     viewport when content is wide, clipping text. As a plain block child, width:100% wins. */
  .ci-scrim{display:block;padding:0;}
  .ci-modal{width:100%;max-width:100%;min-width:0;height:100vh;height:100dvh;max-height:none;border-radius:0;border:none;}
  .ci-sub{max-width:none;}
  .ci-body{grid-template-columns:1fr;grid-template-rows:1fr 1fr;}
  .ci-pane.left{border-right:none;border-bottom:1px solid var(--rule);}
}
`;
