/**
 * ASCII renderers for a machine's state graph, with live run status overlaid:
 *   miniRail — one-line glyph rail for board cards        ●─●─◉─○─○
 *   rail     — the numbered stepper (phase names in a row)
 *   dag      — the boxes-and-wires graph view (forward flow, amber reject
 *              loop-backs, dashed off-path leaves) — the terminal cousin of
 *              the web UI's MachineGraph/MachineCanvas.
 */
import { c, fit, strWidth, truncAnsi } from "./ui.mjs";

export function disabledSet(run) {
  try { return new Set(JSON.parse(run?.disabled_states || "[]")); } catch { return new Set(); }
}

/** Status of state `i` under `run` (null run = plain definition preview). */
export function nodeStatus(i, states, run, disabled) {
  const st = states[i];
  if (disabled && disabled.has(st.id)) return "skipped";
  if (!run) return "pending";
  if (st.offPath && i !== run.state_index) return "pending";
  if (i < run.state_index) return "done";
  if (i === run.state_index) {
    if (run.status === "done") return "done";
    if (run.status === "failed") return "failed";
    if (run.status === "awaiting_approval" || run.status === "paused") return "gated";
    if (run.status === "idle" || run.status === "queued") return "pending";
    return "current";
  }
  return "pending";
}

const GLYPH = {
  done: () => c.ok("●"),
  current: (sp) => c.brand(sp || "◉"),
  gated: () => c.warn("◉"),
  failed: () => c.err("✗"),
  skipped: () => c.faint("·"),
  pending: () => c.dim("○"),
};

const PAINT = {
  done: c.ok,
  current: c.brand,
  gated: c.warn,
  failed: c.err,
  skipped: c.faint,
  pending: c.faint,
};

export function mainIdxs(states) {
  return states.map((s, i) => ({ s, i })).filter((x) => !x.s.offPath).map((x) => x.i);
}

/** One-line glyph rail for a run card. */
export function miniRail(states, run, sp) {
  const disabled = disabledSet(run);
  return mainIdxs(states)
    .map((i) => GLYPH[nodeStatus(i, states, run, disabled)](sp))
    .join(c.faint("─"));
}

/** The stepper: `✓ Brief ─ ⠙ Make ─ ○ Evaluate …`, viewed phase underlined. */
export function rail(states, run, { viewIdx = -1, sp, width = 80 } = {}) {
  const disabled = disabledSet(run);
  const parts = mainIdxs(states).map((i) => {
    const status = nodeStatus(i, states, run, disabled);
    let name = states[i].name;
    if (status === "skipped") name = c.strike(name);
    let seg = `${GLYPH[status](sp)} ${PAINT[status](name)}`;
    if (states[i].gate) seg += c.faint("·g");
    if (i === viewIdx) seg = c.under(seg);
    if (i === run?.state_index && (run.status === "running" || run.status === "queued")) seg = c.bold(seg);
    return seg;
  });
  // wrap segments into as many lines as needed
  const lines = [];
  let cur = "";
  for (const p of parts) {
    const joined = cur ? cur + c.faint(" ── ") + p : p;
    if (cur && strWidth(joined) > width) { lines.push(cur); cur = p; }
    else cur = joined;
  }
  if (cur) lines.push(cur);
  const leaves = states.filter((s) => s.offPath);
  if (leaves.length) {
    lines.push(leaves.map((s) => {
      const i = states.indexOf(s);
      const status = nodeStatus(i, states, run, disabled);
      return `${c.brandDim("◇")} ${PAINT[status === "pending" ? "skipped" : status](s.name)} ${c.faint(`(branch${s.returnTo ? ` → ${nameOf(states, s.returnTo)}` : ""})`)}`;
    }).join("   "));
  }
  return lines;
}

const nameOf = (states, id) => states.find((s) => s.id === id)?.name || id;

/**
 * The DAG view. Renders main-path states as boxes on one row with forward
 * wires, reject loop-backs as amber dashed arcs beneath, and off-path leaves
 * as dashed boxes hanging below their anchor. Windows horizontally around
 * `focusIdx` when the machine is wider than the terminal.
 */
