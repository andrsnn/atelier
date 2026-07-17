"use client";
/**
 * NorthStar — the run's goal made checkable, folded together with self-learning.
 *
 * This is NOT a new surface: it renders inside the Studio run's "Loop" card and inside the Live
 * header, replacing the old plain goal display. It carries three things, all collapsible so it
 * never takes over:
 *   • the GOAL (editable),
 *   • the ACCEPTANCE CRITERIA (the North Star — editable; status is set by the agent's north_star tool),
 *   • LEARNINGS split into "This run" (run-level) vs "This loop" (the template's principles),
 *     with "Keep for the loop" promoting a run learning into the loop.
 *
 * Compressed by default; expanded in Studio (authoring), collapsed in Live (a slim anchor).
 * All mutations POST to /api/runs/[id]/approve, then call onChanged() to let the parent refetch.
 */
import { useEffect, useState } from "react";
import { Markdown } from "./ui";

type Status = "pending" | "met";
interface Criterion { id: string; text: string; status: Status; note?: string }
interface Learning { id: string; text: string; createdAt: number }
interface Principle { id: string; text: string }

const COND = "#5848a0", COND_TINT = "#efe8fb", COND_RULE = "#d8ccf2";
const parse = <T,>(s: unknown): T[] => { try { const a = JSON.parse(String(s || "[]")); return Array.isArray(a) ? a : []; } catch { return []; } };
// Tolerate legacy rows (e.g. an old "at_risk"): anything that isn't "met" reads as pending.
const norm = (s: unknown): Status => (s === "met" ? "met" : "pending");

function Chip({ status, small }: { status: Status; small?: boolean }) {
  const met = status === "met";
  return (
    <span style={{ display: "inline-grid", placeItems: "center", width: small ? 16 : 17, height: small ? 16 : 17, borderRadius: 5,
      fontSize: 10, fontWeight: 700, color: met ? "#fff" : "var(--ink-dim)",
      background: met ? "var(--success)" : "var(--surface-2)",
      border: met ? "none" : "1px solid var(--rule)", flex: "none" }}>{met ? "✓" : ""}</span>
  );
}

