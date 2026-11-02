// SPDX-License-Identifier: MIT
/** One validated manifest boundary shared by materialization and host verification. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTeamTask } from "../../../../../packages/core/src/collab/team-eval.ts";

/** Read and validate a private task before any declared path or symbol is used. */
export async function loadManifest(root) {
  const value = JSON.parse(await readFile(join(root, "task.json"), "utf8"));
  return parseTeamTask(value);
}
