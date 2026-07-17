/**
 * Pending phase-control signal. The Claude provider runs a phase as a CLI process
 * that does its own thing and exits; while it runs, the agent decides the phase
 * outcome by calling `factool approval|reject|complete` (via Bash), which hits the
 * internal tool route in THIS same server process and records the outcome here.
 * After the phase process exits, the single-agent runner reads + clears it to
 * decide: gate for the human, auto-advance, or loop back. (Ollama phases don't use
 * this — their control tools end the in-process loop directly.)
 */
export type ControlAction = "request_approval" | "reject" | "complete";
export interface PendingControl { action: ControlAction; summary: string }

const pending = new Map<string, PendingControl>();

export function setPendingControl(runId: string, c: PendingControl) { pending.set(runId, c); }
export function takePendingControl(runId: string): PendingControl | null {
  const c = pending.get(runId) ?? null;
  pending.delete(runId);
  return c;
}
