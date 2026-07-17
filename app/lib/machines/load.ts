/**
 * Machines as code. A machine is defined in a YAML file under `machines/` —
 * states (prompt + tools + gate + rejectTo) and settings. This is the source of
 * truth; the DB is just a cache seeded from these files. Edit the YAML, restart,
 * and the machine reseeds. Add a file to add a machine.
 */
import { promises as fs } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { StateDef, MachineSettings } from "../db";

export interface YamlMachine {
  id: string;
  name: string;
  description?: string;
  version?: string;
  settings?: Partial<MachineSettings>;
  states: StateDef[];
}

/** Read + parse every machine YAML under ./machines (non-blocking). */
export async function loadMachineFiles(): Promise<YamlMachine[]> {
  const dir = join(process.cwd(), "machines");
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter(f => /\.ya?ml$/i.test(f)); }
  catch { return []; }
  const out: YamlMachine[] = [];
  for (const f of files.sort()) {
    try {
      const m = YAML.parse(await fs.readFile(join(dir, f), "utf8")) as YamlMachine;
      if (m?.id && Array.isArray(m.states) && m.states.length) out.push(m);
      else console.error(`machine yaml ${f}: missing id/states`);
    } catch (e) { console.error(`machine yaml ${f}:`, e instanceof Error ? e.message : e); }
  }
  return out;
}
