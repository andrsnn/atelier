/**
 * Terminal primitives for the Atelier TUI: raw mode, the alternate screen,
 * escape-sequence key parsing, and a full-frame writer. Zero dependencies.
 */
import { EventEmitter } from "node:events";

export class Term extends EventEmitter {
  constructor(input = process.stdin, output = process.stdout) {
    super();
    this.in = input;
    this.out = output;
    this.started = false;
    this._onData = (buf) => {
      for (const key of parseKeys(buf.toString("utf8"))) this.emit("key", key);
    };
    this._onResize = () => this.emit("resize");
  }

  get cols() { return this.out.columns || 80; }
  get rows() { return this.out.rows || 24; }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.in.isTTY) this.in.setRawMode(true);
    this.in.resume();
    this.in.on("data", this._onData);
    this.out.on("resize", this._onResize);
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"); // alt screen, hide cursor, clear
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.in.off("data", this._onData);
    this.out.off("resize", this._onResize);
    this.out.write("\x1b[?2026l\x1b[0m\x1b[?1049l\x1b[?25h");
    if (this.in.isTTY) this.in.setRawMode(false);
    this.in.pause();
  }

  /** Temporarily hand the terminal to an external program ($EDITOR). */
  suspend() {
    if (!this.started) return;
    this.in.off("data", this._onData);
    this.out.write("\x1b[0m\x1b[?1049l\x1b[?25h");
    if (this.in.isTTY) this.in.setRawMode(false);
    this.in.pause();
  }

  resume() {
    if (!this.started) return;
    if (this.in.isTTY) this.in.setRawMode(true);
    this.in.resume();
    this.in.on("data", this._onData);
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  }

  /** Draw a complete frame. `lines` is an array of styled strings, one per row. */
  draw(lines) {
    const body = lines.map((l) => l + "\x1b[0m\x1b[K").join("\r\n");
    // ?2026 = synchronized update: the terminal swaps the frame atomically (no tearing).
    this.out.write("\x1b[?2026h\x1b[H" + body + "\x1b[0m\x1b[J\x1b[?2026l");
  }
}

const CSI_TILDE = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown" };

function csiKey(params, final) {
  const mod = parseInt(params.split(";")[1] || "1", 10);
  const shift = mod === 2 || mod === 4 || mod === 6 || mod === 8;
  const ctrl = mod >= 5;
  switch (final) {
    case "A": return { name: "up", shift, ctrl };
    case "B": return { name: "down", shift, ctrl };
    case "C": return { name: "right", shift, ctrl };
    case "D": return { name: "left", shift, ctrl };
    case "H": return { name: "home" };
    case "F": return { name: "end" };
    case "Z": return { name: "tab", shift: true };
    case "~": return { name: CSI_TILDE[parseInt(params, 10)] || "unknown" };
    default: return { name: "unknown" };
  }
}

/**
 * Parse a raw stdin chunk into key objects: { name, ch?, ctrl?, shift?, meta? }.
 * `ch` is set only for printable characters. Multi-char printable chunks
 * (a paste) come through as a sequence of char keys.
 */
export function parseKeys(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      const rest = s.slice(i);
      let m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (m) { keys.push(csiKey(m[1], m[2])); i += m[0].length; continue; }
      m = /^\x1bO([A-Z])/.exec(rest);
      if (m) { keys.push(csiKey("", m[1])); i += m[0].length; continue; }
      if (rest.length === 1) { keys.push({ name: "escape" }); i += 1; continue; }
      // ESC + printable = alt/meta chord
      keys.push({ name: rest[1], ch: rest[1], meta: true });
      i += 2;
      continue;
    }
    if (ch === "\r" || ch === "\n") { keys.push({ name: "enter" }); i += 1; continue; }
    if (ch === "\t") { keys.push({ name: "tab" }); i += 1; continue; }
    if (ch === "\x7f" || ch === "\b") { keys.push({ name: "backspace" }); i += 1; continue; }
    const code = ch.charCodeAt(0);
    if (code < 32) { keys.push({ name: String.fromCharCode(code + 96), ctrl: true }); i += 1; continue; }
    // Take a full code point (surrogate pairs)
    const cp = s.codePointAt(i);
    const full = String.fromCodePoint(cp);
    keys.push({ name: full, ch: full });
    i += full.length;
  }
  return keys;
}
