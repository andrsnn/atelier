/**
 * Run cockpit — live view of one run: phase rail ⇄ ASCII DAG, deliverables,
 * the raw activity feed, the state-machine history, and the Conductor.
 * Polls GET /api/runs/{id} every 1.5s with a `since` event cursor.
 */
import { c, fit, modelShort, spinAt, statusChip, strWidth, timeAgo, truncAnsi, wrapText } from "../lib/ui.mjs";
import { dag, disabledSet, rail } from "../lib/graph.mjs";
import { GATE_MODES, PRIMARY_MODELS, VISION_MODELS, gateLabel } from "../lib/api.mjs";

const TABS = ["deliverables", "activity", "history", "conductor"];

export class RunView {
  constructor(runId) {
    this.title = "run";
    this.id = runId;
    this.run = null;
    this.machine = null;
    this.events = [];
    this.artifacts = [];
    this.comments = [];
    this.conductor = [];
    this.conductorWorking = false;
    this.conductorActivity = [];
    this.presence = [];
    this.err = "";
    this.viewIdx = -1; // phase being inspected; -1 = follow current
    this.graph = true; // dag by default — it's the point
    this.tab = "deliverables";
    this.sel = 0; // tab-local selection
    this.scroll = 0; // activity/history: lines up from the tail
    this._last = 0;
    this._lastEvent = null;
    this._busy = false;
  }

  mount(app) { this.app = app; this.load(); }
  wake() { this.load(); }
  animating() { return this.run?.status === "running" || this.conductorWorking; }

  async load() {
    if (this._busy) return;
    this._busy = true;
    try {
      const d = await this.app.api.run(this.id, this._lastEvent);
      this.run = d.run;
      this.machine = d.machine;
      if (d.events?.length) {
        this.events.push(...d.events);
        if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
        this._lastEvent = this.events[this.events.length - 1].id;
      }
      this.artifacts = d.artifacts || [];
      this.comments = d.comments || [];
      this.conductor = d.conductor || [];
      this.conductorWorking = !!d.conductorWorking;
      this.conductorActivity = d.conductorActivity || [];
      this.presence = d.presence || [];
      this.err = "";
    } catch (e) {
      this.err = e.message;
    }
    this._busy = false;
    this.app.repaint();
  }

  tick(now) {
    if (now - this._last >= 1500) { this._last = now; this.load(); }
  }

  states() { return this.machine?.states || []; }
  curIdx() { return this.viewIdx >= 0 ? this.viewIdx : (this.run?.state_index ?? 0); }
  curState() { return this.states()[this.curIdx()]; }

  async act(action, extra = {}, okMsg) {
    try {
      await this.app.api.act(this.id, action, extra);
      if (okMsg) this.app.flash(okMsg);
      this.load();
    } catch (e) {
      this.app.flash(e.message, true);
    }
  }

  phasePicker(title, onChoose, { onlyWatchable = false } = {}) {
    const items = this.states()
      .map((s, i) => ({ s, i }))
      .filter((x) => !onlyWatchable || x.s.watchable)
      .map((x) => ({
        label: `${x.i + 1}. ${x.s.name}${x.s.offPath ? " ◇" : ""}`,
        hint: x.i === this.run.state_index ? "current" : "",
        value: x.i,
      }));
    if (!items.length) return this.app.flash("no matching phase", true);
    this.app.picker({ title, items, sel: Math.min(this.curIdx(), items.length - 1), onChoose });
  }

