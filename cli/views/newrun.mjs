/**
 * New-run composer — the CLI cousin of the board's "＋ New loop" form.
 * A field list; enter edits each; the last row starts the run and opens
 * its cockpit.
 */
import { c, fit, modelShort, spinAt, truncAnsi } from "../lib/ui.mjs";
import { GATE_MODES, PRIMARY_MODELS, VISION_MODELS, gateLabel } from "../lib/api.mjs";
import { RunView } from "./run.mjs";

export class NewRunView {
  constructor({ machines, projects, machineId } = {}) {
    this.title = "new run";
    this.machines = machines || [];
    this.projects = projects || [];
    this.sel = 0;
    this.busy = false;
    this.form = {
      projectId: "",
      machineId: machineId || "",
      title: "",
      goal: "",
      primaryModel: "claude:opus",
      visionModel: "ollama:kimi-k2.6",
      gateMode: "machine",
      mode: "",
      applyPrinciples: true,
      disabledSteps: [],
    };
  }

  mount(app) {
    this.app = app;
    if (!this.machines.length) this.load();
    else this.initDefaults();
  }
  animating() { return this.busy; }

  async load() {
    try {
      const [m, p] = await Promise.all([this.app.api.machines(), this.app.api.projects()]);
      this.machines = m.machines || [];
      this.projects = p.projects || [];
      this.initDefaults();
    } catch (e) { this.app.flash(e.message, true); }
    this.app.repaint();
  }

  initDefaults() {
    if (!this.form.machineId && this.machines[0]) this.form.machineId = this.machines[0].id;
    if (!this.form.projectId && this.projects[0]) this.form.projectId = this.projects[0].id;
  }

  machine() { return this.machines.find((m) => m.id === this.form.machineId); }
  project() { return this.projects.find((p) => p.id === this.form.projectId); }

  fields() {
    const f = this.form;
    const m = this.machine();
    const modes = m?.settings?.modes || [];
    const optional = (m?.states || []).filter((s) => s.optional);
    const needsVision = !f.primaryModel.startsWith("claude") && f.primaryModel !== "ollama:kimi-k2.6";
    const rows = [
      { key: "project", label: "Repository", value: this.project() ? `${this.project().name} ${c.faint(this.project().repoPath)}` : c.faint("scratch (no repo)") },
      { key: "machine", label: "Loop", value: m ? m.name : c.err("(pick a loop)") },
      { key: "goal", label: "Goal", value: f.goal ? truncAnsi(f.goal.split("\n")[0], 70) : c.warn("(required — enter to write)") },
      { key: "title", label: "Title", value: f.title || c.faint("(from the goal's first line)") },
      { key: "primary", label: "Agent model", value: modelShort(f.primaryModel) },
    ];
    if (needsVision) rows.push({ key: "vision", label: "Vision helper", value: modelShort(f.visionModel) });
    rows.push({ key: "gate", label: "Gate mode", value: gateLabel(f.gateMode) });
    if (modes.length) rows.push({ key: "mode", label: "Mode", value: f.mode || c.faint(`(default${modes.find((x) => x.default) ? ": " + modes.find((x) => x.default).id : ""})`) });
    if (optional.length) rows.push({ key: "skip", label: "Skip phases", value: f.disabledSteps.length ? f.disabledSteps.map((id) => m.states.find((s) => s.id === id)?.name || id).join(", ") : c.faint("(none)") });
    if (m?.settings?.selfLearn) rows.push({ key: "principles", label: "Principles", value: f.applyPrinciples ? "apply learned principles" : "run clean" });
    rows.push({ key: "start", label: "▶ Start run" });
    return rows;
  }

  onKey(k) {
    const fields = this.fields();
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "down") { this.sel = Math.min(fields.length - 1, this.sel + 1); return true; }
    if (k.name !== "enter") return false;

