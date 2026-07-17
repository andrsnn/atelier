/**
 * Loop library — every machine, with its phase chain. Enter opens the editor;
 * n creates, d duplicates, g drafts a whole loop from a description (AI).
 */
import { c, fit, spinAt, truncAnsi } from "../lib/ui.mjs";
import { EditorView } from "./editor.mjs";
import { NewRunView } from "./newrun.mjs";

export class LoopsView {
  constructor() {
    this.title = "loops";
    this.machines = [];
    this.tools = [];
    this.sel = 0;
    this.loaded = false;
    this.busy = "";
    this.err = "";
  }

  mount(app) { this.app = app; this.load(); }
  wake() { this.load(); }
  animating() { return !!this.busy; }

  async load() {
    try {
      const d = await this.app.api.machines();
      this.machines = d.machines || [];
      this.tools = d.tools || [];
      this.err = "";
      this.loaded = true;
    } catch (e) { this.err = e.message; }
    this.app.repaint();
  }

  onKey(k) {
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(this.machines.length - 1, this.sel + 1); return true; }
    if (k.name === "enter") {
      const m = this.machines[this.sel];
      if (m) this.app.push(new EditorView(m.id));
      return true;
    }
    if (k.name === "n") {
      this.app.input({
        label: "new loop name",
        onSubmit: async (name) => {
          try {
            const d = await this.app.api.createMachine({ name: name.trim() || "Untitled loop", states: [] });
            this.app.push(new EditorView(d.machine.id));
          } catch (e) { this.app.flash(e.message, true); }
        },
      });
      return true;
    }
    if (k.name === "d") {
      const m = this.machines[this.sel];
      if (!m) return true;
      this.app.api.duplicateMachine(m.id)
        .then(() => { this.app.flash(`duplicated ${m.name}`); this.load(); })
        .catch((e) => this.app.flash(e.message, true));
      return true;
    }
    if (k.name === "g") {
      this.app.input({
        label: "describe the loop you want (AI drafts it — ctrl+e for room)",
        onSubmit: async (description) => {
          if (!description.trim()) return;
          this.busy = "drafting loop…";
          this.app.repaint();
          try {
            const d = await this.app.api.generateMachine(description);
            this.busy = "";
            this.app.flash(`drafted "${d.machine.name}"`);
            this.app.push(new EditorView(d.machine.id));
          } catch (e) { this.busy = ""; this.app.flash(e.message, true); }
        },
      });
      return true;
    }
    if (k.name === "r") {
      const m = this.machines[this.sel];
      if (m) this.app.push(new NewRunView({ machineId: m.id }));
      return true;
    }
    if (k.name === "R") { this.load(); this.app.flash("refreshed"); return true; }
    return false;
  }

  footer() {
    return c.dim("↑↓ select · enter edit · r run this loop · n new · d duplicate · g generate with AI · R refresh · esc back");
  }

  help() {
    return `loops (machines)
  enter        open the loop editor
  r            start a new run with the selected loop
  n            create an empty loop
  d            duplicate the selected loop
  g            describe a loop in plain English — the AI drafts it
  R            refresh
`;
  }

  render(w, h) {
    const lines = [" " + c.bold(c.brand("ATELIER")) + c.faint(" · loops") + "  " + c.faint(`${this.machines.length} loop${this.machines.length === 1 ? "" : "s"}`), ""];
    if (this.err) { lines.push("  " + c.err(this.err)); return lines; }
    if (this.busy) { lines.push("  " + c.violet(spinAt() + " " + this.busy)); return lines; }
    if (!this.loaded) { lines.push("  " + c.dim(spinAt() + " loading…")); return lines; }
    if (!this.machines.length) { lines.push("  " + c.dim("no loops — n to create, g to generate one from a description")); return lines; }

    const per = 4;
    const fitCount = Math.floor((h - 3) / per);
    const top = Math.max(0, Math.min(this.sel - Math.floor(fitCount / 2), this.machines.length - fitCount));
    for (let i = top; i < Math.min(this.machines.length, top + fitCount); i++) {
      const m = this.machines[i];
      const selMark = i === this.sel ? c.brand("▌") : " ";
      const wf = m.settings?.workflow ? c.brand(" ⚡workflow") : "";
      const learn = m.settings?.selfLearn ? c.violet(" ∴learn") : "";
      const chain = (m.states || []).filter((s) => !s.offPath).map((s) => s.name).join(c.faint(" → "));
      const leaves = (m.states || []).filter((s) => s.offPath);
      let l1 = selMark + " " + c.bold(truncAnsi(m.name, w - 30)) + wf + learn;
      let l2 = selMark + "   " + truncAnsi(chain || c.faint("(no states)"), w - 6) + (leaves.length ? c.brandDim(`  ◇${leaves.length}`) : "");
      let l3 = selMark + "   " + c.faint(truncAnsi((m.description || "").split("\n")[0], w - 6));
      if (i === this.sel) { l1 = c.bgSel(fit(l1, w)); l2 = c.bgSel(fit(l2, w)); l3 = c.bgSel(fit(l3, w)); }
      lines.push(l1, l2, l3, "");
    }
    return lines;
  }
}
