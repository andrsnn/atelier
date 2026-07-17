"use client";
/**
 * Simple mode for the Board and Loops pages — the calm, mobile-first home. Same data as the
 * dense Pro board, but a single-column tappable list instead of the feed/columns machinery.
 * Simple mode was built for phones; these are the entry points, so they have to be usable there.
 */
import Link from "next/link";
import { StatusChip, timeAgo } from "./ui";

type Run = { id: string; title: string; status: string; machine_id: string; state_index: number; updated_at: number; pr_url?: string | null };
type Machine = { id: string; name: string; states: { id: string; name: string }[] };

// Active work first (your turn → running → paused/queued → failed → done), newest within each.
const rank = (s: string) => (s === "awaiting_approval" ? 0 : s === "running" ? 1 : s === "paused" || s === "queued" ? 2 : s === "failed" ? 3 : 4);

export function SimpleHome({ runs, machines }: { runs: Run[]; machines: Machine[] }) {
  const byId = new Map(machines.map(m => [m.id, m]));
  const sorted = [...runs].sort((a, b) => rank(a.status) - rank(b.status) || b.updated_at - a.updated_at);
  const phaseName = (r: Run) => byId.get(r.machine_id)?.states?.[r.state_index]?.name || "";

  return (
    <div className="simple-wrap">
      <div className="simple-col">
        <div className="simple-home-head">
          <h1 className="simple-home-title">Atelier</h1>
          <div className="simple-now" style={{ textAlign: "left", marginTop: 2 }}>Your runs — tap one to follow along.</div>
        </div>

        <div className="simple-list">
          {sorted.length === 0 && <div className="simple-empty">No runs yet.</div>}
          {sorted.map(r => (
            <Link key={r.id} href={`/runs/${r.id}`} className="simple-item">
              <div className="simple-item-top">
                <StatusChip status={r.status} />
                {r.status === "done" && r.pr_url && <span className="tag tag-green" style={{ fontSize: 10 }}>PR</span>}
                <span className="simple-item-when">{timeAgo(r.updated_at)}</span>
              </div>
              <div className="simple-item-title">{r.title}</div>
              <div className="simple-item-sub">{byId.get(r.machine_id)?.name || r.machine_id}{phaseName(r) ? ` · ${phaseName(r)}` : ""}</div>
            </Link>
          ))}
        </div>

        <Link href="/machines" className="simple-btn ghost" style={{ textDecoration: "none", textAlign: "center" }}>Browse loops →</Link>
        <div className="simple-foot"><b>Atelier</b></div>
      </div>
    </div>
  );
}

export function SimpleLoopList({ machines }: { machines: (Machine & { description?: string })[] }) {
  return (
    <div className="simple-wrap">
      <div className="simple-col">
        <div className="simple-home-head">
          <h1 className="simple-home-title">Loops</h1>
          <div className="simple-now" style={{ textAlign: "left", marginTop: 2 }}>Tap a loop to open it.</div>
        </div>
        <div className="simple-list">
          {machines.length === 0 && <div className="simple-empty">No loops yet.</div>}
          {machines.map(m => (
            <Link key={m.id} href={`/machines/${m.id}`} className="simple-item">
              <div className="simple-item-title">{m.name}</div>
              <div className="simple-item-sub">{(m.states || []).map(s => s.name).join("  →  ") || "—"}</div>
            </Link>
          ))}
        </div>
        <div className="simple-foot"><b>Atelier</b></div>
      </div>
    </div>
  );
}
