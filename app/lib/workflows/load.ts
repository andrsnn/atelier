/**
 * Load Claude Code workflow scripts from `.claude/workflows/*.js` and turn each
 * into a machine the app can visualize/manage. This is the workflow analogue of
 * `../machines/load.ts` (which loads `machines/*.yaml`): a second input format
 * feeding the same machine model. The app becomes a visualizer + management layer
 * over the workflows a team keeps in its repo.
 */
import { promises as fs } from "fs";
import { join } from "path";
import { parseWorkflow, workflowToMachine, type BuiltMachine } from "./parse";

export const WORKFLOW_DIR = join(".claude", "workflows");

/** Read + statically parse every workflow script under .claude/workflows. */
export async function loadWorkflowFiles(): Promise<BuiltMachine[]> {
  const dir = join(process.cwd(), WORKFLOW_DIR);
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => /\.(jsx?|mjs|cjs|tsx?)$/i.test(f)); }
  catch { return []; }
  const out: BuiltMachine[] = [];
  for (const f of files.sort()) {
    try {
      const src = await fs.readFile(join(dir, f), "utf8");
      const wf = parseWorkflow(src);
      if (!wf.ok) { console.error(`workflow ${f}: ${wf.error}`); continue; }
      out.push(workflowToMachine(wf, `wf-${f.replace(/\.[^.]+$/, "")}`, src));
    } catch (e) {
      console.error(`workflow ${f}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}
