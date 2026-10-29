/** Discovery grants exact source-read capabilities; remote paths never become host-local paths. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { createLocalFs, type ReadonlyFs } from "@plur1bus/remote-fs";
import { validateResult } from "@plur1bus/rpc-schema";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { discoverReaderSources } from "../../src/import/reader-discovery.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const ADMIN = { userId: "admin", role: "admin" as const, kind: "person" as const };
async function remote(root: string): Promise<ReadonlyFs> {
  const fs = await createLocalFs({ root });
  const local = (path: string) => join(root, ...posix.relative("/", posix.resolve("/", path)).split("/"));
  const virtual = (path: string) => posix.join("/", relative(root, path).split(sep).join("/"));
  return { stat: path => fs.stat(local(path)), lstat: path => fs.lstat(local(path)),
    readdir: path => fs.readdir(local(path)), readFile: (path, cap) => fs.readFile(local(path), cap),
    realpath: async path => virtual(await fs.realpath(local(path))), readlink: path => fs.readlink(local(path)) };
}
function directory(path: string) { mkdirSync(path, { recursive: true }); return path; }

it("lists bounded known Harness stores independently of source families without scanning unrelated trees", async () => {
  const root = temp();
  const names = [".plur1bus", ".local/share/plur1bus", "Library/Application Support/plur1bus", "AppData/Local/PLUR1BUS"];
  for (const name of names) directory(join(root, "home", "alice", name, "state", "lancedb"));
  directory(join(root, "unrelated", "hidden", ".plur1bus", "state", "lancedb"));
  const fs = await remote(root);
  const listed: string[] = [];
  const result = await discoverReaderSources({ reader: { root: "/", remote: true,
    fs: { ...fs, readdir: async path => { listed.push(path); return fs.readdir(path); } } } });
  assert.equal(result.filter(item => item.kind === "source").length, 0);
  assert.deepEqual(result.filter(item => item.kind === "store").map(item => item.path).sort(),
    names.map(name => `/home/alice/${name}/state/lancedb`).sort());
  assert.ok(!listed.some(path => path.startsWith("/unrelated")));
});

it("seals a selected discovered remote store under its original authority and refuses foreign or expired IDs", async () => {
  const root = temp();
  const home = temp();
  const state = directory(join(root, "home", "alice", ".openclaw"));
  writeFileSync(join(state, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace: "/external-workspace" }] } }));
  const store = directory(join(root, "home", "alice", ".plur1bus", "state", "lancedb"));
  writeFileSync(join(store, "SOUL.md"), "remote-store-canary");
  let now = Date.now();
  const opened: string[] = [];
  let closed = 0;
  const registry = createSourceRegistry({ home, now: () => now, ssh: {
    listConnections: async () => ({ connections: [{ id: "ssh", roots: ["/"] }] }),
    open: async (_id, authority) => { opened.push(authority); return { fs: await remote(root), close: async () => { closed++; } }; },
  } });
  const discovery = await registry.discover({ kind: "ssh", family: "openclaw", connectionId: "ssh", path: "/" }, ADMIN);
  assert.equal(validateResult("admin.import.detect", discovery).ok, true);
  const candidate = discovery.candidates[0]!;
  const found = discovery.stores?.[0];
  assert.ok(found, "known standalone stores must be distinct selectable metadata");
  assert.equal(found.candidateId, candidate.id);
  assert.equal(found.path, "/home/alice/.plur1bus/state/lancedb");
  const source = await registry.detect(candidate.source, ADMIN);
  const maps = [{ from: "/external-workspace", to: `store:${found.id}` }];
  assert.equal(registry.approvesMaps(maps, ADMIN), true);
  assert.equal(registry.approvesMaps(maps, { ...ADMIN, userId: "other" }), false);
  await assert.rejects(registry.map(source.sourceId, maps, { ...ADMIN, userId: "other" }));
  const sealed = await registry.map(source.sourceId, maps, ADMIN);
  assert.equal(readFileSync(join(sealed.maps[0]!.to, "SOUL.md"), "utf8"), "remote-store-canary");
  assert.equal(sealed.source.view.agents[0]?.hasPersona, true);
  assert.ok(opened.every(path => path === "/"));
  assert.equal(closed, opened.length);
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(registry.approvesMaps(maps, ADMIN), false);
  await assert.rejects(registry.map(sealed.source.record.id, maps, ADMIN));
});