  // ------------------------------------------------------------------ keys
  onKey(k) {
    const r = this.run;
    if (!r) return false;

    if (k.name === "tab") {
      const d = k.shift ? -1 : 1;
      this.tab = TABS[(TABS.indexOf(this.tab) + d + TABS.length) % TABS.length];
      this.sel = 0; this.scroll = 0;
      return true;
    }
    if (k.name === "g") { this.graph = !this.graph; return true; }
    if (k.name === "left") { this.viewIdx = Math.max(0, this.curIdx() - 1); return true; }
    if (k.name === "right") { this.viewIdx = Math.min(this.states().length - 1, this.curIdx() + 1); return true; }
    if (k.name === "f") { this.viewIdx = -1; return true; } // follow the run again

    // ---- lifecycle verbs
    if (k.name === "a" && r.status === "awaiting_approval") {
      this.app.input({ label: "approve — optional note for the next phase", placeholder: "enter to approve", onSubmit: (t) => this.act("approve", t.trim() ? { message: t } : {}, "approved") });
      return true;
    }
    if (k.name === "c" && r.status === "awaiting_approval") {
      this.app.input({ label: "request changes — what should be different?", onSubmit: (t) => t.trim() && this.act("changes", { message: t }, "sent back for changes") });
      return true;
    }
    if (k.name === "p") {
      if (r.status === "paused") this.act("resume", {}, "resumed");
      else if (["running", "queued", "awaiting_approval"].includes(r.status)) this.act("pause", {}, "paused");
      return true;
    }
    if (k.name === "S" && ["idle", "failed"].includes(r.status)) { this.act("start", {}, "started"); return true; }
    if (k.name === "G") {
      const order = ["all", "machine", "none"];
      const next = order[(order.indexOf(r.gate_mode || "machine") + 1) % 3];
      this.act("setGateMode", { gateMode: next }, `gate mode: ${gateLabel(next)}`);
      return true;
    }
    if (k.name === "m") {
      const modes = this.machine?.settings?.modes || [];
      if (!modes.length) return this.app.flash("this loop declares no modes", true), true;
      this.app.picker({
        title: "run mode",
        items: modes.map((m) => ({ label: m.label || m.id, hint: m.hint || "", value: m.id, selected: m.id === r.mode })),
        onChoose: (mode) => this.act("setMode", { mode }, `mode: ${mode}`),
      });
      return true;
    }
    if (k.name === "M") {
      this.app.picker({
        title: "agent model",
        items: PRIMARY_MODELS.map((m) => ({ ...m, selected: m.value === r.primary_model })),
        onChoose: (primaryModel) => this.app.picker({
          title: "vision / QA helper",
          items: VISION_MODELS.map((m) => ({ ...m, selected: m.value === r.vision_model })),
          onChoose: (visionModel) => this.act("setModels", { primaryModel, visionModel }, "models updated"),
        }),
      });
      return true;
    }
    if (k.name === "e") {
      this.app.editText(r.goal || "", { title: "goal", onSubmit: (goal) => this.act("editGoal", { goal }, "goal updated") });
      return true;
    }
    if (k.name === "T") {
      this.app.input({ label: "rename run", value: r.title || "", onSubmit: (title) => title.trim() && this.act("rename", { title }, "renamed") });
      return true;
    }
    if (k.name === "x") {
      this.app.confirm("Archive this run?", async () => {
        try { await this.app.api.archive(this.id, true); this.app.flash("archived"); this.app.pop(); }
        catch (e) { this.app.flash(e.message, true); }
      });
      return true;
    }

    // ---- routing verbs
    if (k.name === "r") {
      this.phasePicker("re-run from phase…", (phase) =>
        this.app.input({ label: `notes for re-running ${this.states()[phase]?.name}`, onSubmit: (t) => this.act("revise", { phase, message: t }, `re-running ${this.states()[phase]?.name}`) }));
      return true;
    }
    if (k.name === "o") {
      this.phasePicker("rewind to phase (lands paused)…", (phase) =>
        this.app.input({ label: "optional note", placeholder: "enter to just rewind", onSubmit: (t) => this.act("goto", { phase, ...(t.trim() ? { message: t } : {}) }, "rewound — resume with p") }));
      return true;
    }
    if (k.name === "t") {
      this.phasePicker("route to phase…", (phase) => {
        const st = this.states()[phase];
        this.app.input({ label: `instructions for ${st?.name}`, onSubmit: (t) => t.trim() && this.act("routeTo", { state: st.id, message: t }, `routed to ${st.name}`) });
      });
      return true;
    }
    if (k.name === "k") {
      this.phasePicker("re-check watchable phase…", (phase) => this.act("recheck", { phase }, "re-checking"), { onlyWatchable: true });
      return true;
    }
    if (k.name === "N") {
      const st = this.curState();
      if (!st) return true;
      this.app.input({
        label: `note on ${st.name}`,
        onSubmit: async (t) => {
          if (!t.trim()) return;
          try { await this.app.api.addComment(this.id, { state: st.id, body: t }); this.app.flash("note added (feeds the Conductor)"); this.load(); }
          catch (e) { this.app.flash(e.message, true); }
        },
      });
      return true;
    }
    if (k.name === "s") {
      const st = this.curState();
      if (st) this.act("sendComments", { state: st.id }, `sent open comments to ${st.name}`);
      return true;
    }
    if (k.name === "D") {
      this.app.flash("test-drive: booting the app…");
      this.app.api.testDrive(this.id)
        .then((d) => this.app.pager({ title: "test drive", text: testDriveText(d) }))
        .catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "i" || (this.tab === "conductor" && k.name === "u")) {
      this.app.input({
        label: "tell the Conductor",
        onSubmit: async (t) => {
          if (!t.trim()) return;
          try { await this.app.api.conduct(this.id, "talk", { text: t }); this.tab = "conductor"; this.load(); }
          catch (e) { this.app.flash(e.message, true); }
        },
      });
      return true;
    }

    // ---- tab-local
    if (this.tab === "deliverables") return this.keysDeliverables(k);
    if (this.tab === "conductor") return this.keysConductor(k);
    // activity / history scroll
    if (k.name === "up") { this.scroll += 1; return true; }
    if (k.name === "down") { this.scroll = Math.max(0, this.scroll - 1); return true; }
    if (k.name === "pageup") { this.scroll += 20; return true; }
    if (k.name === "pagedown") { this.scroll = Math.max(0, this.scroll - 20); return true; }
    if (k.name === "end") { this.scroll = 0; return true; }
    return false;
  }

