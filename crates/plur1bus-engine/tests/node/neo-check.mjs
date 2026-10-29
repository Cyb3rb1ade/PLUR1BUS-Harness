#!/usr/bin/env node
// RE-02/T5 Node reader, engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let engineRoot;
try {
  engineRoot = path.dirname(createRequire(path.join(root, "packages/core/package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
} catch {
  throw new Error("run pnpm test:prep (the engine package is not installed)");
}
const { createNeoStore, createTurnEvent } = await import(pathToFileURL(path.join(engineRoot, "lib/neo-arch.js")).href);

/** Read a workspace directory with the actual pinned Node Neo-store implementation. */
export function checkNeo(directory, { append = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), "re02-neo-read-"));
  try {
    const store = createNeoStore(scratch, "fixture");
    cpSync(directory, store.paths.workspaceDir, { recursive: true });
    if (append) {
      store.appendTurns(createTurnEvent({ id: "node-roundtrip-turn", content: "Node appended this turn.",
        workspaceKey: "fixture", agentId: "a1", role: "user", createdAt: "2027-01-15T08:00:01.000Z" }));
      store.writeRunState({ ...store.readRunState(), fromNode: true });
      store.recordHook("nodeRoundtrip", { fromNode: true });
      cpSync(store.paths.workspaceDir, directory, { recursive: true });
    }
    const index = JSON.parse(readFileSync(store.paths.vectorIndex, "utf8"));
    const ids = Object.keys(index.entries);
    const vectors = ids.map((id) => ({ id, vector: store.readVector(id) }));
    assert.ok(vectors.every(({ vector }) => Array.isArray(vector)), "Node must read every Rust-written vector");
    const turns = store.readTurns(100);
    return { generation: store.vectorStats(), vectors, turnCount: turns.length, turnIds: turns.map(({ id }) => id),
      runState: store.readRunState(), hookState: store.readHooks() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--neo");
  const append = args.includes("--append");
  const directory = args.find((arg) => arg !== "--append");
  assert.ok(directory, "usage: neo-check.mjs [--neo] <directory> [--append]");
  process.stdout.write(`${JSON.stringify(checkNeo(path.resolve(directory), { append }))}\n`);
}
