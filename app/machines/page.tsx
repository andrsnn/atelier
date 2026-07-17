"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSimpleMode } from "../components/SimpleMode";
import { SimpleLoopList } from "../components/SimpleHome";

interface Machine {
  id: string; name: string; description: string;
  states: { id: string; name: string }[];
  settings?: { workflow?: { source: string; totalAgents: number } };
}

export default function MachinesPage() {
  const router = useRouter();
  const { simple } = useSimpleMode();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [importing, setImporting] = useState(false);
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");

  async function load() {
    const d = await (await fetch("/api/machines", { cache: "no-store" })).json();
    setMachines(d.machines);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    const d = await (await fetch("/api/machines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New loop", states: [{ id: "state-1", name: "State 1", prompt: "Do the work for this state, display_artifact your result, then request_approval.", tools: ["read_file", "write_file", "display_artifact"] }] }),
    })).json();
    if (d.machine) router.push(`/machines/${d.machine.id}`);
  }

  // Duplicate a loop → a "(copy)" clone with a fresh id, then open the copy to edit.
  async function duplicate(id: string) {
    const d = await (await fetch(`/api/machines/${id}/duplicate`, { method: "POST" })).json();
    if (d.machine) router.push(`/machines/${d.machine.id}`);
  }

  // Create a loop with AI: describe it → drafted loop → open on the graph to review + edit.
  async function generateLoop() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true); setAiErr("");
    try {
      const r = await fetch("/api/machines/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: aiPrompt }) });
      const d = await r.json();
      if (!r.ok || !d.machine) { setAiErr(d.error || "could not draft a loop from that — try describing the phases you want"); setAiBusy(false); return; }
      router.push(`/machines/${d.machine.id}?ai=1`);
    } catch (e) { setAiErr(e instanceof Error ? e.message : "generate failed"); setAiBusy(false); }
  }

  async function importWorkflow() {
    if (!src.trim()) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/workflows/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: src }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "could not parse that as a Claude Code workflow"); setBusy(false); return; }
      router.push(`/machines/${d.machine.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : "import failed"); setBusy(false); }
  }

  // Simple mode: calm, mobile-first list of loops.
  if (simple) return <SimpleLoopList machines={machines} />;

  return (
    <div>
      <div className="flex flex-col gap-2.5 mb-3.5 sm:flex-row sm:items-center">
        <h1 style={{ fontSize: 28, margin: 0 }}>Loops</h1>
        <div className="flex gap-2.5 sm:ml-auto">
          <button className="btn flex-1 justify-center max-sm:min-h-[44px] sm:flex-none" onClick={() => { setImporting(true); setErr(""); setSrc(""); }}>⚡ Import Claude workflow</button>
          <button className="btn btn-primary flex-1 justify-center max-sm:min-h-[44px] sm:flex-none" onClick={create}>+ New loop</button>
        </div>
      </div>
      <p className="muted" style={{ marginBottom: 14, fontSize: 13.5, maxWidth: 720 }}>
        A loop is an ordered list of states — each a <b style={{ color: "var(--ink-soft)" }}>prompt</b> plus the <b style={{ color: "var(--ink-soft)" }}>tools</b> the AI may use. Describe one below and AI will draft it, import a <b style={{ color: "var(--ink-soft)" }}>Claude Code workflow</b>, or build one by hand.
      </p>

      {/* Create a loop with AI — describe it, get a drafted loop on the graph */}
      <div className="card card-pad" style={{ marginBottom: 18, borderColor: "var(--brand)" }}>
        <label className="label" style={{ marginBottom: 6, display: "block" }}>✨ Create a loop with AI</label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <textarea className="input flex-1 min-h-[112px] sm:min-h-[62px]" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} disabled={aiBusy}
            placeholder="Describe the loop you want — e.g. 'Research a topic across sources, cross-check the claims, then write a cited brief; loop back if a claim can't be verified.'"
            style={{ fontSize: 13 }}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generateLoop(); }} />
          <button className="btn btn-primary w-full justify-center max-sm:min-h-[44px] sm:w-auto" onClick={generateLoop} disabled={aiBusy || !aiPrompt.trim()} style={{ whiteSpace: "nowrap" }}>{aiBusy ? "Drafting…" : "Generate →"}</button>
        </div>
        {aiErr && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 8 }}>⚠ {aiErr}</div>}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 7 }}>Drafts the phases, prompts, tools and routing, then opens it on the graph to review + edit.</div>
      </div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {machines.map(m => {
          const wf = m.settings?.workflow;
          return (
            <Link key={m.id} href={`/machines/${m.id}`} className="card card-pad" style={{ position: "relative", ...(wf ? { borderColor: "var(--brand)" } : {}) }}>
              <button className="btn" title="Duplicate this loop and open the copy to edit"
                onClick={e => { e.preventDefault(); e.stopPropagation(); duplicate(m.id); }}
                style={{ position: "absolute", top: 10, right: 12, padding: "2px 9px", fontSize: 11 }}>Duplicate</button>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, paddingRight: 84, minWidth: 0 }}>
                <div className="display" style={{ fontSize: 17, minWidth: 0, overflowWrap: "anywhere" }}>{m.name}</div>
                {wf && <span className="chip" style={{ background: "var(--brand-tint)", borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 600, fontSize: 11 }}>⚡ Claude workflow</span>}
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>{m.description || "—"}{wf ? ` · ${wf.totalAgents} agents` : ""}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {m.states.map((s, i) => <span key={s.id} style={{ display: "inline-flex", alignItems: "center" }}>{i > 0 && <span className="muted" style={{ margin: "0 3px" }}>→</span>}<span className="tag">{s.name}</span></span>)}
              </div>
            </Link>
          );
        })}
      </div>

      {importing && (
        <div onClick={() => !busy && setImporting(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", zIndex: 50, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} className="card card-pad" style={{ width: "min(760px, 100%)", maxHeight: "86vh", overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
              <h2 style={{ fontSize: 19, margin: 0 }}>Import a Claude Code workflow</h2>
              <span className="chip" style={{ background: "var(--brand-tint)", borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 600 }}>⚡ .js</span>
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>
              Paste a workflow script (the <code className="mono">export const meta = …</code> + <code className="mono">phase()/agent()/parallel()/pipeline()</code> body). It&rsquo;s parsed statically — never executed — and visualized as phases the team can see.
            </p>
            <textarea className="input mono" value={src} onChange={e => setSrc(e.target.value)} spellCheck={false}
              placeholder={"export const meta = {\n  name: 'review-changes',\n  description: '…',\n  phases: [{ title: 'Review' }, { title: 'Verify' }],\n}\nphase('Review')\nconst f = await parallel(/* … */)"}
              style={{ width: "100%", minHeight: 280, fontSize: 12, lineHeight: 1.5 }} />
            {err && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn" onClick={() => setImporting(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={importWorkflow} disabled={busy || !src.trim()}>{busy ? "Parsing…" : "Visualize workflow"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