  keysDeliverables(k) {
    const arts = this.artifacts;
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(arts.length - 1, this.sel + 1); return true; }
    if (k.name === "enter") {
      const a = arts[this.sel];
      if (!a) return true;
      if (["image", "video", "file"].includes(a.kind)) {
        this.app.pager({ title: a.name, text: `${a.kind} artifact — the body is a workspace file.\n\npath: ${a.body}\n\nopen in a browser:\n${this.app.api.fileUrl(this.id, a.body)}` });
      } else {
        this.app.pager({ title: `${a.name} (${a.kind})`, text: a.body || "(empty)" });
      }
      return true;
    }
    return false;
  }

  keysConductor(k) {
    const proposed = this.conductor.filter((m) => m.status === "proposed");
    if (k.name === "up") { this.scroll += 1; return true; }
    if (k.name === "down") { this.scroll = Math.max(0, this.scroll - 1); return true; }
    if (k.name === "y" && proposed.length) {
      const m = proposed[proposed.length - 1];
      this.app.api.conduct(this.id, "apply", { messageId: m.id })
        .then(() => { this.app.flash("directive applied"); this.load(); })
        .catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "d" && proposed.length) {
      const m = proposed[proposed.length - 1];
      this.app.api.conduct(this.id, "dismiss", { messageId: m.id })
        .then(() => { this.app.flash("dismissed"); this.load(); })
        .catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "Y") {
      this.app.api.conduct(this.id, "synthesize").then(() => this.app.flash("synthesizing…")).catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "v") {
      this.app.api.conduct(this.id, "revert").then(() => { this.app.flash("reverted last route"); this.load(); }).catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "R") {
      const next = this.run.conductor_mode === "auto" ? "propose" : "auto";
      this.app.api.conduct(this.id, "setMode", { mode: next }).then(() => { this.app.flash(`route mode: ${next}`); this.load(); }).catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "E") {
      const next = this.run.conductor_react === "manual" ? "auto" : "manual";
      this.app.api.conduct(this.id, "setReact", { react: next }).then(() => { this.app.flash(`react mode: ${next}`); this.load(); }).catch((e) => this.app.flash(e.message, true));
      return true;
    }
    return false;
  }

  footer() {
    const r = this.run;
    const verbs = [];
    if (r?.status === "awaiting_approval") verbs.push(c.warn("a approve"), c.warn("c changes"));
    if (["idle", "failed"].includes(r?.status)) verbs.push(c.warn("S start"));
    verbs.push("tab panes", "←→ phase", "g graph", "r re-run", "t route", "o rewind", "N note", "i conductor", "p pause", "e goal", "? more");
    return c.dim(verbs.join(" · "));
  }

  help() {
    return `run cockpit
  tab / shift+tab   switch pane (deliverables / activity / history / conductor)
  ← →               inspect another phase (f = follow the run again)
  g                 rail ⇄ graph view
  a / c             approve / request changes (when gated)
  p                 pause ⇄ resume        S   start / retry (idle, failed)
  G                 cycle gate mode (All → Loop → Auto)
  m / M             run mode / models
  r                 re-run a phase with notes (revise)
  o                 rewind to a phase (lands paused)
  t                 route to any phase with instructions
  k                 re-check a watchable phase
  N                 pin a note on the inspected phase (feeds the Conductor)
  s                 send the phase's open comments back to the agent
  i                 talk to the Conductor
  D                 test-drive the built app
  e / T / x         edit goal / rename / archive
  enter             open selected deliverable
conductor pane
  y / d             apply / dismiss the pending proposal
  Y                 ask it to synthesize now
  v                 revert its last route
  R / E             toggle route mode (propose⇄auto) / react mode (auto⇄manual)
`;
  }

  // ---------------------------------------------------------------- render
  render(w, h) {
    const sp = spinAt();
    const r = this.run;
    const lines = [];
    if (!r) {
      lines.push("", "  " + (this.err ? c.err(this.err) : c.dim(sp + " loading run…")));
      return lines;
    }
    const sts = this.states();

    // header
    const viewers = this.presence.filter((p) => p.name !== this.app.api.user).map((p) => p.name);
    lines.push(
      " " + c.faint("←") + " " + c.bold(truncAnsi(r.title || "(untitled)", Math.max(10, w - 58))) +
      "  " + statusChip(r.status, sp) +
      "  " + c.faint(`gate:${gateLabel(r.gate_mode)}`) +
      (r.loop_count ? "  " + c.warn(`↻${r.loop_count}`) : "") +
      (r.mode ? "  " + c.violet(r.mode) : "") +
      "  " + c.faint(modelShort(r.primary_model)) +
      (viewers.length ? "  " + c.brand(`◉ ${viewers.join(", ")}`) : "")
    );
    if (this.err) lines.push(" " + c.err(this.err));

    // phase visualization
    lines.push("");
    const vi = this.viewIdx >= 0 ? this.viewIdx : r.state_index;
    if (this.graph && sts.length) {
      for (const l of dag(sts, r, { viewIdx: vi, sp, width: w - 2 })) lines.push(" " + l);
    } else if (sts.length) {
      for (const l of rail(sts, r, { viewIdx: vi, sp, width: w - 4 })) lines.push("  " + l);
    }

    // banners
    if (r.status === "awaiting_approval" && r.approval_summary) {
      lines.push("");
      const head = wrapText("⏸ needs you — " + r.approval_summary, w - 4).slice(0, 3);
      for (const l of head) lines.push("  " + c.warn(l));
    }
    if (r.status === "failed" && r.last_error) {
      lines.push("");
      for (const l of wrapText("✗ " + r.last_error, w - 4).slice(0, 3)) lines.push("  " + c.err(l));
    }
    if (r.status === "done") {
      lines.push("", "  " + c.ok("✓ shipped") + (r.pr_url ? "  " + c.brand(r.pr_url) : ""));
    }

    // tab bar
    lines.push("");
    const openComments = this.comments.filter((cm) => cm.status === "open").length;
    lines.push(" " + TABS.map((t) => {
      let label = t;
      if (t === "conductor" && this.conductorWorking) label += " " + sp;
      if (t === "deliverables") label += ` ${this.artifacts.length}`;
      if (t === "history" && openComments) label += ` ✎${openComments}`;
      return t === this.tab ? c.inv(c.bold(` ${label} `)) : c.dim(` ${label} `);
    }).join(c.faint("│")));
    lines.push(c.faint(" " + "─".repeat(Math.max(0, w - 2))));

    const bodyH = h - lines.length;
    const body =
      this.tab === "deliverables" ? this.renderDeliverables(w, bodyH) :
      this.tab === "activity" ? this.renderEvents(this.events, w, bodyH, false) :
      this.tab === "history" ? this.renderHistory(w, bodyH) :
      this.renderConductor(w, bodyH, sp);
    lines.push(...body.slice(0, bodyH));
    return lines;
  }

  renderDeliverables(w, h) {
    const arts = this.artifacts;
    if (!arts.length) return ["  " + c.dim("no deliverables yet")];
    const out = [];
    this.sel = Math.min(this.sel, arts.length - 1);
    const top = Math.max(0, Math.min(this.sel - Math.floor(h / 2), arts.length - h));
    const stName = (id) => this.states().find((s) => s.id === id)?.name || id;
    for (let i = top; i < Math.min(arts.length, top + h); i++) {
      const a = arts[i];
      const kindPaint = a.kind === "image" || a.kind === "video" ? c.violet : a.kind === "html" ? c.brand : c.dim;
      const verdict = /fail|✗/i.test(a.name) ? c.err("✗") : /pass|✓/i.test(a.name) ? c.ok("✓") : c.faint("◆");
      let line = ` ${verdict} ` + fit(a.name, Math.min(46, w - 40)) + " " + kindPaint(fit(a.kind, 9)) + c.faint(` ${stName(a.state)} · ${timeAgo(a.created_at)}`);
      if (i === this.sel) line = c.bgSel(fit(line, w));
      out.push(line);
    }
    return out;
  }

  renderEvents(events, w, h, historyMode) {
    const rendered = [];
    for (const ev of events.slice(-600)) rendered.push(...eventLines(ev, w - 4, this.states()));
    if (!rendered.length) return ["  " + c.dim("nothing yet")];
    this.scroll = Math.min(this.scroll, Math.max(0, rendered.length - h));
    const end = rendered.length - this.scroll;
    const out = rendered.slice(Math.max(0, end - h), end).map((l) => "  " + l);
    if (this.scroll > 0) out.push(c.warn(`  ▼ ${this.scroll} newer lines (end key to follow)`));
    return out;
  }

  renderHistory(w, h) {
    const keep = new Set(["state_enter", "approval_request", "approved", "feedback", "reject", "done", "error", "reflect"]);
    const evs = this.events.filter((e) => keep.has(e.type));
    const merged = [
      ...evs.map((e) => ({ at: e.created_at, kind: "ev", e })),
      ...this.comments.map((cm) => ({ at: cm.created_at, kind: "cm", cm })),
    ].sort((a, b) => a.at - b.at);
    const rendered = [];
    for (const it of merged) {
      if (it.kind === "ev") rendered.push(...eventLines(it.e, w - 4, this.states()));
      else {
        const cm = it.cm;
        const status = cm.status === "open" ? c.warn("open") : c.faint("sent");
        rendered.push(c.violet(`✎ ${cm.author || "you"}`) + c.faint(` on ${this.states().find((s) => s.id === cm.state)?.name || cm.state} [${status}] `) + truncAnsi(cm.body || "(image)", w - 40));
      }
    }
    if (!rendered.length) return ["  " + c.dim("nothing yet")];
    this.scroll = Math.min(this.scroll, Math.max(0, rendered.length - h));
    const end = rendered.length - this.scroll;
    return rendered.slice(Math.max(0, end - h), end).map((l) => "  " + l);
  }

  renderConductor(w, h, sp) {
    const out = [];
    const r = this.run;
    out.push(
      "  " + c.violet(c.bold("Conductor")) +
      c.faint(`  route:${r.conductor_mode || "propose"} · react:${r.conductor_react || "auto"}`) +
      (this.conductorWorking ? "  " + c.violet(sp + " " + (this.conductorActivity[this.conductorActivity.length - 1] || "thinking…")) : "")
    );
    out.push("");
    const rendered = [];
    for (const m of this.conductor.slice(-200)) {
      const who = m.role === "you" ? c.bold(m.author || "you") : m.role === "conductor" ? c.violet("conductor") : c.faint("system");
      const status = m.status === "proposed" ? c.warn(" [proposed — y apply · d dismiss]") : m.status === "applied" ? c.ok(" [applied]") : m.status === "dismissed" ? c.faint(" [dismissed]") : "";
      const dir = m.directive ? safeDirective(m.directive) : null;
      for (const l of wrapText(m.body || "", w - 8)) rendered.push(`${who}${status} ${l}`);
      if (dir?.action === "route") rendered.push(c.warn(`  ↪ proposes: route to ${dir.targetName || dir.targetState}`) + (dir.brief ? c.faint(` — ${truncAnsi(dir.brief, w - 30)}`) : ""));
      rendered.push("");
    }
    if (!rendered.length) rendered.push(c.dim("no conversation yet — i to talk, Y to ask for a synthesis"));
    this.scroll = Math.min(this.scroll, Math.max(0, rendered.length - (h - 2)));
    const end = rendered.length - this.scroll;
    out.push(...rendered.slice(Math.max(0, end - (h - 2)), end).map((l) => "  " + l));
    return out;
  }
}