export function dag(states, run, { viewIdx = -1, sp, width = 100, focusIdx } = {}) {
  const disabled = disabledSet(run);
  const main = mainIdxs(states);
  if (!main.length) return [c.dim("(no states)")];

  const boxW = (i) => Math.min(Math.max(strWidth(states[i].name) + 6, 12), 24);
  const GAP = 5; // "──▶  " between boxes

  // choose the window of main nodes that fits, keeping focus visible
  const focusMain = Math.max(0, main.indexOf(focusIdx >= 0 ? focusIdx : (viewIdx >= 0 ? viewIdx : run?.state_index ?? 0)));
  let start = 0, end = main.length;
  const total = main.reduce((a, i) => a + boxW(i) + GAP, -GAP);
  if (total > width - 2) {
    start = focusMain;
    let w = boxW(main[start]);
    // grow window greedily around focus
    let lo = start, hi = start;
    while (true) {
      const canLeft = lo > 0 ? boxW(main[lo - 1]) + GAP : Infinity;
      const canRight = hi < main.length - 1 ? boxW(main[hi + 1]) + GAP : Infinity;
      if (canLeft === Infinity && canRight === Infinity) break;
      // prefer showing what's ahead, then behind
      if (canRight <= canLeft && w + canRight <= width - 8) { hi++; w += canRight; continue; }
      if (canLeft !== Infinity && w + canLeft <= width - 8) { lo--; w += canLeft; continue; }
      break;
    }
    start = lo; end = hi + 1;
  }
  const win = main.slice(start, end);

  // x offsets per windowed node
  const xs = [];
  let x = start > 0 ? 4 : 1; // room for "◀N "
  for (const i of win) { xs.push(x); x += boxW(i) + GAP; }

  const rowLen = x;
  const blank = () => new Array(rowLen + 2).fill(" ");
  const put = (row, col, str) => { row[col] = str; for (let k = 1; k < strWidth(str); k++) row[col + k] = ""; };
  // NOTE: rows are arrays of single cells; styled multi-char strings are placed
  // via putStyled which stores the whole styled run in one cell.
  const putStyled = (row, col, plain, paint) => {
    // place `plain` starting at col, painting the whole run once
    row[col] = paint ? paint(plain) : plain;
    for (let k = 1; k < strWidth(plain); k++) row[col + k] = "";
  };

  const rows = { top: blank(), name: blank(), info: blank(), bot: blank() };

  win.forEach((i, wi) => {
    const st = states[i];
    const w = boxW(i);
    const status = nodeStatus(i, states, run, disabled);
    const paint = PAINT[status];
    const viewed = i === viewIdx;
    const corners = viewed ? ["┏", "┓", "┗", "┛", "━", "┃"] : ["╭", "╮", "╰", "╯", "─", "│"];
    const bp = viewed ? c.brand : paint; // border paint
    const x0 = xs[wi];

    putStyled(rows.top, x0, corners[0] + corners[4].repeat(w - 2) + corners[1], bp);
    // name line
    let nm = truncAnsi(st.name, w - 6);
    if (status === "skipped") nm = c.strike(nm);
    const glyph = GLYPH[status](sp);
    const nameInner = ` ${glyph} ${PAINT[status] === c.faint ? c.dim(nm) : paint(c.bold(nm))}`;
    putStyled(rows.name, x0, corners[5], bp);
    put(rows.name, x0 + 1, nameInner + " ".repeat(Math.max(0, w - 2 - strWidth(nameInner))));
    putStyled(rows.name, x0 + w - 1, corners[5], bp);
    // info line: tools count, gate, reject target
    const bits = [];
    bits.push(`${(st.tools || []).length}t`);
    if (st.gate) bits.push("gate");
    if (st.rejectTo) bits.push(`↩${truncAnsi(nameOf(states, st.rejectTo), 8)}`);
    if (st.model) bits.push("pin");
    const info = truncAnsi(" " + bits.join(" · "), w - 2);
    putStyled(rows.info, x0, corners[5], bp);
    put(rows.info, x0 + 1, c.faint(info) + " ".repeat(Math.max(0, w - 2 - strWidth(info))));
    putStyled(rows.info, x0 + w - 1, corners[5], bp);
    putStyled(rows.bot, x0, corners[2] + corners[4].repeat(w - 2) + corners[3], bp);

    // forward wire to the next windowed node
    if (wi < win.length - 1) {
      const wirePaint = nodeStatus(i, states, run, disabled) === "done" ? c.ok : c.faint;
      putStyled(rows.name, x0 + w, "──▶", wirePaint);
    }
  });

  if (start > 0) putStyled(rows.name, 0, `◀${start}`, c.dim);
  if (end < main.length) putStyled(rows.name, Math.min(rowLen - 1, width - 4), ` ▶${main.length - end}`, c.dim);

  const join = (row) => row.join("");
  const lines = [join(rows.top), join(rows.name), join(rows.info), join(rows.bot)];

  // reject loop-backs: one amber dashed line per edge (within the window)
  const center = (i) => { const wi = win.indexOf(i); return wi < 0 ? -1 : xs[wi] + Math.floor(boxW(i) / 2); };
  for (const i of win) {
    const st = states[i];
    if (!st.rejectTo) continue;
    const dst = states.findIndex((s) => s.id === st.rejectTo);
    if (dst < 0) continue;
    const cs = center(i);
    const cd = center(dst);
    if (cs < 0) continue;
    const row = blank();
    if (cd >= 0 && cd < cs) {
      putStyled(row, cd, "▲", c.warn);
      for (let k = cd + 1; k < cs; k++) putStyled(row, k, "╌", c.warn);
      putStyled(row, cs, "╯", c.warn);
      putStyled(row, cs + 2, `reject: ${st.name} ↩ ${nameOf(states, st.rejectTo)}`, c.faint);
    } else {
      putStyled(row, cs, "╰╌▶", c.warn);
      putStyled(row, cs + 4, `reject → ${nameOf(states, st.rejectTo)} ${cd < 0 ? "(off-screen)" : ""}`, c.faint);
    }
    lines.push(join(row));
  }

  // off-path leaves hang beneath their anchor (the phase right before returnTo)
  const leaves = states.map((s, i) => ({ s, i })).filter((x) => x.s.offPath);
  for (const { s, i } of leaves) {
    const retIdx = states.findIndex((q) => q.id === s.returnTo);
    const anchorMain = retIdx > 0 ? main.filter((m) => m < retIdx).pop() : main[main.length - 1];
    const ax = anchorMain !== undefined ? center(anchorMain) : -1;
    const status = nodeStatus(i, states, run, disabled);
    const label = `◇ ${s.name}`;
    const info = `branch${s.returnTo ? ` → ${nameOf(states, s.returnTo)}` : ""}`;
    const paint = status === "current" ? c.brand : status === "done" ? c.ok : c.brandDim;
    const r1 = blank(); const r2 = blank();
    const lx = Math.max(1, ax >= 0 ? ax - 2 : 1);
    if (ax >= 0) putStyled(r1, ax, "┆", c.brandDim);
    putStyled(r2, lx, label, paint);
    putStyled(r2, lx + strWidth(label) + 1, `· ${info}`, c.faint);
    lines.push(join(r1), join(r2));
  }

  return lines.map((l) => truncAnsi(l, width));
}
