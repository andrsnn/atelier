"use client";
import { useState } from "react";

// The unlock screen shown when ACCESS_PASSWORD is set and the visitor doesn't yet
// have the access cookie (see middleware.ts). Submitting the right password sets the
// cookie and returns them to where they were headed.
export default function Access() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (r.ok) {
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") ? next : "/";
    } else {
      setErr("That password didn't work.");
    }
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <form onSubmit={submit} className="card card-pad" style={{ width: "100%", maxWidth: 360 }}>
        <h1 style={{ fontFamily: "var(--font-display, inherit)", fontSize: 30, margin: "2px 0 4px", lineHeight: 1 }}>Atelier</h1>
        <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
          This workshop is shared. Enter the access password to join the board.
        </div>
        <label className="label" style={{ display: "block", marginBottom: 6 }}>Access password</label>
        <input
          className="input"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
        {err && <div style={{ color: "var(--brand)", fontSize: 12.5, marginTop: 8 }}>{err}</div>}
        <button className="btn btn-brand" type="submit" disabled={busy || !password} style={{ width: "100%", justifyContent: "center", marginTop: 16 }}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </main>
  );
}
