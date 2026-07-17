import { NextRequest, NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { nanoid } from "nanoid";
import { isInsideFactory } from "@/app/lib/sandbox";
import { listRuns, listMachines, createRun, getMachine, getRun, updateRun, countArchived } from "@/app/lib/db";
import { ensureDefaults, DEFAULT_MACHINE_ID } from "@/app/lib/machines/defaults";
import { getProject, getProjects } from "@/app/lib/projects";
import { start, reconcile } from "@/app/lib/engine/runner";
import { isMultimodalPrimary } from "@/app/lib/engine/models";
import { describeImage } from "@/app/lib/engine/vision";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureDefaults();
  reconcile(); // re-schedule any run stranded by a restart (in-memory queue is volatile)
  const archived = req.nextUrl.searchParams.get("archived") === "1";
  return NextResponse.json({ runs: listRuns({ archived }), machines: listMachines(), projects: getProjects(), archivedCount: countArchived() });
}

export async function POST(req: NextRequest) {
  await ensureDefaults();
  const body = await req.json();
  const goal: string = (body.goal || "").trim();
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  const machineId: string = body.machineId || DEFAULT_MACHINE_ID;
  if (!getMachine(machineId)) return NextResponse.json({ error: "machine not found" }, { status: 400 });

  const project = body.projectId ? getProject(body.projectId) : undefined;
  const primary = body.primaryModel || "claude:opus";
  const vision = body.visionModel || "ollama:kimi-k2.6";

  const id = nanoid(10);
  const title: string = (body.title || goal.split("\n")[0]).slice(0, 80);
  // Where run workspaces (git worktrees + captures) live. Configurable so the heavy
  // data can sit on an external/large volume. Default is OUTSIDE the factory install
  // (~/.atelier/workspaces): a workspace nested UNDER the factory dir makes the factory's
  // own dev server watch the agent's build output and recursively HMR-reload until it OOMs.
  const wsRoot = process.env.FACTORY_WORKSPACES_DIR || join(homedir(), ".atelier", "workspaces");
  if (isInsideFactory(wsRoot)) {
    return NextResponse.json({ error: `Refused: the run workspace root (${wsRoot}) is inside the Atelier factory directory. Set FACTORY_WORKSPACES_DIR to a path OUTSIDE the install — a workspace under the factory tree causes recursive dev-server reloads that OOM the machine.` }, { status: 400 });
  }
  const workspace = join(wsRoot, id);

  const run = createRun({
    id, title, goal, machine_id: machineId, workspace,
    repo_path: project?.repoPath ?? null,
    base_branch: project?.baseBranch ?? null,
    primary_model: primary,
    vision_model: vision,
    gate_mode: body.gateMode === "all" || body.gateMode === "none" ? body.gateMode : "machine",
    // Self-learning opt-out: default apply the loop's learned principles; false = run clean.
    apply_principles: body.applyPrinciples !== false,
  });
  // generic run mode: use the picked one if the machine declares it, else its default.
  const machineModes = getMachine(machineId)!.settings.modes || [];
  const picked = machineModes.find(m => m.id === body.mode);
  const fallback = machineModes.find(m => m.default) || machineModes[0];
  const mode = (picked || fallback)?.id ?? null;
  if (mode) updateRun(id, { mode } as any);

  // Skip phases the human turned off — but only ones the MACHINE declares skippable
  // (state.optional in the YAML). Their ids go to disabled_states; the driver skips
  // them when advancing. We never let an arbitrary/non-optional state be disabled.
  const optionalIds = new Set(getMachine(machineId)!.states.filter(s => s.optional).map(s => s.id));
  const disabledSteps = (Array.isArray(body.disabledSteps) ? body.disabledSteps : [])
    .filter((x: unknown): x is string => typeof x === "string" && optionalIds.has(x));
  if (disabledSteps.length) updateRun(id, { disabled_states: JSON.stringify([...new Set(disabledSteps)]) });

  // Reference image(s) (optional). The human can attach several (multi-select or
  // ⌘V paste). Store as a JSON array; if the primary can't see (text-only),
  // describe each now via the vision helper so the agent gets them as text. Hybrid.
  const rawImages: unknown[] = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  const images = rawImages.filter((s): s is string => typeof s === "string" && s.startsWith("data:image/"));
  if (images.length) {
    let desc: string | null = null;
    if (!isMultimodalPrimary(primary)) {
      const descs: string[] = [];
      for (let i = 0; i < images.length; i++) {
        try { const d = await describeImage({ dataUrl: images[i], visionModel: vision }); if (d) descs.push(images.length > 1 ? `Image ${i + 1}: ${d}` : d); } catch { /* skip this one */ }
      }
      desc = descs.length ? descs.join("\n\n") : null;
    }
    updateRun(id, { reference_image: JSON.stringify(images), reference_desc: desc });
  }

  start(id);
  return NextResponse.json({ run: getRun(id) });
}
