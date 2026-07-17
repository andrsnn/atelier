/**
 * Loop editor — author a machine in the terminal. A field list over the
 * loop's name/description/limits plus one row per state; enter drills into
 * a state (prompt opens in $EDITOR, tools are a multi-select). The graph
 * preview at the top re-renders as you edit. AI chat-edit included ('i').
 *
 * Nothing here interprets what a state means — it edits config: a prompt,
 * a tool list, wiring. The engine stays generic.
 */
import { c, fit, spinAt, truncAnsi } from "../lib/ui.mjs";
import { dag } from "../lib/graph.mjs";

const MODEL_PINS = [
  { value: "", label: "(inherit the run's model)" },
  { value: "claude:opus", label: "Claude Opus (multimodal)" },
  { value: "claude:sonnet", label: "Claude Sonnet 5 (multimodal)" },
  { value: "ollama:kimi-k2.6", label: "Kimi K2.6 (multimodal)" },
  { value: "ollama:glm-5.2:cloud", label: "GLM 5.2" },
  { value: "ollama:qwen3-coder:480b", label: "Qwen3-Coder 480B" },
  { value: "ollama:deepseek-v3.2", label: "DeepSeek v3.2" },
];

export class EditorView {
  constructor(machineId) {
    this.title = "editor";
    this.id = machineId;
    this.m = null;       // working copy
    this.tools = [];
    this.sel = 0;
    this.dirty = false;
    this.showGraph = true;
    this.busy = "";
    this.err = "";
  }

  mount(app) { this.app = app; this.load(); }
  animating() { return !!this.busy; }

  async load() {
    try {
      const d = await this.app.api.machine(this.id);
      this.m = d.machine;
      this.tools = d.tools || [];
      this.dirty = false;
      this.err = "";
    } catch (e) { this.err = e.message; }
    this.app.repaint();
  }

  /** The flat, navigable field list. */
  rows() {
    if (!this.m) return [];
    const s = this.m.settings || {};
    const rows = [
      { kind: "name", label: "Name", value: this.m.name },
      { kind: "description", label: "Description", value: (this.m.description || "").split("\n")[0] },
      { kind: "limits", label: "Limits", value: `maxLoops ${s.maxLoops ?? 10} · maxTurns ${s.maxTurns ?? 120} · timeout ${s.phaseTimeoutMin ?? 45}m` },
      { kind: "selfLearn", label: "Self-learning", value: s.selfLearn ? "on" + (s.evolveStructure ? " · evolves structure" : "") : "off" },
    ];
    (this.m.states || []).forEach((st, i) => rows.push({ kind: "state", i, st }));
    rows.push({ kind: "add", label: "+ add state" });
    rows.push({ kind: "save", label: this.dirty ? "save changes ●" : "saved ✓" });
    return rows;
  }

  markDirty() { this.dirty = true; }

  stateName(id) { return this.m.states.find((s) => s.id === id)?.name || id; }

  onKey(k) {
    if (!this.m) return false;
    const rows = this.rows();
    const row = rows[this.sel];

    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(rows.length - 1, this.sel + 1); return true; }
    if (k.name === "g") { this.showGraph = !this.showGraph; return true; }
    if (k.name === "S" || (k.ctrl && k.name === "s")) { this.save(); return true; }
    if (k.name === "i") { this.aiChat(); return true; }
    if (k.name === "escape" || k.name === "q") {
      if (this.dirty) this.app.confirm("Discard unsaved changes?", () => this.app.pop());
      else this.app.pop();
      return true;
    }

    if (row?.kind === "state") {
      if (k.name === "enter") { this.app.push(new StateEditor(this, row.i)); return true; }
      if (k.name === "d") {
        this.app.confirm(`Delete state "${row.st.name}"?`, () => {
          this.m.states.splice(row.i, 1);
          this.markDirty();
          this.app.repaint();
        });
        return true;
      }
      if (k.name === "K" && row.i > 0) {
        const s = this.m.states.splice(row.i, 1)[0];
        this.m.states.splice(row.i - 1, 0, s);
        this.sel--; this.markDirty();
        return true;
      }
      if (k.name === "J" && row.i < this.m.states.length - 1) {
        const s = this.m.states.splice(row.i, 1)[0];
        this.m.states.splice(row.i + 1, 0, s);
        this.sel++; this.markDirty();
        return true;
      }
    }

