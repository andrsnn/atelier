/**
 * The TUI shell: a stack of views, a stack of overlays (picker / input /
 * pager / confirm), a shared render loop, and $EDITOR hand-off for long text.
 *
 * A view is an object:
 *   { title, mount(app), unmount?(), tick?(now), onKey(key) -> bool,
 *     render(w, h) -> lines[], footer() -> styled hint string }
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c, fit, spinAt, strWidth, truncAnsi, wrapText } from "./ui.mjs";

export class App {
  constructor({ term, api, cfg = {} }) {
    this.term = term;
    this.api = api;
    this.cfg = cfg;
    this.views = [];
    this.overlays = [];
    this.msg = null; // { text, err, until }
    this._dirty = true;
    this._quit = false;
  }

  // ---------------------------------------------------------------- views
  current() { return this.views[this.views.length - 1]; }
  push(view) { this.views.push(view); view.mount?.(this); this.repaint(); }
  pop() {
    if (this.views.length <= 1) return;
    const v = this.views.pop();
    v.unmount?.();
    this.current()?.wake?.();
    this.repaint();
  }
  replace(view) {
    const v = this.views.pop();
    v?.unmount?.();
    this.push(view);
  }

  // -------------------------------------------------------------- overlays
  overlay() { return this.overlays[this.overlays.length - 1]; }
  openOverlay(o) { this.overlays.push(o); this.repaint(); }
  closeOverlay() { this.overlays.pop(); this.repaint(); }

  picker(opts) { this.openOverlay(new Picker(this, opts)); }
  input(opts) { this.openOverlay(new Input(this, opts)); }
  pager(opts) { this.openOverlay(new Pager(this, opts)); }
  confirm(text, onYes) {
    this.picker({ title: text, items: [
      { label: "No", value: false },
      { label: "Yes", value: true },
    ], onChoose: (v) => { if (v) onYes(); } });
  }

  flash(text, err = false) {
    this.msg = { text: String(text), err, until: Date.now() + (err ? 6000 : 3500) };
    this.repaint();
  }

  /**
   * Edit multi-line text in $EDITOR (suspends the TUI). Falls back to the
   * inline input bar when no usable editor/TTY is available.
   */
  editText(initial, { title = "edit", onSubmit }) {
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (editor && process.stdin.isTTY) {
      const dir = mkdtempSync(join(tmpdir(), "atelier-"));
      const file = join(dir, "text.md");
      writeFileSync(file, initial ?? "");
      this.term.suspend();
      const r = spawnSync(editor, [file], { stdio: "inherit" });
      this.term.resume();
      this.repaint();
      let text = initial;
      if (r.status === 0) text = readFileSync(file, "utf8").replace(/\n$/, "");
      rmSync(dir, { recursive: true, force: true });
      if (r.status === 0) onSubmit(text);
      else this.flash("editor exited nonzero — kept previous text", true);
    } else {
      this.input({ label: `${title} (no $EDITOR — single line)`, value: (initial ?? "").replace(/\n/g, " "), onSubmit });
    }
  }

  // ---------------------------------------------------------------- loop
  start(rootView) {
    this.term.start();
    this.term.on("key", (k) => this.onKey(k));
    this.term.on("resize", () => this.repaint());
    this.push(rootView);
    this._timer = setInterval(() => {
      const now = Date.now();
      this.current()?.tick?.(now);
      if (this.msg && now > this.msg.until) { this.msg = null; this._dirty = true; }
      // animate spinner while anything is in flight
      if (this.current()?.animating?.()) this._dirty = true;
      if (this._dirty) this.render();
    }, 100);
    this.render();
  }

  quit() {
    this._quit = true;
    clearInterval(this._timer);
    this.term.stop();
    process.exit(0);
  }

  onKey(key) {
    if (this._quit) return;
    if (key.ctrl && key.name === "c") return this.quit();
    const o = this.overlay();
    if (o) { o.onKey(key); this.repaint(); return; }
    const v = this.current();
    if (v?.onKey?.(key)) { this.repaint(); return; }
    // global fallbacks
    if (key.name === "q" || key.name === "escape") {
      if (this.views.length > 1) this.pop();
      else if (key.name === "q") this.quit();
      return;
    }
    if (key.name === "?") return this.showHelp();
    this.repaint();
  }

  showHelp() {
    const v = this.current();
    this.pager({ title: "help", text: (v?.help?.() || "") + GLOBAL_HELP });
  }

  repaint() { this._dirty = true; }

  render() {
    this._dirty = false;
    const w = this.term.cols;
    const h = this.term.rows;
    const v = this.current();
    if (!v) return;
    let lines;
    try {
      lines = v.render(w, h - 1) || [];
    } catch (e) {
      lines = ["", "  " + c.err("render error: " + e.message), ...String(e.stack || "").split("\n").slice(1, 8).map((l) => c.faint("  " + l))];
    }
    lines = lines.slice(0, h - 1).map((l) => truncAnsi(l, w));
    while (lines.length < h - 1) lines.push("");

    // footer: keybar (or overlay hint) + flash + connection identity
    const o = this.overlay();
    let left = o?.footer?.() ?? v.footer?.() ?? "";
    if (this.msg) left = (this.msg.err ? c.err("✗ " + this.msg.text) : c.ok("✓ " + this.msg.text)) + "  " + c.faint("·") + "  " + left;
    const right = c.faint(`${this.api.user} @ ${this.api.baseUrl.replace(/^https?:\/\//, "")}  ? help`);
    const pad = Math.max(1, w - strWidth(left) - strWidth(right) - 2);
    lines.push(truncAnsi(" " + left + " ".repeat(pad) + right, w));

    for (const ov of this.overlays) ov.paint(lines, w, h);
    this.term.draw(lines);
  }
}

