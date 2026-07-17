"use client";
/**
 * Simple mode — a global, persisted toggle that flips the app from its dense "Pro" builder
 * view into a calm, mobile-first "Simple" view (see SimpleRun). It's a UX choice, not a
 * separate app: same data, far less on screen. Persisted to localStorage and reflected on
 * <html data-simple> so CSS can declutter the chrome too. Not stage/loop-specific.
 */
import { createContext, useContext, useEffect, useState } from "react";

const Ctx = createContext<{ simple: boolean; setSimple: (v: boolean) => void }>({ simple: false, setSimple: () => {} });
export const useSimpleMode = () => useContext(Ctx);

export function SimpleModeProvider({ children }: { children: React.ReactNode }) {
  // Read the saved choice SYNCHRONOUSLY in the initializer, so the very first client paint
  // already renders the right view — no flash of the Pro view flipping to Simple (or vice
  // versa). (A pre-paint inline script in layout also sets <html data-simple> for the chrome.)
  const [simple, setSimpleState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("atelier-simple") === "1"; } catch { return false; }
  });

  // Reflect on the root so global CSS can respond (declutter the top bar, etc.).
  useEffect(() => { document.documentElement.dataset.simple = simple ? "1" : ""; }, [simple]);
  // Keep tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === "atelier-simple") setSimpleState(e.newValue === "1"); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setSimple = (v: boolean) => { setSimpleState(v); try { localStorage.setItem("atelier-simple", v ? "1" : "0"); } catch {} };
  return <Ctx.Provider value={{ simple, setSimple }}>{children}</Ctx.Provider>;
}

/** Segmented Studio / Live switch for the top bar. "Studio" is the full builder
 *  workbench; "Live" is the calm, follow-along feed (see SimpleRun). */
export function SimpleToggle() {
  const { simple, setSimple } = useSimpleMode();
  // The server always renders this with simple=false (no localStorage there), and React
  // does NOT patch attribute mismatches during hydration — so for a Live-mode visitor
  // the highlight would stick on "Studio" until the first tap. Remounting once after mount
  // (via the key) re-creates the buttons with client-truth attributes.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return (
    <div key={mounted ? "live" : "ssr"} className="mode-switch" role="group" aria-label="View mode" title="Switch between the full builder (Studio) and a calm, follow-along feed (Live)">
      <button type="button" data-on={!simple} onClick={() => setSimple(false)}>Studio</button>
      <button type="button" data-on={simple} onClick={() => setSimple(true)}>Live</button>
    </div>
  );
}