    if (k.name === "enter") {
      if (row?.kind === "name") {
        this.app.input({ label: "loop name", value: this.m.name, onSubmit: (v) => { this.m.name = v; this.markDirty(); } });
      } else if (row?.kind === "description") {
        this.app.editText(this.m.description || "", { title: "description", onSubmit: (v) => { this.m.description = v; this.markDirty(); } });
      } else if (row?.kind === "limits") {
        this.editLimits();
      } else if (row?.kind === "selfLearn") {
        const s = this.m.settings || (this.m.settings = {});
        this.app.picker({
          title: "self-learning",
          items: [
            { label: "off", value: "off" },
            { label: "on — record principles from feedback", value: "on" },
            { label: "on + evolve structure", value: "evolve" },
          ],
          onChoose: (v) => {
            s.selfLearn = v !== "off";
            s.evolveStructure = v === "evolve";
            this.markDirty(); this.app.repaint();
          },
        });
      } else if (row?.kind === "add") {
        this.app.input({
          label: "new state name",
          onSubmit: (name) => {
            if (!name.trim()) return;
            const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `state-${this.m.states.length + 1}`;
            this.m.states.push({ id, name: name.trim(), prompt: "", tools: ["read_file", "list_directory", "display_artifact"] });
            this.markDirty();
            this.sel = this.rows().findIndex((r) => r.kind === "state" && r.st.id === id);
            this.app.push(new StateEditor(this, this.m.states.length - 1));
          },
        });
      } else if (row?.kind === "save") {
        this.save();
      }
      return true;
    }
    return false;
  }

  editLimits() {
    const s = this.m.settings || (this.m.settings = {});
    const ask = (label, key, cur, next) => this.app.input({
      label, value: String(cur),
      onSubmit: (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) { s[key] = n; this.markDirty(); }
        next?.();
      },
    });
    ask("max reject/retry loops", "maxLoops", s.maxLoops ?? 10, () =>
      ask("max tool calls per phase", "maxTurns", s.maxTurns ?? 120, () =>
        ask("phase timeout (minutes)", "phaseTimeoutMin", s.phaseTimeoutMin ?? 45)));
  }

  aiChat() {
    this.app.input({
      label: 'edit with AI — e.g. "add a QA phase after Build" (ctrl+e for room)',
      onSubmit: async (message) => {
        if (!message.trim()) return;
        if (this.dirty) return this.app.flash("save (S) before AI edits — they apply server-side", true);
        this.busy = "the AI is editing the loop…";
        this.app.repaint();
        try {
          const d = await this.app.api.chatMachine(this.id, message);
          this.m = d.machine;
          this.busy = "";
          this.app.pager({ title: "AI edit", text: d.reply || "done" });
        } catch (e) { this.busy = ""; this.app.flash(e.message, true); }
      },
    });
  }

  async save() {
    try {
      const { name, description, states, settings } = this.m;
      const d = await this.app.api.saveMachine(this.id, { name, description, states, settings });
      this.m = d.machine;
      this.dirty = false;
      this.app.flash("saved");
    } catch (e) { this.app.flash(e.message, true); }
    this.app.repaint();
  }

  footer() {
    return c.dim("↑↓ field · enter edit · d delete state · K/J move state · g graph · i AI edit · S save · esc back");
  }

  help() {
    return `loop editor
  enter        edit the selected field / open the state
  d            delete the selected state
  K / J        move the selected state up / down (pipeline order)
  g            toggle the graph preview
  i            edit the loop with AI, in plain English
  S / ctrl+s   save to the factory
state fields (enter on a state): name, prompt ($EDITOR), tools
  (multi-select), model pin, gate, reject-to, off-path/return, max turns
`;
  }

  render(w, h) {
    const lines = [];
    if (!this.m) {
      lines.push("", "  " + (this.err ? c.err(this.err) : c.dim(spinAt() + " loading…")));
      return lines;
    }
    lines.push(
      " " + c.bold(c.brand("ATELIER")) + c.faint(" · editor · ") + c.bold(truncAnsi(this.m.name, w - 40)) +
      (this.dirty ? c.warn("  ● unsaved") : c.faint("  saved")) +
      (this.busy ? "  " + c.violet(spinAt() + " " + this.busy) : "")
    );
    lines.push("");
    if (this.showGraph && this.m.states?.length) {
      const focus = this.rows()[this.sel];
      for (const l of dag(this.m.states, null, { width: w - 2, viewIdx: focus?.kind === "state" ? focus.i : -1 })) lines.push(" " + l);
      lines.push("");
    }

    const rows = this.rows();
    const listH = h - lines.length;
    const top = Math.max(0, Math.min(this.sel - Math.floor(listH / 2), rows.length - listH));
    for (let i = top; i < Math.min(rows.length, top + listH); i++) {
      const row = rows[i];
      let line;
      if (row.kind === "state") {
        const st = row.st;
        const flags = [
          st.gate ? c.warn("gate") : null,
          st.rejectTo ? c.warn(`↩${this.stateName(st.rejectTo)}`) : null,
          st.offPath ? c.brandDim(`◇→${st.returnTo ? this.stateName(st.returnTo) : "?"}`) : null,
          st.optional ? c.dim("optional") : null,
          st.model ? c.violet(`pin:${st.model.split(":").slice(-1)[0]}`) : null,
          st.maxTurns ? c.dim(`${st.maxTurns}turns`) : null,
        ].filter(Boolean).join(c.faint(" · "));
        line = `   ${c.faint(String(row.i + 1).padStart(2))} ${c.bold(fit(st.name, 20))} ${c.dim(`${(st.tools || []).length} tools`)}  ${flags}`;
      } else {
        line = `   ${c.bold(fit(row.label, 16))} ${row.kind === "save" ? (this.dirty ? c.warn(row.value ?? "") : c.ok("")) : c.dim(truncAnsi(row.value ?? "", w - 24))}`;
        if (row.kind === "save") line = `   ${this.dirty ? c.warn(c.bold(row.label)) : c.ok(row.label)}`;
      }
      if (i === this.sel) line = c.bgSel(fit(c.brand("▌") + line.slice(1), w));
      lines.push(line);
    }
    return lines;
  }
}