export default function NorthStar({
  runId, run, machine, mode, onChanged, busy,
}: {
  runId: string;
  run: { goal: string; criteria?: string | null; learnings?: string | null; machine_id: string };
  machine: { id: string; settings?: { principles?: Principle[]; selfLearn?: boolean } } | null;
  mode: "studio" | "live";
  onChanged?: () => void;
  busy?: boolean;
}) {
  const criteria = parse<Criterion>(run.criteria);
  const learnings = parse<Learning>(run.learnings);
  const principles: Principle[] = machine?.settings?.principles || [];
  const selfLearn = machine?.settings?.selfLearn === true;

  // Collapsed by default in BOTH views — it opens to a slim anchor and expands on demand, so it
  // never dominates the Studio rail (declutter). Studio still gets the full editor once opened.
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gen, setGen] = useState(false);          // AI is drafting acceptance criteria
  const [goalOpen, setGoalOpen] = useState(false); // long goal: expanded vs clamped (collapsed by default)
  const [editGoal, setEditGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState(run.goal);
  const [editCrit, setEditCrit] = useState(false);
  const [draft, setDraft] = useState<Criterion[]>(criteria);
  const [tab, setTab] = useState<"run" | "loop">("run");
  const [newLearn, setNewLearn] = useState("");

  // Keep the goal textarea in sync if the run's goal changes upstream while not editing.
  useEffect(() => { if (!editGoal) setGoalDraft(run.goal); }, [run.goal, editGoal]);

  const disabled = saving || busy;
  const met = criteria.filter(c => norm(c.status) === "met").length;

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setSaving(true);
    try { await fetch(`/api/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) }); onChanged?.(); }
    finally { setSaving(false); }
  }

  const startEditCrit = () => { setDraft(criteria.length ? criteria.map(c => ({ ...c, status: norm(c.status) })) : [{ id: "new1", text: "", status: "pending" }]); setEditCrit(true); };
  const toggle = (s: Status): Status => (s === "met" ? "pending" : "met");

  // Let the run's model draft acceptance criteria from the goal — the criteria feed straight into
  // the agent's prompts, so a good first set is worth a click. Own "generating" state (it's a
  // harness call, so a few seconds); refetches on success so the new criteria render.
  async function generateCrit() {
    setGen(true);
    try {
      const r = await fetch(`/api/runs/${runId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generateCriteria" }) });
      if (r.ok) { setEditCrit(false); onChanged?.(); }
    } finally { setGen(false); }
  }

  return (
    <div style={{ border: `1px solid ${COND_RULE}`, borderRadius: 12, background: "var(--surface)", overflow: "hidden" }}>
      {/* header — the slim anchor; the only thing shown when collapsed */}
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", background: open ? COND_TINT : "transparent",
          border: "none", borderBottom: open ? `1px solid ${COND_RULE}` : "none", cursor: "pointer", textAlign: "left", font: "inherit", minHeight: 40 }}>
        <span style={{ color: COND, fontSize: 13 }}>✦</span>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--ink)" }}>North Star</span>
        {criteria.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: met === criteria.length ? "var(--success)" : "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>{met}/{criteria.length}</span>
            <span style={{ display: "flex", gap: 2 }}>{criteria.slice(0, 6).map(c => <Chip key={c.id} status={norm(c.status)} small />)}</span>
          </span>
        )}
        {criteria.length === 0 && <span style={{ fontSize: 11, color: "var(--ink-dim)" }}>goal &amp; expected outcome</span>}
        <span style={{ marginLeft: "auto", color: "var(--ink-dim)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        // In Live the panel sits in the fixed header; bound its body and scroll INTERNALLY so an
        // expanded North Star never pushes the feed off-screen or gets sliced. The card's own
        // rounded border wraps this scroll region, so it reads as a clean panel (not a hard cut).
        // Studio is a normal scrolling page, so it stays unbounded there.
        <div style={{ padding: "11px 12px 12px", ...(mode === "live" ? { maxHeight: "42vh", overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" } : {}) }}>
          {/* GOAL */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-dim)" }}>Goal</span>
            {!editGoal && <button type="button" onClick={() => { setGoalDraft(run.goal); setEditGoal(true); }} disabled={disabled}
              style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: COND, background: "none", border: "none", cursor: "pointer" }}>✎ Edit</button>}
          </div>
          {editGoal ? (
            <div style={{ marginBottom: 12 }}>
              <textarea className="input" style={{ width: "100%", minHeight: 76, fontSize: 12.5, fontFamily: "var(--font-display, Georgia), serif" }} value={goalDraft} onChange={e => setGoalDraft(e.target.value)} />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button type="button" className="btn btn-primary" style={{ padding: "4px 11px", fontSize: 12 }} disabled={disabled || !goalDraft.trim()}
                  onClick={async () => { await post("editGoal", { goal: goalDraft.trim() }); setEditGoal(false); }}>Save</button>
                <button type="button" className="btn" style={{ padding: "4px 11px", fontSize: 12 }} onClick={() => setEditGoal(false)}>Cancel</button>
              </div>
            </div>
          ) : (() => {
            // Long, spec-like goals dominate the panel — clamp to a few lines by default with a
            // fade, and let the reader expand. Markdown so headings/lists/emphasis in the goal read
            // as intended instead of as raw asterisks.
            const long = (run.goal || "").length > 340;
            const clamp = long && !goalOpen;
            return (
              <div style={{ marginBottom: 13 }}>
                <div className="ns-goal" style={{ fontFamily: "var(--font-display, Georgia), serif", fontSize: 14, lineHeight: 1.45, color: "var(--ink)", overflowWrap: "anywhere",
                  ...(clamp ? { maxHeight: 108, overflow: "hidden", WebkitMaskImage: "linear-gradient(180deg,#000 66%,transparent)", maskImage: "linear-gradient(180deg,#000 66%,transparent)" } : {}) }}>
                  <Markdown>{run.goal}</Markdown>
                </div>
                {long && (
                  <button type="button" onClick={() => setGoalOpen(v => !v)}
                    style={{ marginTop: 3, fontSize: 11, fontWeight: 600, color: COND, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    {goalOpen ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            );
          })()}

          {/* EXPECTED OUTCOME (the run's checkable definition of done) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-dim)" }}>Expected outcome</span>
            {!editCrit && (
              <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                <button type="button" onClick={generateCrit} disabled={disabled || gen}
                  title="Draft the expected outcome from the goal with AI — these anchor what 'done' means for the run"
                  style={{ fontSize: 11, fontWeight: 600, color: COND, background: COND_TINT, border: `1px solid ${COND_RULE}`, borderRadius: 999, padding: "3px 9px", cursor: gen ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 4, opacity: gen ? 0.7 : 1 }}>
                  {gen ? "✨ Generating…" : `✨ ${criteria.length ? "Regenerate" : "Generate"}`}
                </button>
                <button type="button" onClick={startEditCrit} disabled={disabled}
                  style={{ fontSize: 11, fontWeight: 600, color: COND, background: "none", border: "none", cursor: "pointer" }}>✎ Edit</button>
              </span>
            )}
          </div>

          {!editCrit ? (
            criteria.length ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {criteria.map((c, i) => (
                  <div key={c.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0", borderTop: i ? "1px solid var(--rule-soft)" : "none" }}>
                    <Chip status={norm(c.status)} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, lineHeight: 1.4, color: "var(--ink)" }}>{c.text}</div>
                      {(norm(c.status) === "met" || c.note) && (
                        <div style={{ fontSize: 10.5, marginTop: 2, color: norm(c.status) === "met" ? "var(--success)" : "var(--ink-dim)", fontWeight: 600 }}>
                          {norm(c.status) === "met" ? "met" : ""}{c.note ? <span style={{ color: "var(--ink-dim)", fontWeight: 400 }}>{norm(c.status) === "met" ? " · " : ""}{c.note}</span> : null}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" onClick={generateCrit} disabled={disabled || gen}
                  title="Let the run's model draft the expected outcome from the goal — you can edit it after"
                  style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", background: COND, border: "none", borderRadius: 8, padding: "8px 10px", width: "100%", textAlign: "left", cursor: gen ? "default" : "pointer", opacity: gen ? 0.75 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {gen ? "✨ Generating outcome…" : "✨ Generate expected outcome from the goal"}
                </button>
                <button type="button" onClick={startEditCrit} disabled={disabled || gen}
                  style={{ fontSize: 12, color: COND, background: COND_TINT, border: `1px dashed ${COND_RULE}`, borderRadius: 8, padding: "7px 10px", width: "100%", textAlign: "left", cursor: "pointer" }}>
                  + Or add them yourself
                </button>
              </div>
            )
          ) : (
            <div>
              {draft.map((c, i) => (
                <div key={c.id} style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 6 }}>
                  <button type="button" title="toggle met / not met" onClick={() => setDraft(d => d.map((x, j) => j === i ? { ...x, status: toggle(norm(x.status)) } : x))}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", flex: "none" }}><Chip status={norm(c.status)} /></button>
                  <input className="input" style={{ flex: 1, fontSize: 12.5, padding: "5px 8px" }} value={c.text} placeholder="One checkable outcome…"
                    onChange={e => setDraft(d => d.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
                  <button type="button" onClick={() => setDraft(d => d.filter((_, j) => j !== i))}
                    style={{ background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", fontSize: 15, flex: "none" }} title="remove">✕</button>
                </div>
              ))}
              <button type="button" onClick={() => setDraft(d => [...d, { id: `new${d.length + 1}`, text: "", status: "pending" }])}
                style={{ fontSize: 12, fontWeight: 600, color: COND, background: "none", border: "none", cursor: "pointer", padding: "2px 0", marginBottom: 8 }}>+ Add outcome</button>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="btn btn-primary" style={{ padding: "4px 11px", fontSize: 12 }} disabled={disabled}
                  onClick={async () => { await post("setCriteria", { criteria: draft.filter(c => c.text.trim()).map(c => ({ id: c.id.startsWith("new") ? undefined : c.id, text: c.text, status: c.status, note: c.note })) }); setEditCrit(false); }}>Save outcome</button>
                <button type="button" className="btn" style={{ padding: "4px 11px", fontSize: 12 }} onClick={() => setEditCrit(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* LEARNINGS — run vs loop */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--rule-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-dim)" }}>Learnings</span>
              <span style={{ marginLeft: "auto", display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--rule)", borderRadius: 8, padding: 2, fontSize: 10.5, fontWeight: 600 }}>
                {(["run", "loop"] as const).map(t => (
                  <button key={t} type="button" onClick={() => setTab(t)}
                    style={{ padding: "3px 9px", borderRadius: 6, border: "none", cursor: "pointer", font: "inherit",
                      background: tab === t ? COND : "transparent", color: tab === t ? "#fff" : "var(--ink-dim)" }}>
                    {t === "run" ? "This run" : "This loop"}
                  </button>
                ))}
              </span>
            </div>

            {tab === "run" ? (
              <div>
                <div style={{ fontSize: 10.5, color: "var(--ink-dim)", marginBottom: 8, lineHeight: 1.4 }}>Notes that steer <b>only this run</b>. Keep one for the loop to apply it to every future run.</div>
                {learnings.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-dim)", padding: "2px 0 6px" }}>No run learnings yet.</div>}
                {learnings.map(l => (
                  <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderTop: "1px solid var(--rule-soft)" }}>
                    <span style={{ color: COND, fontSize: 11, marginTop: 1 }}>✎</span>
                    <span style={{ fontSize: 12, lineHeight: 1.4, flex: 1, minWidth: 0, color: "var(--ink)" }}>{l.text}</span>
                    <button type="button" disabled={disabled} onClick={() => post("promoteLearning", { learningId: l.id })} title="Promote this into the loop's principles (applies to every future run)"
                      style={{ flex: "none", fontSize: 10.5, fontWeight: 700, color: COND, background: COND_TINT, border: `1px solid ${COND_RULE}`, borderRadius: 999, padding: "3px 9px", cursor: "pointer", whiteSpace: "nowrap" }}>↑ Keep for loop</button>
                    <button type="button" disabled={disabled} onClick={() => post("removeLearning", { learningId: l.id })} style={{ flex: "none", background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", fontSize: 13 }} title="remove">✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input className="input" style={{ flex: 1, fontSize: 12, padding: "5px 8px" }} placeholder="Add a note for this run…" value={newLearn} onChange={e => setNewLearn(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && newLearn.trim()) { post("addLearning", { text: newLearn.trim() }); setNewLearn(""); } }} />
                  <button type="button" className="btn" style={{ padding: "4px 11px", fontSize: 12 }} disabled={disabled || !newLearn.trim()}
                    onClick={() => { post("addLearning", { text: newLearn.trim() }); setNewLearn(""); }}>Add</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 10.5, color: "var(--ink-dim)", marginBottom: 8, lineHeight: 1.4 }}>
                  Durable principles applied to <b>every</b> run of this loop{selfLearn ? "" : " (self-learning is off — turn it on in the loop to inject these)"}.
                </div>
                {principles.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-dim)", padding: "2px 0 4px" }}>No loop principles yet. Promote a run learning, or add them in the loop&apos;s self-learning settings.</div>}
                {principles.map((p, i) => (
                  <div key={p.id || i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderTop: i ? "1px solid var(--rule-soft)" : "none" }}>
                    <span style={{ color: COND, fontSize: 11, marginTop: 1 }}>◆</span>
                    <span style={{ fontSize: 12, lineHeight: 1.4, flex: 1, minWidth: 0, color: "var(--ink)" }}>{p.text}</span>
                    <span style={{ flex: "none", fontSize: 9.5, color: "var(--ink-dim)", fontFamily: "var(--font-mono, monospace)", alignSelf: "center" }}>every run</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