const GLOBAL_HELP = `

everywhere
  ?            this help
  esc / q      back (q at the board quits)
  ctrl+c       quit
`;

// ==================================================================== Picker

class Picker {
  /**
   * opts: { title, items: [{label, hint?, value, checked?}], sel?, multi?,
   *         onChoose(value | values[]), onCancel? }
   */
  constructor(app, opts) {
    this.app = app;
    this.o = opts;
    this.items = opts.items.map((it) => ({ ...it }));
    this.sel = Math.max(0, opts.sel ?? this.items.findIndex((i) => i.selected));
    this.filter = "";
    this.top = 0;
  }

  visible() {
    if (!this.filter) return this.items;
    const f = this.filter.toLowerCase();
    return this.items.filter((i) => (i.label + " " + (i.hint || "")).toLowerCase().includes(f));
  }

  onKey(k) {
    const vis = this.visible();
    if (k.name === "escape") { this.app.closeOverlay(); this.o.onCancel?.(); return; }
    if (k.name === "up") { this.sel = Math.max(0, this.sel - 1); return; }
    if (k.name === "down") { this.sel = Math.min(vis.length - 1, this.sel + 1); return; }
    if (k.name === "pageup") { this.sel = Math.max(0, this.sel - 10); return; }
    if (k.name === "pagedown") { this.sel = Math.min(vis.length - 1, this.sel + 10); return; }
    if (k.name === "enter") {
      this.app.closeOverlay();
      if (this.o.multi) this.o.onChoose(this.items.filter((i) => i.checked).map((i) => i.value));
      else if (vis[this.sel]) this.o.onChoose(vis[this.sel].value);
      else this.o.onCancel?.();
      return;
    }
    if (this.o.multi && (k.ch === " " || (k.ctrl && k.name === "s"))) {
      if (vis[this.sel]) vis[this.sel].checked = !vis[this.sel].checked;
      return;
    }
    if (k.name === "backspace") { this.filter = this.filter.slice(0, -1); this.sel = 0; return; }
    if (k.ch && k.ch !== " ") { this.filter += k.ch; this.sel = 0; }
  }

  footer() {
    return c.dim(this.o.multi ? "space toggle · enter done · type to filter · esc cancel" : "↑↓ choose · enter select · type to filter · esc cancel");
  }

  paint(lines, w, h) {
    const vis = this.visible();
    const boxW = Math.min(Math.max(strWidth(this.o.title || "") + 6, 46), w - 4);
    const listH = Math.min(vis.length, Math.max(4, h - 10));
    const x0 = Math.floor((w - boxW) / 2);
    const y0 = Math.max(1, Math.floor((h - listH - 4) / 2));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + listH) this.top = this.sel - listH + 1;

    const row = (content) => " ".repeat(x0) + content;
    const inner = boxW - 4;
    let y = y0;
    const title = truncAnsi(this.o.title || "select", inner - 2);
    lines[y++] = row(c.brand("╭─ ") + c.bold(title) + " " + c.brand("─".repeat(Math.max(0, inner - strWidth(title) - 1)) + "─╮"));
    lines[y++] = row(c.brand("│ ") + fit(this.filter ? c.warn("/" + this.filter) : c.faint(vis.length + " options"), inner) + c.brand(" │"));
    for (let i = this.top; i < Math.min(vis.length, this.top + listH); i++) {
      const it = vis[i];
      const mark = this.o.multi ? (it.checked ? c.ok("[x] ") : c.dim("[ ] ")) : "";
      let label = mark + it.label + (it.hint ? "  " + c.faint(it.hint) : "");
      let line = fit(label, inner);
      if (i === this.sel) line = c.bgSel(c.bold(fit(mark + it.label + (it.hint ? "  " + it.hint : ""), inner)));
      lines[y++] = row(c.brand("│ ") + line + c.brand(" │"));
    }
    if (!vis.length) lines[y++] = row(c.brand("│ ") + fit(c.faint("no match"), inner) + c.brand(" │"));
    lines[y++] = row(c.brand("╰" + "─".repeat(boxW - 2) + "╯"));
  }
}