/** Drill-in editor for one state: a small field list of its config. */
class StateEditor {
  constructor(parent, idx) {
    this.title = "state";
    this.parent = parent;
    this.idx = idx;
    this.sel = 0;
  }

  mount(app) { this.app = app; }
  get st() { return this.parent.m.states[this.idx]; }
  get states() { return this.parent.m.states; }

  fields() {
    const st = this.st;
    return [
      { key: "name", label: "Name", value: st.name },
      { key: "prompt", label: "Prompt", value: (st.prompt || "").split("\n")[0] || c.faint("(empty — enter to write)") },
      { key: "tools", label: "Tools", value: (st.tools || []).join(", ") || c.faint("(none)") },
      { key: "model", label: "Model pin", value: st.model || c.faint("(inherit)") },
      { key: "gate", label: "Gate", value: st.gate ? c.warn("pause for approval") : "auto-continue" },
      { key: "rejectTo", label: "Reject → ", value: st.rejectTo ? this.parent.stateName(st.rejectTo) : c.faint("(surface to human)") },
      { key: "offPath", label: "Off-path", value: st.offPath ? `branch, rejoins → ${st.returnTo ? this.parent.stateName(st.returnTo) : "?"}` : "on the main path" },
      { key: "optional", label: "Optional", value: st.optional ? "human may skip per-run" : "always runs" },
      { key: "maxTurns", label: "Max turns", value: st.maxTurns ? String(st.maxTurns) : c.faint("(loop default)") },
    ];
  }

