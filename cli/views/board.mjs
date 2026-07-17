/**
 * Board — every run ("loop in flight"), live. Two layouts:
 *   feed     — one card per run with its mini state-rail
 *   columns  — kanban by status: In progress / Needs you / Shipped / Failed
 * Polls GET /api/runs every 2.5s, like the web board.
 */
import { c, fit, modelShort, spinAt, statusChip, statusRank, strWidth, timeAgo, truncAnsi } from "../lib/ui.mjs";
import { miniRail } from "../lib/graph.mjs";
import { RunView } from "./run.mjs";
import { LoopsView } from "./loops.mjs";
import { NewRunView } from "./newrun.mjs";

const SORTS = ["status", "updated", "created", "name"];

export class BoardView {
  constructor() {
    this.title = "board";
    this.runs = [];
    this.machines = [];
    this.projects = [];
    this.archivedCount = 0;
    this.sel = 0;
    this.top = 0;
    this.sort = "status";
    this.layout = "feed"; // 'feed' | 'columns'
    this.showArchived = false;
    this.loaded = false;
    this.err = "";
    this._last = 0;
  }

  mount(app) { this.app = app; this.load(); }
  wake() { this.load(); }
  animating() { return this.runs.some((r) => r.status === "running"); }

  async load() {
    try {
      const d = await this.app.api.runs(this.showArchived);
      this.runs = d.runs || [];
      this.machines = d.machines || [];
      this.projects = d.projects || [];
      this.archivedCount = d.archivedCount || 0;
      this.err = "";
      this.loaded = true;
    } catch (e) {
      this.err = e.message;
    }
    this.app.repaint();
  }

  tick(now) {
    if (now - this._last >= 2500) { this._last = now; this.load(); }
  }

  sorted() {
    const rs = [...this.runs];
    const by = {
      status: (a, b) => statusRank(a.status) - statusRank(b.status) || b.updated_at - a.updated_at,
      updated: (a, b) => b.updated_at - a.updated_at,
      created: (a, b) => b.created_at - a.created_at,
      name: (a, b) => (a.title || "").localeCompare(b.title || ""),
    };
    return rs.sort(by[this.sort]);
  }

  machineOf(run) { return this.machines.find((m) => m.id === run.machine_id); }
  projectOf(run) { return this.projects.find((p) => p.repoPath === run.repo_path); }

  selectedRun() { return this.sorted()[this.sel]; }

