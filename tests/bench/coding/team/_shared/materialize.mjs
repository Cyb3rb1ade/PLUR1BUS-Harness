// SPDX-License-Identifier: MIT
/** Public-input materialization only. Reference overlays are explicit authored self-test inputs. */
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest } from "./manifest.mjs";
import { seedValues } from "./seed.mjs";

/** Enumerate bounded regular source files; links and special files never enter public inputs or snapshots. */
export async function sourceFiles(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture tree requires a regular directory");
  const files = [];
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.nlink > 1 && stat.isFile())) {
        throw new Error("fixture trees require regular files without links");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        bytes += stat.size;
        files.push(relative(root, path).replaceAll("\\", "/"));
        if (files.length > 512 || bytes > 16 * 1024 * 1024) throw new Error("fixture tree exceeds limits");
      }
    }
  }
  await visit(root);
  return files.sort();
}

/** Expand public source templates without copying private seed/oracle data. */
export function expandSource(text, seed) {
  const values = seedValues(seed);
  return text
    .replaceAll("__SEED__", values.tag)
    .replaceAll("__PROFILE__", String(values.profile))
    .replaceAll("__SALT__", String(values.n));
}

/** Apply a source overlay using the same public name and logic substitutions as the starting tree. */
export async function applyTree(source, destination, seed) {
  const values = seedValues(seed);
  for (const file of await sourceFiles(source)) {
    const target = join(destination, file.replaceAll("__SEED__", values.tag));
    const text = expandSource(await readFile(join(source, file), "utf8"), seed);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

function runContract(task, tag) {
  const entries = task.packages
    .map((item) => `- \`${item.entry.replaceAll("__SEED__", tag)}\`: \`${item.symbol.replaceAll("__SEED__", tag)}\``)
    .join("\n");
  const runtime = {
    typescript: "Node 24.21 with --experimental-transform-types; .ts imports and enum are supported.",
    python: "Python 3.13 with -I -B -X utf8; the entry directory and src/ are on the module path.",
    rust: "rustc --edition=2024 from the repository's rust-toolchain.toml. The bridge exposes crate::contract.",
    go: "Go in the private fixture.local/task module. Proxies and cgo are disabled; use the standard library.",
  }[task.language];
  const values =
    task.kind === "coupled"
      ? "The first function accepts text, middle functions accept/return Packet, and the last returns text. " +
        "Packet carries the previous stage's payload, stage and integrity stamp; use the public contract module. " +
        "Later stages are also tested with the actual outputs of their predecessors."
      : "Each listed function accepts and returns" +
        " a UTF-8 string. The integration entry c" +
        "omposes the public endpoints.";
  return (
    `\n## How your code is run\n\n${runtime}\n\n${entries}\n\n${values}\n\n` +
    "The host sends raw UTF-8 through stdin, including embedded NUL, and compares the returned value outside " +
    "the candidate process. Do not print diag" +
      "nostics. Neighbor modules under src/ are" +
      " allowed; the provided contracts " +
    "module is fixed/read-only. Build artifacts outside src/ are ignored. External packages, " +
    "links and files outside the working directory are unavailable. The public contract module documents the " +
    "instance's optional text frame. Candidat" +
      "e go.mod, rust-toolchain.toml and compil" +
      "er configuration are ignored.\n"
  );
}

/** Materialize one declared seed atomically; a failed traversal removes only the newly created destination. */
export async function materialize(taskRoot, destination, seed, referenceStages = 0) {
  const task = await loadManifest(taskRoot);
  const expected = seedValues(seed);
  if (!task.seeds.includes(seed)) throw new Error("seed is not declared by this task");
  if (!Number.isInteger(referenceStages) || referenceStages < 0 || referenceStages > task.packages.length) {
    throw new Error("invalid reference stage");
  }
  const { instanceForSeed } = await import(pathToFileURL(join(taskRoot, task.seedGenerator)).href);
  const values = instanceForSeed(seed);
  if (values.taskId !== task.id || values.seed !== seed || values.tag !== expected.tag || values.n !== expected.n) {
    throw new Error("invalid generated instance");
  }
  await mkdir(destination);
  try {
    await applyTree(join(taskRoot, task.start), destination, seed);
    for (const item of task.packages.slice(0, referenceStages)) {
      await applyTree(join(taskRoot, item.reference), destination, seed);
    }
    const instruction = (await readFile(join(taskRoot, task.instruction), "utf8")).replaceAll("__SEED__", values.tag);
    await writeFile(join(destination, "TASK.md"), instruction + runContract(task, values.tag));
    await writeFile(
      join(destination, "instance.json"),
      JSON.stringify({
        schema: "plur1bus.team-instance/1",
        taskId: task.id,
        tag: values.tag,
        n: values.n,
        profile: values.profile,
      }) + "\n",
    );
    return task;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
