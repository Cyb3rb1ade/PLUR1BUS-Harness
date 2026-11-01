// SPDX-License-Identifier: MIT
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedValues } from './seed.mjs';

export async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('fixture trees cannot contain symlinks');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return files.sort();
}
export async function applyTree(source, destination, seed) {
  const tag = seedValues(seed).tag;
  for (const file of await sourceFiles(source)) {
    const target = join(destination, file.replaceAll('__SEED__', tag));
    const text = (await readFile(join(source, file), 'utf8')).replaceAll('__SEED__', tag);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}
// Copies only the public start tree, instruction and seed metadata. The reference
// overlays below are exclusively for fixture self-tests, never for agent input.
export async function materialize(taskRoot, destination, seed, referenceStages = 0) {
  const task = JSON.parse(await readFile(join(taskRoot, 'task.json'), 'utf8'));
  if (!Number.isInteger(referenceStages) || referenceStages < 0 || referenceStages > task.packages.length) throw new Error('invalid reference stage');
  const { instanceForSeed } = await import(pathToFileURL(join(taskRoot, task.seedGenerator)).href);
  const values = instanceForSeed(seed);
  const expected = seedValues(seed);
  if (values.taskId !== task.id || values.seed !== seed || values.tag !== expected.tag || values.n !== expected.n) throw new Error('invalid generated instance');
  await mkdir(destination);
  await applyTree(join(taskRoot, task.start), destination, seed);
  for (const entry of task.packages.slice(0, referenceStages)) await applyTree(join(taskRoot, entry.reference), destination, seed);
  const instruction = (await readFile(join(taskRoot, task.instruction), 'utf8')).replaceAll('__SEED__', values.tag);
  await writeFile(join(destination, 'TASK.md'), instruction);
  await writeFile(join(destination, 'instance.json'), JSON.stringify({ schema: 'plur1bus.team-instance/1', taskId: task.id, ...expected }) + '\n');
  return task;
}