  statePicker(title, allowNone, onChoose) {
    const items = this.states
      .filter((s) => s.id !== this.st.id)
      .map((s) => ({ label: s.name, hint: s.id, value: s.id }));
    if (allowNone) items.unshift({ label: "(none)", value: "" });
    this.app.picker({ title, items, onChoose });
  }

  onKey(k) {
    const fields = this.fields();
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(fields.length - 1, this.sel + 1); return true; }
    if (k.name !== "enter") return false;

    const st = this.st;
    const dirty = () => { this.parent.markDirty(); this.app.repaint(); };
    switch (fields[this.sel].key) {
      case "name":
        this.app.input({ label: "state name", value: st.name, onSubmit: (v) => { if (v.trim()) { st.name = v.trim(); dirty(); } } });
        break;
      case "prompt":
        this.app.editText(st.prompt || "", { title: `prompt for ${st.name}`, onSubmit: (v) => { st.prompt = v; dirty(); } });
        break;
      case "tools":
        this.app.picker({
          title: `tools for ${st.name} (request_approval/reject/complete are always on)`,
          multi: true,
          items: this.parent.tools.map((t) => ({
            label: t.name || t,
            hint: t.description ? String(t.description).slice(0, 60) : "",
            value: t.name || t,
            checked: (st.tools || []).includes(t.name || t),
          })),
          onChoose: (values) => { st.tools = values; dirty(); },
        });
        break;
      case "model":
        this.app.picker({ title: "pin a model to this phase", items: MODEL_PINS.map((m) => ({ ...m, selected: (st.model || "") === m.value })), onChoose: (v) => { st.model = v || undefined; dirty(); } });
        break;
      case "gate":
        st.gate = !st.gate; dirty();
        break;
      case "rejectTo":
        this.statePicker("on reject, loop back to…", true, (v) => { st.rejectTo = v || undefined; dirty(); });
        break;
      case "offPath":
        if (!st.offPath) {
          this.statePicker("off-path branch — rejoin the main path at…", false, (v) => { st.offPath = true; st.returnTo = v; dirty(); });
        } else { st.offPath = false; st.returnTo = undefined; dirty(); }
        break;
      case "optional":
        st.optional = !st.optional; dirty();
        break;
      case "maxTurns":
        this.app.input({ label: "max tool calls for this phase (empty = loop default)", value: st.maxTurns ? String(st.maxTurns) : "", onSubmit: (v) => {
          const n = parseInt(v, 10);
          st.maxTurns = Number.isNaN(n) || n <= 0 ? undefined : n;
          dirty();
        } });
        break;
    }
    return true;
  }

  footer() { return c.dim("↑↓ field · enter edit/toggle · esc back to loop"); }

  render(w, h) {
    const st = this.st;
    const lines = [
      " " + c.bold(c.brand("ATELIER")) + c.faint(" · state · ") + c.bold(st.name) + c.faint(` (${st.id})`) + (this.parent.dirty ? c.warn("  ● unsaved") : ""),
      "",
    ];
    const fields = this.fields();
    fields.forEach((f, i) => {
      let line = `   ${c.bold(fit(f.label, 12))} ${truncAnsi(f.value, w - 20)}`;
      if (i === this.sel) line = c.bgSel(fit(c.brand("▌") + line.slice(1), w));
      lines.push(line);
    });
    lines.push("", c.faint("   prompt preview"), c.faint("   ─".repeat(1) + "─".repeat(Math.max(0, w - 6))));
    for (const l of (st.prompt || "(empty)").split("\n").slice(0, Math.max(3, h - lines.length - 1))) {
      lines.push("   " + c.dim(truncAnsi(l, w - 5)));
    }
    return lines;
  }
}
