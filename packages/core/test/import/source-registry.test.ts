/** New GUI sources are owner-bound sealed local trees; SSH authority stays at the configured root. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, parse, posix, relative, sep, win32 } from "node:path";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createLocalFs, RemoteFsError, type ReadonlyFs } from "@plur1bus/remote-fs";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { createImportService } from "../../src/import/service.ts";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const owner = { userId: "owner", role: "owner" as const, kind: "person" as const };
const MARKER = "fixture-source-secret-not-in-detect-view";

async function factory() {
  const module = await import("../../src/import/source-registry.ts").catch(() => undefined);
  assert.equal(typeof module?.createSourceRegistry, "function", "GUI source detection needs a durable scoped registry");
  return module!;
}

function source(root: string, sourceRoot = root) {
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "SOUL.md"), "source persona body");
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace: sourceRoot === root ? workspace : posix.join(sourceRoot, "workspace") }] } }));
  writeFileSync(join(root, ".env"), `OPENAI_API_KEY=${MARKER}\nUNALLOWLISTED_TOKEN=${MARKER}-unapproved\n`);
}

async function remoteFs(root: string, authority: string, paths = posix): Promise<ReadonlyFs> {
  const backend = await createLocalFs({ root });
  const canonical = await backend.realpath(".");
  const local = (path: string) => join(canonical, ...paths.relative(authority, paths.resolve(authority, path)).split(paths.sep));
  const remote = (path: string) => paths.join(authority, relative(canonical, path).split(sep).join(paths.sep));
  return { stat: path => backend.stat(local(path)), lstat: path => backend.lstat(local(path)),
    readdir: path => backend.readdir(local(path)), readFile: (path, maximum) => backend.readFile(local(path), maximum),
    realpath: async path => remote(await backend.realpath(local(path))),
    readlink: path => backend.readlink(local(path)) };
}

describe("GUI import source registry", () => {
  it("seals a local source, projects metadata, and reopens an owner-bound source after Core restart", async () => {
    const api = await factory();
    const home = temp();
    const root = temp();
    source(root);
    const registry = api.createSourceRegistry({ home });
    const detected = await registry.detect({ kind: "path", family: "openclaw", path: root }, owner);
    assert.match(detected.sourceId, /^[a-f0-9-]{36}$/);
    assert.equal(detected.counts.agents, 1);
    assert.equal(detected.agents[0]?.hasPersona, true);
    assert.ok(!JSON.stringify(detected).includes(MARKER));
    assert.ok(!JSON.stringify(detected).includes("source persona body"));
    const reopened = api.createSourceRegistry({ home });
    const saved = await reopened.get(detected.sourceId, owner);
    assert.equal(saved.record.sourceSha256, detected.sourceSha256);
    assert.equal(readFileSync(join(saved.root, "workspace", "SOUL.md"), "utf8"), "source persona body");
    await assert.rejects(reopened.get(detected.sourceId, { ...owner, userId: "other-owner" }));
    const credentials = await reopened.collectSecrets(detected.sourceId, owner);
    assert.deepEqual([...credentials.keys()], ["OPENAI_API_KEY"]);
    assert.equal(credentials.get("OPENAI_API_KEY")?.toString(), MARKER);
    for (const value of credentials.values()) value.fill(0);
  });

  it("keeps SSH at the original configured authority while snapshotting only the canonical selected descendant", async () => {
    const api = await factory();
    for (const authority of ["/configured", "/"]) {
      const home = temp();
      const configured = temp();
      const selected = posix.join(authority, "selected");
      source(join(configured, "selected"), selected);
      writeFileSync(join(configured, "outside-selected"), "unselected source data");
      const opened: string[] = [];
      let closed = 0;
      const registry = api.createSourceRegistry({ home, ssh: {
        listConnections: async () => ({ connections: [{ id: "example", roots: [authority] }] }),
        open: async (_id: string, root: string) => {
          opened.push(root);
          return { fs: await remoteFs(configured, authority), close: async () => { closed++; } };
        },
      } });
      const detected = await registry.detect({ kind: "ssh", family: "openclaw", connectionId: "example", path: selected }, owner);
      assert.deepEqual(opened, [authority]);
      assert.equal(closed, 1);
      const saved = await registry.get(detected.sourceId, owner);
      await assert.rejects(createLocalFs({ root: join(saved.root, "outside-selected") }));
      assert.equal(saved.record.selection.kind, "ssh");
      assert.equal(detected.agents[0]?.hasPersona, true);
    }
  });

  it("rejects unknown families and agent principals before source reads and detects tampered seals", async () => {
    const api = await factory();
    const home = temp();
    const root = temp();
    source(root);
    const registry = api.createSourceRegistry({ home });
    await assert.rejects(registry.detect({ kind: "path", family: "unsupported", path: root }, owner));
    await assert.rejects(registry.detect({ kind: "path", family: "openclaw", path: root }, { ...owner, kind: "agent" }));
    const detected = await registry.detect({ kind: "path", family: "openclaw", path: root }, owner);
    const saved = await registry.get(detected.sourceId, owner);
    writeFileSync(join(saved.root, "workspace", "SOUL.md"), "tampered selected content");
    await assert.rejects(registry.get(detected.sourceId, owner));
  });

  it("seals an explicitly selected local alias and an additional aliased map through their pinned canonical roots", async () => {
    const api = await factory();
    const home = temp();
    const root = temp();
    mkdirSync(join(root, "workspace"));
    writeFileSync(join(root, "workspace", "SOUL.md"), "local alias persona");
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "alpha", workspace: "./workspace" }] } }));
    const alias = join(temp(), "selected");
    symlinkSync(root, alias, "junction");
    const registry = api.createSourceRegistry({ home });
    const detected = await registry.detect({ kind: "path", family: "openclaw", path: alias }, owner);
    assert.equal(detected.agents[0]?.hasPersona, true);
    const external = temp();
    writeFileSync(join(external, "SOUL.md"), "aliased map persona");
    const mappedAlias = join(temp(), "additional");
    symlinkSync(external, mappedAlias, "junction");
    const mapped = await registry.map(detected.sourceId, [{ from: "/external", to: mappedAlias }], owner);
    assert.equal(readFileSync(join(mapped.maps[0]!.to, "SOUL.md"), "utf8"), "aliased map persona");
  });

  it("uses a confined UNC read port for running WSL sources and never opens a stopped distro without consent", async () => {
    const api = await factory();
    const home = temp();
    const root = temp();
    source(root, "/home/demo/state");
    const opened: string[] = [];
    let state: "Running" | "Stopped" = "Stopped";
    const registry = api.createSourceRegistry({ home, wsl: {
      list: async () => [{ name: "TestDistro", state, version: 2, isDefault: true }],
      open: async (path: string) => {
        opened.push(path);
        return remoteFs(root, path, process.platform === "win32" ? win32 : posix);
      },
    } });
    const input = { kind: "wsl" as const, family: "openclaw", distro: "TestDistro", path: "/home/demo/state" };
    await assert.rejects(registry.detect(input, owner));
    assert.equal(opened.length, 0);
    state = "Running";
    const result = await registry.detect(input, owner);
    assert.equal(opened.length, 1);
    assert.ok(opened[0]!.replaceAll("\\", "/").startsWith("//wsl.localhost/TestDistro/"));
    assert.equal(result.agents[0]?.hasPersona, true);
    const saved = await registry.get(result.sourceId, owner);
    assert.equal(saved.metadata.origin, "wsl:TestDistro");
    assert.equal(saved.metadata.flavour, "posix");
  });

  it("discovers WSL homes as POSIX descriptors and retains the original UNC authority when a candidate is selected", async () => {
    const api = await factory();
    const root = temp();
    const home = temp();
    const state = join(root, "alice", ".hermes");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.yaml"), "_config_version: 45\n");
    mkdirSync(join(root, "alice", ".plur1bus", "state", "lancedb"), { recursive: true });
    const opened: string[] = [];
    const registry = api.createSourceRegistry({ home, wsl: {
      list: async () => [{ name: "TestDistro", state: "Running", version: 2, isDefault: true }],
      open: async path => { opened.push(path); return remoteFs(root, path, process.platform === "win32" ? win32 : posix); },
    } });
    const discovery = await registry.discover({ kind: "wsl", family: "openclaw", distro: "TestDistro", path: "/home" }, owner);
    assert.equal(discovery.candidates.length, 1);
    const candidate = discovery.candidates[0]!;
    assert.equal(candidate.source.kind, "wsl");
    assert.equal((candidate.source as { path: string }).path, "/home/alice/.hermes");
    assert.equal(discovery.stores?.[0]?.path, "/home/alice/.plur1bus/state/lancedb");
    assert.equal(discovery.stores?.[0]?.candidateId, candidate.id);
    const detected = await registry.detect(candidate.source, owner);
    assert.equal(detected.sourceType, "hermes");
    assert.equal(opened.length, 2);
    assert.equal(opened[1], opened[0], "candidate selection cannot redefine the previously approved filesystem authority");
  });

  it("auto-discovers readable known user homes through one private native root and grants Admin only exact choices", async () => {
    const api = await factory();
    const root = temp();
    const home = temp();
    const authority = parse(root).root;
    const virtual = (...parts: string[]) => join(authority, ...parts);
    const alice = join(root, "home", "alice", ".openclaw");
    source(alice, virtual("home", "alice", ".openclaw"));
    const bob = join(root, "home", "bob", ".hermes");
    mkdirSync(bob, { recursive: true });
    writeFileSync(join(bob, "config.yaml"), "_config_version: 45\n");
    mkdirSync(join(root, "home", "locked", ".hermes"), { recursive: true });
    writeFileSync(join(root, "home", "locked", ".hermes", "config.yaml"), "_config_version: 45\n");
    source(join(root, "unrelated", "deep", ".openclaw"), virtual("unrelated", "deep", ".openclaw"));
    const carol = join(root, "private", "Users", "carol", ".openclaw");
    source(carol, virtual("private", "Users", "carol", ".openclaw"));
    symlinkSync(join(root, "private", "Users"), join(root, "Users"), "junction");
    const current = join(root, "private", "var", "root", ".hermes");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "config.yaml"), "_config_version: 45\n");
    symlinkSync(join(root, "private", "var"), join(root, "var"), "junction");
    const store = join(root, "home", "alice", ".plur1bus", "state", "lancedb");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "SOUL.md"), "selected native store fixture");
    const opened: string[] = [];
    const listed: string[] = [];
    const P = process.platform === "win32" ? win32 : posix;
    let now = Date.now();
    const registry = api.createSourceRegistry({ home, now: () => now, localDiscovery: {
      home: virtual("var", "root"),
      open: async (path: string) => {
        opened.push(path);
        const fs = await remoteFs(root, authority, P);
        const check = (path: string) => {
          if (P.relative(authority, path).startsWith(["home", "locked", ""].join(P.sep))) {
            throw new RemoteFsError("permission-denied");
          }
        };
        return { ...fs, stat: async path => { check(path); return fs.stat(path); },
          readdir: async path => { check(path); listed.push(path); return fs.readdir(path); } };
      },
    } });
    const admin = { ...owner, role: "admin" as const };
    const sourceSecrets = createImportSourceSecrets();
    const service = createImportService({ home, sources: registry, sourceSecrets, audit: memoryAuditSink(),
      config: { get: async () => ({ config: {}, revision: "fixture" }), set: async () => ({ revision: "fixture" }) },
      target: async () => { throw new Error("discovery must not inspect or mutate the import target"); },
      store: async () => ({ supported: false }), model: async () => ({ present: false, licenceAccepted: false }),
      secrets: { status: async () => ({ backend: "none", degraded: true, keyring: { available: false },
        file: { enabled: false, available: false }, count: 0, activeLeases: 0, secrets: [] }) },
    });
    const priorDefault = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = join(temp(), "missing-family-default");
    try {
      const found = await service.discover({ kind: "auto", family: "openclaw" }, admin);
      assert.deepEqual(validateResult("admin.import.detect", found), { ok: true });
      assert.deepEqual(found.candidates.map(candidate => "path" in candidate.source ? candidate.source.path : "").sort(), [
        virtual("home", "alice", ".openclaw"), virtual("home", "bob", ".hermes"),
        virtual("private", "Users", "carol", ".openclaw"), virtual("private", "var", "root", ".hermes"),
      ].sort());
      assert.equal(found.stores?.length, 1);
      assert.ok(!listed.some(path => P.relative(authority, path).startsWith("unrelated")), "known locations only, never a full scan");
      assert.ok(!JSON.stringify(found).includes(MARKER));
      for (const candidate of found.candidates) {
        assert.equal(registry.approves(candidate.source, admin), true);
        assert.equal(registry.approves(candidate.source, { ...admin, userId: "other-admin" }), false);
        const selected = await service.detect(candidate.source, admin);
        assert.equal(selected.sourceType, candidate.source.family);
        await assert.rejects(service.detect(candidate.source, { ...admin, userId: "other-admin" }));
      }
      const selected = found.candidates.find(candidate => candidate.source.family === "openclaw")!;
      const altered = { ...selected.source, kind: "path" as const, path: virtual("unrelated", "deep", ".openclaw") };
      assert.equal(registry.approves(altered, admin), false);
      await assert.rejects(service.detect(altered, admin));
      const detected = await service.detect(selected.source, admin);
      const maps = [{ from: "/external-store", to: `store:${found.stores![0]!.id}` }];
      assert.equal(registry.approvesMaps(maps, admin), true);
      const mapped = await registry.map(detected.sourceId, maps, admin);
      assert.equal(readFileSync(join(mapped.maps[0]!.to, "SOUL.md"), "utf8"), "selected native store fixture");
      assert.ok(opened.length > 4 && opened.every(path => path === authority), "selection/store reads keep the original OS authority");
      await assert.rejects(service.detect({ kind: "auto", family: "openclaw" }, admin));
      assert.ok(opened.every(path => path === authority), "ordinary auto detection does not acquire discovery authority");
      assert.equal(validateParams("admin.import.detect", { source: { kind: "auto", family: "openclaw", root: authority } }).ok, false);
      now += 24 * 60 * 60 * 1000 + 1;
      assert.equal(registry.approves(selected.source, admin), false);
      assert.equal(registry.approvesMaps(maps, admin), false);
    } finally {
      if (priorDefault === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = priorDefault;
      service.close();
    }
  });

  it("discovers the Windows home drive through a virtual six-method port without treating POSIX known paths as another drive", async () => {
    const api = await factory();
    const directories = ["D:\\", "D:\\Users", "D:\\Users\\alice", "D:\\Users\\alice\\.openclaw",
      "D:\\Users\\bob", "D:\\Users\\bob\\AppData", "D:\\Users\\bob\\AppData\\Local",
      "D:\\Users\\bob\\AppData\\Local\\hermes"];
    const files = ["D:\\Users\\alice\\.openclaw\\openclaw.json", "D:\\Users\\bob\\AppData\\Local\\hermes\\config.yaml"];
    const entries = new Map([...directories.map(path => [path, "directory"] as const), ...files.map(path => [path, "file"] as const)]);
    const touched: string[] = [];
    const canonical = (path: string) => {
      const selected = win32.resolve("D:\\", path);
      touched.push(selected);
      if (!entries.has(selected)) throw new RemoteFsError("not-found");
      return selected;
    };
    const fs: ReadonlyFs = {
      stat: async path => ({ type: entries.get(canonical(path))!, size: 0 }),
      lstat: async path => ({ type: entries.get(canonical(path))!, size: 0 }),
      realpath: async path => canonical(path),
      readdir: async path => {
        const parent = canonical(path);
        return [...entries.keys()].filter(child => child !== parent && win32.dirname(child) === parent).map(child => win32.basename(child));
      },
      readFile: async () => { throw new Error("discovery must not read source contents"); },
      readlink: async () => { throw new Error("fixture has no symlinks"); },
    };
    const opened: string[] = [];
    const registry = api.createSourceRegistry({ home: temp(), localDiscovery: { home: "D:\\Users\\caller",
      open: async path => { opened.push(path); return fs; } } });
    const found = await registry.discover({ kind: "auto", family: "hermes" }, owner);
    assert.deepEqual(found.candidates.map(candidate => candidate.source).sort((a, b) => a.family.localeCompare(b.family)), [
      { kind: "path", family: "hermes", path: "D:\\Users\\bob\\AppData\\Local\\hermes" },
      { kind: "path", family: "openclaw", path: "D:\\Users\\alice\\.openclaw" },
    ]);
    assert.deepEqual(opened, ["D:\\"]);
    assert.ok(touched.every(path => path.startsWith("D:\\")));
    assert.ok(found.candidates.every(candidate => registry.approves(candidate.source, owner)));
  });

  it("characterization: ordinary auto detection retains each family default without opening discovery authority", async () => {
    const api = await factory();
    for (const family of ["openclaw", "hermes"] as const) {
      const root = temp();
      if (family === "openclaw") source(root);
      else writeFileSync(join(root, "config.yaml"), "_config_version: 45\n");
      const name = family === "openclaw" ? "OPENCLAW_STATE_DIR" : "HERMES_HOME";
      const previous = process.env[name];
      process.env[name] = root;
      const registry = api.createSourceRegistry({ home: temp(), localDiscovery: { home: parse(root).root,
        open: async () => { throw new Error("ordinary auto detection must not open discovery authority"); } } });
      try {
        const detected = await registry.detect({ kind: "auto", family }, owner);
        assert.equal(detected.sourceType, family);
        assert.equal((await registry.get(detected.sourceId, owner)).record.selection.kind, "auto");
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  });
});