    const f = this.form;
    const m = this.machine();
    switch (fields[this.sel].key) {
      case "project": {
        const items = [
          { label: "scratch (no repo)", value: "" },
          ...this.projects.map((p) => ({ label: p.name, hint: p.repoPath, value: p.id })),
          { label: "+ register a directory…", value: "__add__" },
        ];
        this.app.picker({ title: "repository", items, onChoose: (v) => {
          if (v === "__add__") {
            this.app.input({ label: "absolute path to the repo (~ ok)", onSubmit: async (p) => {
              if (!p.trim()) return;
              try {
                const d = await this.app.api.addProject(p.trim());
                this.projects.push(d.project);
                f.projectId = d.project.id;
                this.app.flash("registered " + d.project.name);
              } catch (e) { this.app.flash(e.message, true); }
              this.app.repaint();
            } });
          } else f.projectId = v;
          this.app.repaint();
        } });
        break;
      }
      case "machine":
        this.app.picker({
          title: "loop",
          items: this.machines.map((x) => ({ label: x.name, hint: (x.states || []).map((s) => s.name).join(" → ").slice(0, 60), value: x.id, selected: x.id === f.machineId })),
          onChoose: (v) => { f.machineId = v; f.mode = ""; f.disabledSteps = []; this.app.repaint(); },
        });
        break;
      case "goal":
        this.app.editText(f.goal, { title: "goal — what should this run accomplish?", onSubmit: (v) => { f.goal = v; this.app.repaint(); } });
        break;
      case "title":
        this.app.input({ label: "title (optional)", value: f.title, onSubmit: (v) => { f.title = v; } });
        break;
      case "primary":
        this.app.picker({ title: "agent model — drives the whole run", items: PRIMARY_MODELS.map((x) => ({ ...x, selected: x.value === f.primaryModel })), onChoose: (v) => { f.primaryModel = v; this.app.repaint(); } });
        break;
      case "vision":
        this.app.picker({ title: "vision / QA helper", items: VISION_MODELS.map((x) => ({ ...x, selected: x.value === f.visionModel })), onChoose: (v) => { f.visionModel = v; } });
        break;
      case "gate":
        this.app.picker({ title: "gate mode", items: GATE_MODES.map((g) => ({ ...g, selected: g.value === f.gateMode })), onChoose: (v) => { f.gateMode = v; } });
        break;
      case "mode": {
        const modes = m?.settings?.modes || [];
        this.app.picker({
          title: "run mode",
          items: [{ label: "(loop default)", value: "" }, ...modes.map((x) => ({ label: x.label || x.id, hint: x.hint || "", value: x.id }))],
          onChoose: (v) => { f.mode = v; },
        });
        break;
      }
      case "skip": {
        const optional = (m?.states || []).filter((s) => s.optional);
        this.app.picker({
          title: "skip optional phases",
          multi: true,
          items: optional.map((s) => ({ label: s.name, value: s.id, checked: f.disabledSteps.includes(s.id) })),
          onChoose: (values) => { f.disabledSteps = values; },
        });
        break;
      }
      case "principles":
        f.applyPrinciples = !f.applyPrinciples;
        break;
      case "start":
        this.start();
        break;
    }
    return true;
  }

  async start() {
    const f = this.form;
    if (!f.goal.trim()) return this.app.flash("a goal is required", true);
    if (!f.machineId) return this.app.flash("pick a loop", true);
    this.busy = true;
    this.app.repaint();
    try {
      const d = await this.app.api.createRun({
        goal: f.goal,
        machineId: f.machineId,
        projectId: f.projectId || undefined,
        title: f.title || undefined,
        primaryModel: f.primaryModel,
        visionModel: f.visionModel,
        gateMode: f.gateMode,
        mode: f.mode || undefined,
        applyPrinciples: f.applyPrinciples,
        disabledSteps: f.disabledSteps,
      });
      this.busy = false;
      this.app.flash("run started");
      this.app.views.pop(); // replace the composer with the cockpit
      this.app.push(new RunView(d.run.id));
    } catch (e) {
      this.busy = false;
      this.app.flash(e.message, true);
    }
  }

  footer() { return c.dim("↑↓ field · enter edit · esc cancel"); }

  render(w, h) {
    const lines = [
      " " + c.bold(c.brand("ATELIER")) + c.faint(" · new run") + (this.busy ? "  " + c.brand(spinAt() + " starting…") : ""),
      "",
    ];
    const m = this.machine();
    this.sel = Math.min(this.sel, this.fields().length - 1);
    this.fields().forEach((f, i) => {
      let line = `   ${c.bold(fit(f.label, 14))} ${truncAnsi(f.value ?? "", w - 22)}`;
      if (f.key === "start") line = `   ${this.form.goal.trim() ? c.ok(c.bold(f.label)) : c.dim(f.label)}`;
      if (i === this.sel) line = c.bgSel(fit(c.brand("▌") + line.slice(1), w));
      lines.push(line);
    });
    if (m?.states?.length) {
      lines.push("", c.faint("   phases: ") + truncAnsi(m.states.filter((s) => !s.offPath).map((s) => s.name).join(c.faint(" → ")), w - 12));
    }
    if (this.form.goal) {
      lines.push("", c.faint("   goal"), ...this.form.goal.split("\n").slice(0, Math.max(0, h - lines.length - 1)).map((l) => "   " + c.dim(truncAnsi(l, w - 5))));
    }
    return lines;
  }
}
