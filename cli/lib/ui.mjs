/**
 * Styling + text-measurement helpers for the Atelier TUI.
 * All layout code measures strings ANSI-aware (escape codes are zero-width)
 * and wide-char aware (CJK/emoji count as two cells).
 */

const ESC_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s) { return String(s).replace(ESC_RE, ""); }

function cpWidth(cp) {
  if (cp === 0x200b) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    cp >= 0x20000
  ) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0));
  return w;
}

/** Truncate a styled string to `w` cells, appending an ellipsis if cut. */
export function truncAnsi(s, w) {
  s = String(s);
  if (strWidth(s) <= w) return s;
  let out = "";
  let used = 0;
  let i = 0;
  while (i < s.length) {
    ESC_RE.lastIndex = 0;
    const m = ESC_RE.exec(s.slice(i));
    if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = cpWidth(cp);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
    i += ch.length;
  }
  return out + "…\x1b[0m";
}

/** Truncate-and-pad to exactly `w` cells. The workhorse of every column layout. */
export function fit(s, w) {
  if (w <= 0) return "";
  const t = truncAnsi(s, w);
  return t + " ".repeat(Math.max(0, w - strWidth(t)));
}

export function padStartW(s, w) {
  return " ".repeat(Math.max(0, w - strWidth(s))) + s;
}

/** Wrap plain (unstyled) text to a width, respecting newlines and long words. */
export function wrapText(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para.trim() === "") { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      let w = word;
      while (strWidth(w) > width) {
        // hard-break an over-long token
        if (line) { out.push(line); line = ""; }
        let piece = "";
        for (const ch of w) {
          if (strWidth(piece + ch) > width) break;
          piece += ch;
        }
        out.push(piece);
        w = w.slice(piece.length);
      }
      if (!line) line = w;
      else if (strWidth(line + " " + w) <= width) line += " " + w;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

// ---------------------------------------------------------------- palette

const fg = (n) => (s) => `\x1b[38;5;${n}m${s}\x1b[39m`;

export const c = {
  brand: fg(45),      // cyan — running / links / current
  brandDim: fg(31),
  ok: fg(78),         // green — done
  warn: fg(214),      // amber — needs you / gates / reject wires
  err: fg(203),       // red — failed
  violet: fg(141),    // conductor / reflect
  dim: fg(246),
  faint: fg(240),
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  inv: (s) => `\x1b[7m${s}\x1b[27m`,
  under: (s) => `\x1b[4m${s}\x1b[24m`,
  strike: (s) => `\x1b[9m${s}\x1b[29m`,
  bgSel: (s) => `\x1b[48;5;237m${s}\x1b[49m`,
};

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinAt = (t = Date.now()) => SPIN[Math.floor(t / 90) % SPIN.length];

const CHIP = {
  running:            (sp) => c.brand(`${sp} Running`),
  queued:             ()  => c.brand("◌ Queued"),
  idle:               ()  => c.dim("○ Idle"),
  awaiting_approval:  ()  => c.warn("● Needs you"),
  paused:             ()  => c.warn("‖ Paused"),
  done:               ()  => c.ok("✓ Done"),
  failed:             ()  => c.err("✗ Failed"),
};

export function statusChip(status, sp = "⠿") {
  return (CHIP[status] || (() => c.dim(String(status))))(sp);
}

export function statusRank(status) {
  // in-flight → waiting → idle → done → failed (board "Status" sort)
  return { running: 0, queued: 1, awaiting_approval: 2, paused: 3, idle: 4, done: 5, failed: 6 }[status] ?? 9;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Draw a box around styled content lines. Returns styled lines. */
export function box(lines, { title = "", width, color = c.faint } = {}) {
  const inner = width ? width - 4 : Math.max(...lines.map(strWidth), strWidth(title) + 2, 10);
  const top = title
    ? color("╭─ ") + c.bold(truncAnsi(title, inner - 1)) + " " + color("─".repeat(Math.max(0, inner - strWidth(title) - 2)) + "─╮")
    : color("╭" + "─".repeat(inner + 2) + "╮");
  const out = [top];
  for (const l of lines) out.push(color("│ ") + fit(l, inner) + color(" │"));
  out.push(color("╰" + "─".repeat(inner + 2) + "╯"));
  return out;
}

export function modelShort(m) {
  if (!m) return "";
  return String(m).replace(/^claude:/, "claude ").replace(/^ollama:/, "").replace(/:cloud$/, "");
}
