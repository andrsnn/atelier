"use client";
import React from "react";

/** Minimal, dependency-free Markdown → HTML for artifacts/summaries. Handles the
 *  subset our agents emit: headings, bold, inline code, fenced code, lists, hr, paragraphs. */
export function mdToHtml(md: string): string {
  if (typeof md !== "string") md = String(md ?? ""); // never crash on a non-string (e.g. a Buffer/number)
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, url) =>
        // scheme-allowlist the href so `[x](javascript:…)` can't inject script
        `<a href="${/^(https?:|mailto:|\/|#)/i.test(url) ? String(url).replace(/"/g, "%22") : "#"}" target="_blank" rel="noreferrer">${txt}</a>`);

  const lines = md.replace(/\r/g, "").split("\n");
  let html = "", i = 0;
  let list: "ul" | "ol" | null = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList(); i++;
      let code = "";
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; }
      i++; html += `<pre><code>${esc(code)}</code></pre>`; continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    // GFM table: a `| … |` header row followed by a `|---|---|` separator row, then body rows.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(line);
      i += 2; // skip header + separator
      let body = "";
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const c = cells(lines[i]);
        body += "<tr>" + head.map((_, k) => `<td>${inline(c[k] ?? "")}</td>`).join("") + "</tr>";
        i++;
      }
      html += `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
      continue;
    }
    if (/^---+\s*$/.test(line)) { closeList(); html += "<hr/>"; i++; continue; }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)/);
    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    // Preserve the source number via `value=` so a list split by a blank line between items
    // (common in LLM output) doesn't restart at 1.
    if (ol) { if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; } html += `<li value="${ol[1]}">${inline(ol[2])}</li>`; i++; continue; }
    if (ul) { if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; } html += `<li>${inline(ul[1])}</li>`; i++; continue; }
    if (!line.trim()) {
      // A blank line inside a list: keep the list open if it continues after the blank,
      // so items separated by blank lines stay one contiguous, correctly-numbered list.
      if (list) {
        let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
        const next = lines[j] || "";
        if ((list === "ol" && /^\s*\d+\.\s+/.test(next)) || (list === "ul" && /^\s*[-*+]\s+/.test(next))) { i++; continue; }
      }
      closeList(); i++; continue;
    }
    closeList(); html += `<p>${inline(line)}</p>`; i++;
  }
  closeList();
  return html;
}

export function Markdown({ children }: { children: string }) {
  return <div className="prose-doc" dangerouslySetInnerHTML={{ __html: mdToHtml(children || "") }} />;
}

/** Inline markdown (bold, inline code, links, line breaks) rendered as REAL React nodes —
 *  no dangerouslySetInnerHTML, so text is auto-escaped and safe. For compact one/two-line
 *  contexts (activity rows, the Live feed); block markdown (lists/tables) uses <Markdown>. */
function parseInlineMd(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok[0] === "`") nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok[0] === "*") nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm) {
        const href = /^(https?:|mailto:|\/|#)/i.test(lm[2]) ? lm[2] : "#"; // block javascript: etc.
        nodes.push(<a key={k++} href={href} target="_blank" rel="noreferrer">{lm[1]}</a>);
      } else nodes.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function InlineMD({ children }: { children: string }): React.ReactElement {
  const src = String(children ?? "");
  return (
    <>
      {src.split("\n").map((line, li) => (
        <React.Fragment key={li}>{li > 0 && <br />}{parseInlineMd(line)}</React.Fragment>
      ))}
    </>
  );
}

/** The Conductor's one "Autopilot" control, collapsing the two underlying settings
 *  (react-cadence + route-approval) into a single choice. Same widget in the inline
 *  panel and the full chat modal, so they never drift. */
export type Autopilot = "auto" | "propose" | "manual";
export function autopilotOf(react: string | null | undefined, mode: string | null | undefined): Autopilot {
  if (react === "manual") return "manual";
  return mode === "auto" ? "auto" : "propose";
}
const AUTOPILOT_OPTS: { v: Autopilot; label: string; title: string }[] = [
  { v: "auto", label: "⚡ Auto", title: "Reads new comments and routes the loop itself — no approval needed" },
  { v: "propose", label: "Propose", title: "Proposes a route, then waits for your ok" },
  { v: "manual", label: "✋ Manual", title: "Waits — batches comments until you hit Review" },
];
export function AutopilotSelect({ value, onChange, disabled }: { value: Autopilot; onChange: (a: Autopilot) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700, color: "var(--ink-dim)" }}>Autopilot</span>
      <div style={{ display: "flex", border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden" }} title="Autopilot — how the Conductor handles feedback">
        {AUTOPILOT_OPTS.map((o, i) => (
          <button key={o.v} onClick={() => onChange(o.v)} disabled={disabled} title={o.title}
            style={{ border: "none", borderLeft: i ? "1px solid var(--rule)" : "none", padding: "4px 11px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", background: value === o.v ? "#efe8fb" : "var(--surface)", color: value === o.v ? "#5848a0" : "var(--ink-dim)", fontWeight: value === o.v ? 600 : 500 }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const LABELS: Record<string, string> = {
  idle: "Idle", running: "Running", queued: "Queued", awaiting_approval: "Awaiting approval", paused: "Paused", done: "Done", failed: "Failed",
};
export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`status s-${status}`}>
      {status === "running" ? <span className="spin" /> : <span className="dot" />}
      {LABELS[status] || status}
    </span>
  );
}

export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