function safeDirective(d) {
  if (typeof d === "object") return d;
  try { return JSON.parse(d); } catch { return null; }
}

function parse(content) {
  try { return JSON.parse(content || "{}"); } catch { return {}; }
}

/** Render one factory event into styled lines. */
export function eventLines(ev, w, states) {
  const d = parse(ev.content);
  const stName = (id) => states?.find((s) => s.id === id)?.name || id;
  switch (ev.type) {
    case "state_enter": {
      const label = ` ${d.name || stName(ev.state)} `;
      const barW = Math.max(0, w - strWidth(label) - 8);
      return ["", c.brand("──") + c.brand(c.bold(label)) + c.brand("─".repeat(barW))];
    }
    case "text": {
      const paint = d.channel === "log" ? c.faint : (s) => s;
      return wrapText(d.text || "", w).map(paint);
    }
    case "tool_call": {
      let args = "";
      try { args = JSON.stringify(d.args); } catch { /* opaque */ }
      return [c.brand("→ " + d.name) + c.faint(" " + truncAnsi(args || "", Math.max(10, w - strWidth(d.name || "") - 4)))];
    }
    case "tool_result": {
      const first = String(d.result ?? "").split("\n")[0];
      return [c.faint("← " + truncAnsi(`${d.name}: ${first}`, w - 2))];
    }
    case "artifact":
      return [c.violet("◆ deliverable ") + c.bold(d.name || "") + c.faint(` (${d.kind})`)];
    case "screenshot":
      return [c.faint(`· scratch screenshot ${d.name || ""}`)];
    case "approval_request":
      return wrapText(`⏸ awaiting approval${d.exhausted ? " (out of turns)" : ""} — ${d.summary || ""}`, w).map((l) => c.warn(l));
    case "approved":
      return [c.ok("✓ approved") + (d.message ? c.dim(" — " + truncAnsi(d.message, w - 14)) : "")];
    case "feedback":
      return wrapText("↩ feedback: " + (d.message || ""), w).map((l) => c.warn(l));
    case "reject":
      return wrapText(`✗ reject → ${stName(d.to)}: ${d.reasons || ""}`, w).map((l) => c.err(l));
    case "done":
      return [c.ok("✓ " + truncAnsi(d.summary || d.message || "done", w - 4))];
    case "error":
      return wrapText("! " + (d.message || "error"), w).map((l) => c.err(l));
    case "reflect":
      return [c.violet("∴ reflect ") + c.faint(truncAnsi(d.message || d.status || "", w - 12))];
    default:
      return [c.faint(truncAnsi(`· ${ev.type}`, w))];
  }
}

function testDriveText(d) {
  const out = [d.ok ? "✓ " + (d.message || "up") : "✗ " + (d.message || "failed")];
  if (d.localUrl) out.push("", "local:  " + d.localUrl);
  if (d.lanUrl) out.push("LAN:    " + d.lanUrl);
  if (d.creds) out.push("", `login:  ${d.creds.email} / ${d.creds.password}`, d.creds.loginUrl ? `at:     ${d.creds.loginUrl}` : "");
  out.push("", "stop it from the web UI or DELETE /api/runs/{id}/test-drive");
  return out.join("\n");
}
