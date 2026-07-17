/**
 * Seed data. The default machine is CONFIG — an ordered list of phases, each a
 * prompt + the tools available + an optional rejectTo (where a failing review
 * sends the work back to). The single agent drives all phases with full memory.
 * Nothing here is special-cased in the engine. Repo-agnostic.
 */
import { listMachines, upsertMachine, type StateDef, type MachineSettings } from "../db";
import { loadMachineFiles, type YamlMachine } from "./load";
import { loadWorkflowFiles } from "../workflows/load";

export const DEFAULT_MACHINE_ID = "default-repo-pipeline";

// Generic toolset — let the agent figure out its task and do the work.
const ALL = ["read_file", "list_directory", "search_code", "run_command", "write_file", "edit_file", "display_artifact", "start_dev_server", "authenticate", "screenshot_page", "record_walkthrough", "analyze_image"];

const STATES: StateDef[] = [
  {
    id: "prd", name: "PRD", tools: ALL, gate: true,
    prompt:
`Turn the loop's goal into a short PRD (product requirements) the rest of the machine can build against — and CLARIFY anything ambiguous BEFORE work starts.

If a reference image / description was provided (see below), factor it in. Explore just enough of the codebase to ground the PRD in reality (don't design the implementation yet — that's Spec).

Write "prd.md": the problem & who it's for, the core user-facing outcomes (what "done" looks like in the user's words), explicit in/out of scope, and any assumptions you're making. If the goal is genuinely ambiguous on functionality (behaviour, edge cases, scope) — and only then — add a "## Open questions" section with SPECIFIC, answerable questions (offer a sensible default for each so it can proceed if you don't hear back).

display_artifact the PRD (markdown, name "PRD"), then request_approval. The human answers your questions with a comment + re-run, or approves to proceed. Do NOT invent requirements the human clearly didn't ask for.`,
  },
  {
    id: "spec", name: "Spec", tools: ALL, gate: true,
    prompt:
`Understand the loop's goal + PRD against the REAL codebase, then write a buildable spec.
Explore first: find the relevant pages/components/APIs for this feature (list_directory, search_code, read_file) and learn the project's conventions. Then write "spec.md" with: the problem, the user-facing behaviour & flows, scope (in/out), a numbered acceptance checklist QA can verify, the concrete technical approach naming the actual files/components you'll touch, and assumptions.
display_artifact the spec (markdown, name "Spec"), then request_approval.`,
  },
  {
    id: "mock", name: "Mock", tools: ALL, gate: true,
    prompt:
`Give the human 3–4 DISTINCT design OPTIONS for the new UI to choose from — not one design iterated to death. Each option should take a genuinely different direction (e.g. layout, information hierarchy, where the primary controls and output live). All must MATCH this app's existing look — read the spec and the real components/styles first.

Write each option as its own self-contained HTML file: option-1.html, option-2.html, option-3.html (you may use CDNs; real three.js viewer where relevant, realistic content, working primary interactions).

For EACH option: screenshot_page it ONCE as a scratch self-check (present:false — do NOT flood Deliverables); if you can't see images, analyze_image to confirm it renders and looks good; fix only if it's actually broken (max 1 fix per option). Then present it: display_artifact with kind:"html", name:"Option 1 — <short label>", and file:"option-1.html" (pass the FILE path so the real mock renders in the UI — never write "see the file" in body).

Once all 3–4 options are presented (and only those — no intermediate screenshots in Deliverables), call request_approval and tell the human to pick one (they click an option and Approve). Do NOT keep iterating.`,
  },
  {
    id: "build", name: "Build", tools: ALL, maxTurns: 250,
    prompt:
`Implement the feature for real, in this repo, following the spec and matching the mock. Edit/create the actual source files and follow the codebase's patterns.

STAY IN YOUR LANE — BUILD IS FOR CODING, NOT QA. Implement it and confirm it BUILDS and BOOTS. At most do ONE light smoke self-check (start the dev server, load the feature, one happy-path interaction, confirm no crash — a screenshot is fine). Do NOT write a QA test plan, per-case PASS/FAIL deliverables, or walkthrough videos, and do NOT drive the browser exhaustively — rigorous per-case QA is the QA step's job and the final call is Acceptance's. Confirm the headline capability is REAL (the named integration actually fires — from code + dev-log/network), not a placeholder; if you can't complete the real integration, say so plainly rather than hiding it behind a stub.

CRITICAL — finish the WIRING, not just the pieces:
- If you define a flag/branch/handler (e.g. is3DMode, handleX), you MUST actually render/call it. A defined-but-unused code path = broken feature. Grep your own new symbols to confirm each is referenced.
- DEPENDENCIES: node_modules is SHARED with the host repo, so an import can resolve even when the package is NOT in package.json. Any package you import that isn't already a dependency you MUST add to package.json (and the lockfile) — otherwise CI fails. Check: for each new import, grep package.json.
- Verify with run_command: npx tsc --noEmit must be clean for src/ before you finish.

COMMITS: stage only the source files you changed (git add <paths>) — do NOT 'git add -A'. Factory scratch (spec.md, mock.html, option-*.html, .captures/) lives in this folder and must NOT land in the PR.

Once the core change is wired, declared, and typechecks, STOP — don't over-polish. Commit, display_artifact a "Build Summary" (markdown: files changed, what each does, how to preview, and a checklist of each acceptance criterion ↔ where it's implemented), and call request_approval. If you were sent back with review feedback, address EVERY point, then finish the same way.`,
  },
  {
    id: "review", name: "Review", tools: ALL, rejectTo: "build",
    prompt:
`Critically review the diff for CORRECTNESS and SECURITY. Read the changed files (git diff) and the surrounding code. Look for: bugs, broken/edge cases, missing pieces from the spec, injection/authz/secret-handling issues, and anything that doesn't follow the codebase conventions.
display_artifact a "Code Review" (markdown) with findings by severity. If there are real defects, call reject with specific, actionable reasons (this loops back to Build). If it's solid, request_approval.`,
  },
  {
    id: "qa", name: "Rigorous QA", tools: ALL, rejectTo: "build",
    prompt:
`Rigorous QA. Do NOT just confirm the page loads. DECOMPOSE the feature into concrete test cases, then test EACH ONE in series against the real running app, with captured evidence AND a vision check per case.

THE QA SCENARIO LEDGER (do this EVERY QA run). There is ONE canonical, persistent ledger for this branch: the file QA-SCENARIOS.md at the repo root — the running record of every scenario QA has EVER tested for this ticket. It GROWS run over run, never resets. START by reading it if it exists (build on it, never duplicate a row). This run, ADD a row for every NEW scenario and UPDATE existing rows IN PLACE for any you re-test (refresh verdict + "Last tested"). Render it as ONE clean GitHub-flavored Markdown table with NO blank lines between rows, columns exactly: | # | Scenario | Expected | Verdict | Last tested | Evidence | (Verdict = ✅ PASS / ❌ FAIL / ⏭️ not-yet; "Last tested" = today's date + mode; Evidence = real capture filename or "—"), with a one-line header (date · mode · short summary). Write the file back, display_artifact it as "QA Scenarios", COMMIT it on the branch (the one .md the PR carries), and if a PR is already open (gh pr view) update its body with the latest table (gh pr edit --body).

STEP 1 — WRITE THE TEST PLAN. From the spec's acceptance checklist and the actual feature, enumerate the test cases that exercise the REAL end-to-end user value — every meaningful capability, not just "it renders". Think about the WHOLE chain a user would do. For a rich feature that means cases such as: produce the feature's primary output end-to-end; exercise EACH option/variant it exposes and confirm each one actually takes effect (the output changes); walk the full multi-step chain a user would (create → configure → use the result); and produce the actual end deliverable the ticket promised — not just that a page rendered. Add the obvious failure cases (empty input, a route that errors). display_artifact this as "QA Test Plan" (markdown, numbered list of cases with the expected result for each).

STEP 2 — SET UP ONCE. Bring the backend up (see PROJECT ENVIRONMENT & AUTH above), start_dev_server, and authenticate ONCE — use a NON-CAPPED test user (e.g. the paid fixture; a free/daily-capped user can't generate). screenshot_page a protected route to confirm you see the real app, not the login form. Reuse this ONE dev server + session for every case.

STEP 3 — TEST EACH CASE, ONE AT A TIME, IN SERIES. Never run cases in parallel — concurrent browsers/generations will fall the hardware over. For each case in your plan:
   • Drive the real flow against the running app (type/click/toggle the actual controls; read the source for selectors if needed). For an async result, use a record_walkthrough 'waitFor' step on the success element (timeout up to 180s) so you capture the RESULT, not a spinner.
   • RECORD THE PAGE WHERE THE RESULT ACTUALLY RENDERS — NOT where you clicked the button. The #1 recording failure is filming the form/dashboard you triggered the action on, while the real result renders on a DIFFERENT route (e.g. after Generate the app navigates to a project/result page like /project/...). Watch what URL the app lands on (read the dev server log / the browser URL), then point record_walkthrough at THAT result URL and waitFor the result element there (the rendered output, the populated result view). If the result is reachable by URL (e.g. it carries a result id), navigate straight to that URL and record it. A video that only shows the input form with "no result yet" is a FAIL — fix the recording.
   • Use present:false probes while finding selectors/URLs so they stay out of Deliverables.
   • Capture evidence that SHOWS the result: a screenshot (present:true for the key ones) and/or a short walkthrough video OF THE RESULT PAGE.
   • VERIFY WITH YOUR EYES: analyze_image the capture and judge whether the result is actually correct for THIS case — e.g. "did applying this option actually change the output vs before?", "does this match what the case expected?". Record the case verdict (PASS/FAIL) + the concrete evidence (the ACTUAL capture filename — never cite a file you didn't save).
   • MOTION / TIME-BASED CASES NEED A MOTION TEST, NOT A SINGLE FRAME. If a case involves any motion or time-based behaviour (an animation, a transition, a drag, a live-updating value, a playing media element), a static screenshot proves NOTHING — a control existing is not proof anything actually moves. Capture the element at TWO+ moments while it should be changing (e.g. screenshot, wait ~400ms, screenshot again — or sample frames from the recorded video) and confirm the pixels actually CHANGED between them. If the frames are identical when something should be moving, it is NOT working — that is a FAIL, reject to Build.
   • A case fails if it errors, the capability is missing, the result is wrong (e.g. selecting Walk doesn't move the character), or you could not capture the result. Note it precisely.

STEP 4 — SURFACE EVERY CASE + REPORT. Each scenario must be visible at the QA state, not buried in one report:
   • Present EACH important case as its OWN labeled deliverable so it bubbles up — named exactly "Case N — <case> — PASS" or "Case N — <case> — FAIL" (e.g. "Case 12 — Walk animation — FAIL"). THE CASE DELIVERABLE MUST BE THE ACTUAL CAPTURE — an IMAGE or VIDEO, never a markdown text note (the human spot-checks QA by LOOKING at these; an unviewable note is the #1 QA failure). Use screenshot_page/record_walkthrough with present:true, OR display_artifact with file:"<path to the .png/.jpg/.mp4>" — passing a FILE path is what renders it as a picture/video; an inline body string renders as unviewable text. Screenshot for static cases, VIDEO for motion / time-based cases (so the change is actually visible). Put pixel diffs / numbers in the NAME and the QA Report, not as a markdown-only Case deliverable. The reviewer must be able to scan the QA deliverables and SEE every scenario's evidence + verdict as thumbnails.
   • Then fold EVERY case from this run into the QA SCENARIO LEDGER (QA-SCENARIOS.md) per the ledger rules above — that persistent table, not a one-off report, is the canonical record: write it, display it as "QA Scenarios", commit it, and update the PR body if a PR is open.
Overall verdict: if ANY important case fails (core flow broken, runtime error, the real end deliverable isn't produced, a claimed capability doesn't actually work — e.g. an animation that doesn't move), reject with specific per-case reasons (loops to Build). Only request_approval if the feature genuinely works across the cases with shown, vision-verified evidence.`,
  },
  {
    id: "acceptance", name: "Acceptance", tools: ALL, rejectTo: "build",
    prompt:
`Final acceptance: step back and judge whether this actually satisfies the TICKET as a user would expect — not just the letter of the spec. Consider completeness, UX quality, and that nothing important was missed.
display_artifact an "Acceptance" note (markdown) with your judgement. If it doesn't meet the bar, reject with reasons (loops back to Build). If it does, request_approval.`,
  },
  {
    id: "pr", name: "Open PR", tools: ALL,
    prompt:
`Open the pull request. Make sure all work is committed on this branch — including QA-SCENARIOS.md (the QA scenario ledger is an intentional review artifact that belongs in the PR; the rest of the *.md scratch does not). Push it (git push -u origin HEAD). Then open a PR with the GitHub CLI: write a clear title and a body covering what changed, why, and how it was tested. For "how it was tested", EMBED the full QA scenario table from QA-SCENARIOS.md directly in the body (under a "## QA scenarios tested" heading) — paste the actual Markdown table so reviewers see every scenario + verdict at a glance, don't just link it. e.g. gh pr create --title "..." --body "..." --base <the base branch> (or gh pr edit --body if a PR already exists). Capture the PR URL.
display_artifact a "PR" note (markdown) including the PR link and a short summary, then request_approval.`,
  },
];

