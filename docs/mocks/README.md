# Run visibility — the Conductor inspector

**Problem.** When a run loops many times (Build ⇄ QA round after round), there's no way
to tell *what* it's doing or *why* without spinning up a separate agent to ask. The existing
per-phase Narrator summarizes the current phase; the Conductor is reactive (it only wakes on a
comment or a direct question). Nothing gives you a glanceable, catch-up view across loops.

**Shape of the answer (design of record).** One modal opened from the run page by a
**Conductor — chat & activity** button (with an unread-events count):

- **Left — Chat.** The existing Conductor session. Ask "why is it looping?", nudge it toward a
  different fix, pause, or route — all in plain language. Quick-reply chips for common calls.
- **Right — Activity.** A **"since you last checked in"** summary on top (generated when you
  open the panel), then the run's major events *since your last visit* with the model's own
  reasoning inline (e.g. *"figured it was a styling problem, so I restyled the button"* — the tell
  that it's chasing the wrong fix). Older events fade below an `Earlier` divider.

See `conductor-inspector.html` for the final design. `loop-watch.html` is an earlier,
simpler single-card concept kept for reference.

## Why this fits the engine (no stage-specific logic)

This is an **observability layer**, like `narrator.ts` and the existing Conductor — the engine
never special-cases a state. It reads what's already recorded and presents it.

- **The activity log** is `listEvents(runId)` rendered at the milestone level: `state_enter`,
  `reject`, `approval_request`, `feedback`, `progress`, `reflect`, and the assistant's own `text`
  become friendly lines with a source tag. No new event types; a presentational filter over the
  existing timeline (which is already ordered by rowid, so it reads correctly).
- **"Since you last checked in"** needs one small thing: a per-viewer *last-seen* marker. Cheapest
  version is client-side (localStorage keyed by run id) — the `?since=<eventId>` param already
  exists on `GET /api/runs/[id]`, so the "new" divider is just "events after my last-seen id."
- **The summary** reuses the Conductor's read-only pass (`conductor.ts` already spawns a harness
  in the run workspace and can Read/Grep the code). Add a `catchUp(runId, sinceEventId)` that
  prompts it to summarize the new events in 2–3 plain sentences + a "does this need you?" verdict.
  It runs when the panel opens (the `↻ caught up · just now` state).
- **The chat** is the existing `conductor_messages` session and its POST actions
  (`talk`, `apply`, `stop`, …) — unchanged.

## Build plan (incremental)

1. **Event → friendly-line mapper** (pure function, unit-testable): `FactoryEvent → { source,
   tag, text, thinking?, when }`. Lives next to the run page; no engine change.
2. **`ConductorModal` component**: two panes over the existing conductor data already returned by
   `GET /api/runs/[id]` (`events`, `conductor`, `conductorActivity`). Left pane = the current
   Conductor chat UI, lifted into the modal. Right pane = summary + mapped event list with the
   "new since" divider from the localStorage last-seen id.
3. **`catchUp` endpoint** (`POST /api/runs/[id]/conductor` `action:"catchUp"`): calls a new
   `conductor.catchUp()` that summarizes events since the marker. Fired on open.
4. **Entry point**: replace the run page's separate "feedback / Conductor" affordance with the
   single **Conductor — chat & activity** button carrying the unread count (events after last-seen).

No new machine states, no per-phase branching — a tool/observability addition, per CLAUDE.md.