// ==================================================================== Input

class Input {
  /** opts: { label, value?, placeholder?, onSubmit(text), onCancel? } */
  constructor(app, opts) {
    this.app = app;
    this.o = opts;
    this.value = opts.value ?? "";
    this.cur = this.value.length;
  }

  onKey(k) {
    if (k.name === "escape") { this.app.closeOverlay(); this.o.onCancel?.(); return; }
    if (k.name === "enter") { this.app.closeOverlay(); this.o.onSubmit(this.value); return; }
    if (k.name === "backspace") {
      if (this.cur > 0) { this.value = this.value.slice(0, this.cur - 1) + this.value.slice(this.cur); this.cur--; }
      return;
    }
    if (k.name === "delete") { this.value = this.value.slice(0, this.cur) + this.value.slice(this.cur + 1); return; }
    if (k.name === "left") { this.cur = Math.max(0, this.cur - 1); return; }
    if (k.name === "right") { this.cur = Math.min(this.value.length, this.cur + 1); return; }
    if (k.name === "home") { this.cur = 0; return; }
    if (k.name === "end") { this.cur = this.value.length; return; }
    if (k.ctrl && k.name === "u") { this.value = ""; this.cur = 0; return; }
    if (k.ctrl && k.name === "e") {
      // pop into $EDITOR for room to write
      const { onSubmit, onCancel, label } = this.o;
      this.app.closeOverlay();
      this.app.editText(this.value, { title: label, onSubmit });
      return;
    }
    if (k.ch) { this.value = this.value.slice(0, this.cur) + k.ch + this.value.slice(this.cur); this.cur += k.ch.length; }
  }

  footer() { return c.dim("enter submit · ctrl+e open $EDITOR · esc cancel"); }

  paint(lines, w, h) {
    const y0 = h - 4;
    lines[y0] = truncAnsi(" " + c.warn("▸ ") + c.bold(this.o.label || "input"), w);
    // draw the value with a visible cursor cell
    const before = this.value.slice(0, this.cur);
    const at = this.value[this.cur] || " ";
    const after = this.value.slice(this.cur + 1);
    let shown = before + "\x1b[7m" + at + "\x1b[27m" + after;
    if (!this.value && this.o.placeholder) shown = "\x1b[7m \x1b[27m" + c.faint(this.o.placeholder);
    // keep the cursor in view for long values
    const avail = w - 5;
    if (strWidth(before) > avail - 10) {
      const cut = strWidth(before) - (avail - 10);
      shown = c.faint("…") + before.slice(cut) + "\x1b[7m" + at + "\x1b[27m" + after;
    }
    lines[y0 + 1] = truncAnsi("   " + shown, w);
    lines[y0 + 2] = "";
  }
}

// ==================================================================== Pager

class Pager {
  /** opts: { title, text? , lines?, raw? } — scrollable full-screen reader */
  constructor(app, opts) {
    this.app = app;
    this.o = opts;
    this.top = 0;
    this.h = app.term.rows;
    const w = app.term.cols - 4;
    this.lines = opts.lines || wrapText(opts.text ?? "", w);
  }

  onKey(k) {
    const page = this.h - 5;
    const max = Math.max(0, this.lines.length - page);
    if (k.name === "escape" || k.name === "q") { this.app.closeOverlay(); return; }
    if (k.name === "up" || k.name === "k") this.top = Math.max(0, this.top - 1);
    else if (k.name === "down" || k.name === "j") this.top = Math.min(max, this.top + 1);
    else if (k.name === "pageup" || (k.ctrl && k.name === "u")) this.top = Math.max(0, this.top - page);
    else if (k.name === "pagedown" || (k.ctrl && k.name === "d") || k.ch === " ") this.top = Math.min(max, this.top + page);
    else if (k.name === "g" || k.name === "home") this.top = 0;
    else if (k.name === "G" || k.name === "end") this.top = max;
  }

  footer() { return c.dim("↑↓/jk scroll · space/pgdn page · g/G top/bottom · esc close"); }

  paint(lines, w, h) {
    this.h = h;
    const page = h - 5;
    lines[0] = truncAnsi(" " + c.brand("── ") + c.bold(this.o.title || "view") + c.brand(" ") + c.faint(`${Math.min(100, Math.round(((this.top + page) / Math.max(1, this.lines.length)) * 100))}%`) + " " + c.brand("─".repeat(Math.max(0, w - strWidth(this.o.title || "view") - 12))), w);
    for (let i = 0; i < page; i++) {
      const l = this.lines[this.top + i];
      lines[1 + i] = l === undefined ? c.faint(" ~") : truncAnsi("  " + l, w);
    }
    for (let i = 1 + page; i < h - 1; i++) lines[i] = "";
  }
}