const DEFAULT_VERSION = "v3-repo-28";

// Fallback machine if no YAML files are present — the real source of truth is
// machines/*.yaml (machines as code). This keeps the app working out of the box.
const FALLBACK_MACHINE = {
  id: DEFAULT_MACHINE_ID,
  name: "Repo pipeline — PRD→Spec→Mock→Build→Review→QA→Acceptance→PR",
  description: "Single agent, real repo, non-linear: PRD clarifies; Review/QA/Acceptance loop back to Build until it passes; PR opens it. One example machine — build your own.",
  version: DEFAULT_VERSION,
  settings: { maxLoops: 10, maxTurns: 120, phaseTimeoutMin: 45 } as MachineSettings,
  states: STATES,
};

let seeded = false;
/** Seed the DB from machines/*.yaml (the source of truth). The YAML's `version`
 *  is stamped into the description so editing a file reseeds it on restart. */
export async function ensureDefaults() {
  if (seeded) return;
  const yaml = await loadMachineFiles();
  const machines: YamlMachine[] = yaml.length ? yaml : [FALLBACK_MACHINE];
  const known = listMachines();
  for (const m of machines) {
    const ver = m.version || DEFAULT_VERSION;
    const existing = known.find(x => x.id === m.id);
    if (!existing || !existing.description.includes(`[${ver}]`)) {
      upsertMachine({ id: m.id, name: m.name, description: `${m.description || ""} [${ver}]`.trim(), states: m.states, settings: m.settings });
    }
  }
  // Also seed any Claude Code workflows under .claude/workflows/*.js — the app
  // visualizes/manages them alongside the YAML machines. Reseed when the script changes.
  try {
    const workflows = await loadWorkflowFiles();
    for (const w of workflows) {
      const existing = known.find(x => x.id === w.id);
      const prevScript = (existing?.settings as { workflow?: { script?: string } } | undefined)?.workflow?.script;
      if (!existing || prevScript !== w.settings.workflow.script) {
        upsertMachine({ id: w.id, name: w.name, description: w.description, states: w.states, settings: w.settings });
      }
    }
  } catch (e) { console.error("workflow seed:", e instanceof Error ? e.message : e); }
  seeded = true;
}

export const EXAMPLE_GOAL = {
  title: "task board → create, drag, filter, persist",
  goal:
`Add a "task board" to the app. People can create tasks, drag them between columns (To do / In progress / Done), filter by tag, and mark a task complete. Tasks persist across reloads (saved to the backend, not just in memory). Dragging a card updates its status immediately and optimistically, and the board matches the app's existing look and components. Cover the obvious cases too: an empty board, a task with no tag, and reordering within a column. It should be easy to see, at a glance, what's in each column and what's left to do.`,
};
