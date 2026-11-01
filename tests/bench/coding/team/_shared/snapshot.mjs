// SPDX-License-Identifier: MIT
/** Bounded public-input snapshot, ignoring build/Git/cache artifacts and pinning Linux directory handles. */
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandSource } from "./materialize.mjs";
import { seedValues } from "./seed.mjs";

function descriptorPath(handle, fallback) {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : fallback;
}

async function regularBytes(path, limits) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || ++limits.files > 512 || stat.size > limits.remaining) {
      throw new Error("invalid public source file");
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      limits.signal.throwIfAborted();
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("public source changed during snapshot");
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead) throw new Error("public source grew during snapshot");
    limits.remaining -= bytes.length;
    return bytes;
  } finally {
    await handle.close();
  }
}

async function sourceTree(source, destination, limits, depth = 0) {
  limits.signal.throwIfAborted();
  if (++limits.directories > 512 || depth > 16) throw new Error("public source tree exceeds directory limits");
  const handle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await mkdir(destination);
    const anchor = descriptorPath(handle, source);
    for (const entry of await readdir(anchor, { withFileTypes: true })) {
      const from = join(anchor, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) await sourceTree(from, to, limits, depth + 1);
      else await writeFile(to, await regularBytes(from, limits));
    }
  } finally {
    await handle.close();
  }
}

async function fixedContract(task, taskRoot, image, seed) {
  const templates = {
    typescript: "contracts.__SEED__.ts",
    python: "contracts__SEED__.py",
    rust: "contracts.__SEED__.rs",
    go: "contracts__SEED__/contracts__SEED__.go",
  };
  const file = templates[task.language];
  const expected = expandSource(await readFile(join(taskRoot, task.start, "src", file), "utf8"), seed);
  const actual = await readFile(join(image, "src", file.replaceAll("__SEED__", seedValues(seed).tag)));
  if (!actual.equals(Buffer.from(expected))) throw new Error("fixed public contract changed");
}

/** Copy only src and two public documents; readonly contract edits are candidate failures, not exclusions. */
export async function snapshotInputs(task, taskRoot, candidateRoot, image, seed, signal) {
  const root = await open(candidateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const limits = { files: 0, directories: 0, remaining: 16 * 1024 * 1024, signal };
  try {
    const anchor = descriptorPath(root, candidateRoot);
    const metadata = await regularBytes(join(anchor, "instance.json"), limits);
    const instance = JSON.parse(metadata.toString("utf8"));
    const values = seedValues(seed);
    if (
      Object.keys(instance).sort().join(",") !== "n,profile,schema,tag,taskId" ||
      instance.schema !== "plur1bus.team-instance/1" ||
      instance.taskId !== task.id ||
      instance.tag !== values.tag ||
      instance.n !== values.n ||
      instance.profile !== values.profile
    ) {
      throw new Error("candidate instance mismatch");
    }
    const instruction = await regularBytes(join(anchor, "TASK.md"), limits);
    await mkdir(image);
    await sourceTree(join(anchor, "src"), join(image, "src"), limits);
    await writeFile(join(image, "instance.json"), metadata);
    await writeFile(join(image, "TASK.md"), instruction);
    await fixedContract(task, taskRoot, image, seed);
    await writeFile(join(image, "go.mod"), "module fixture.local/task\ngo 1.22\n");
  } finally {
    await root.close();
  }
}