  onKey(k) {
    const runs = this.sorted();
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(runs.length - 1, this.sel + 1); return true; }
    if (k.name === "enter") {
      const r = runs[this.sel];
      if (r) this.app.push(new RunView(r.id));
      return true;
    }
    if (k.name === "n") { this.app.push(new NewRunView({ machines: this.machines, projects: this.projects })); return true; }
    if (k.name === "l" || k.name === "L") { this.app.push(new LoopsView()); return true; }
    if (k.name === "v") { this.layout = this.layout === "feed" ? "columns" : "feed"; return true; }
    if (k.name === "s") { this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]; return true; }
    if (k.name === "A") { this.showArchived = !this.showArchived; this.sel = 0; this.load(); return true; }
    if (k.name === "a") {
      const r = runs[this.sel];
      if (!r) return true;
      const restoring = this.showArchived;
      this.app.confirm(`${restoring ? "Restore" : "Archive"} "${truncAnsi(r.title, 40)}"?`, async () => {
        try { await this.app.api.archive(r.id, !restoring); this.app.flash(restoring ? "restored" : "archived"); this.load(); }
        catch (e) { this.app.flash(e.message, true); }
      });
      return true;
    }
    if (k.name === "r") {
      const r = runs[this.sel];
      const m = r && this.machineOf(r);
      const st = m?.states?.[r.state_index];
      if (r && st?.watchable) {
        this.app.api.act(r.id, "recheck", { phase: r.state_index })
          .then(() => this.app.flash(`re-checking ${st.watchable.label || st.name}`))
          .catch((e) => this.app.flash(e.message, true));
      } else this.app.flash("selected run's phase is not re-checkable", true);
      return true;
    }
    if (k.name === "R") {
      this.app.confirm("Reap leftover dev servers / browsers?", async () => {
        try { const r = await this.app.api.reap(); this.app.flash(`reaped ${r.total} process(es)`); }
        catch (e) { this.app.flash(e.message, true); }
      });
      return true;
    }
    return false;
  }

  footer() {
    return c.dim("↑↓ select · enter open · n new run · l loops · v layout · s sort · a archive · A archived · R reap · q quit");
  }

  help() {
    return `board
  ↑ ↓          select a run
  enter        open the run cockpit
  n            start a new run
  l            loop library (machines)
  v            toggle layout: feed ⇄ status columns
  s            cycle sort (status / updated / created / name)
  a            archive (or restore, in archived view) selected run
  A            toggle archived list (${this.archivedCount} archived)
  r            re-check a watchable terminal phase (e.g. Open PR)
  R            reap leftover dev servers/browsers
`;
  }

  render(w, h) {
    const sp = spinAt();
    const runs = this.sorted();
    const head =
      " " + c.bold(c.brand("ATELIER")) + c.faint(" · board") +
      "  " + c.faint(`${runs.length} ${this.showArchived ? "archived " : ""}loop${runs.length === 1 ? "" : "s"}`) +
      (this.showArchived ? "" : c.faint(` · ${this.archivedCount} archived`)) +
      "   " + c.faint(`layout:${this.layout} sort:${this.sort}`);
    const lines = [head, ""];

    if (this.err) { lines.push("  " + c.err(this.err)); return lines; }
    if (!this.loaded) { lines.push("  " + c.dim(sp + " connecting…")); return lines; }
    if (!runs.length) {
      lines.push("  " + c.dim("no runs yet — press ") + c.bold("n") + c.dim(" to start one, ") + c.bold("l") + c.dim(" to browse loops"));
      return lines;
    }

    if (this.layout === "columns") return this.renderColumns(lines, runs, w, h, sp);
    return this.renderFeed(lines, runs, w, h, sp);
  }

  cardLines(r, w, sp, selected) {
    const m = this.machineOf(r);
    const proj = this.projectOf(r);
    const repo = proj?.name || (r.repo_path ? r.repo_path.split("/").pop() : "scratch");
    const stName = m?.states?.[r.state_index]?.name || `phase ${r.state_index}`;
    const mark = selected ? c.brand("▌") : " ";
    const l1 =
      mark + " " + fit(statusChip(r.status, sp), 13) + " " +
      c.bold(truncAnsi(r.title || "(untitled)", Math.max(10, w - 60))) +
      (r.pr_url ? "  " + c.brand("PR↗") : "");
    const railStr = m ? miniRail(m.states, r, r.status === "running" ? sp : undefined) : c.faint("—");
    const meta = c.faint(`${m?.name || r.machine_id} · ${repo} · ${modelShort(r.primary_model)} · ${timeAgo(r.updated_at)}`) +
      (r.loop_count ? c.warn(`  ↻${r.loop_count}`) : "");
    const l2 = mark + "   " + railStr + "  " + c.dim(stName) + "  " + meta;
    return [selected ? c.bgSel(fit(l1, w)) : l1, selected ? c.bgSel(fit(l2, w)) : l2];
  }

  renderFeed(lines, runs, w, h, sp) {
    const per = 3; // 2 content lines + spacer
    const fitCount = Math.floor((h - lines.length - 1) / per);
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + fitCount) this.top = this.sel - fitCount + 1;
    if (this.top > 0) lines.push(c.faint(`  ▲ ${this.top} more`));
    for (let i = this.top; i < Math.min(runs.length, this.top + fitCount); i++) {
      lines.push(...this.cardLines(runs[i], w, sp, i === this.sel), "");
    }
    const below = runs.length - (this.top + fitCount);
    if (below > 0) lines.push(c.faint(`  ▼ ${below} more`));
    return lines;
  }

  renderColumns(lines, runs, w, h, sp) {
    const cols = [
      { key: "progress", label: "In progress", paint: c.brand, match: (r) => ["running", "queued", "idle"].includes(r.status) },
      { key: "needs", label: "Needs you", paint: c.warn, match: (r) => ["awaiting_approval", "paused"].includes(r.status) },
      { key: "shipped", label: "Shipped", paint: c.ok, match: (r) => r.status === "done" },
      { key: "failed", label: "Failed", paint: c.err, match: (r) => r.status === "failed" },
    ];
    const colW = Math.floor((w - 2) / cols.length) - 1;
    const grouped = cols.map((col) => runs.filter(col.match));
    const sel = this.selectedRun();

    const header = cols.map((col, ci) =>
      fit(col.paint(c.bold(` ${col.label} `)) + c.faint(`${grouped[ci].length}`), colW)
    ).join(c.faint("│"));
    lines.push(" " + header, " " + cols.map(() => c.faint("─".repeat(colW))).join(c.faint("┼")));

    const rowsAvail = Math.floor((h - lines.length - 1) / 3);
    const cells = grouped.map((g) => g.slice(0, rowsAvail));
    for (let row = 0; row < rowsAvail; row++) {
      for (let sub = 0; sub < 3; sub++) {
        let line = " ";
        let any = false;
        for (let ci = 0; ci < cols.length; ci++) {
          const r = cells[ci][row];
          let cell = "";
          if (r) {
            any = true;
            const m = this.machineOf(r);
            const isSel = sel && r.id === sel.id;
            if (sub === 0) cell = (isSel ? c.brand("▌") : " ") + c.bold(truncAnsi(r.title || "(untitled)", colW - 3));
            if (sub === 1) cell = "  " + (m ? miniRail(m.states, r, r.status === "running" ? sp : undefined) : "");
            if (sub === 2) cell = "  " + c.faint(`${m?.states?.[r.state_index]?.name || ""} · ${timeAgo(r.updated_at)}`);
            if (isSel && sub === 0) cell = c.bgSel(fit(cell, colW));
          }
          line += fit(cell, colW) + c.faint("│");
        }
        if (!any && row > 0) break;
        lines.push(line);
      }
    }
    const hidden = grouped.reduce((a, g) => a + Math.max(0, g.length - rowsAvail), 0);
    if (hidden) lines.push(c.faint(`  … ${hidden} more (switch to feed layout with v)`));
    lines.push("", c.faint("  columns are read-only cards — selection follows the feed order (↑↓), enter opens"));
    return lines;
  }
}
