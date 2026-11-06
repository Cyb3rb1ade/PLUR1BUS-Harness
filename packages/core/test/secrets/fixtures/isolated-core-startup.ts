import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";

// The parent owns the watchdog so a synchronous block on this thread cannot stop its timer.
let sequence = 0;
function enter(op: string) {
  const id = ++sequence;
  process.send!({ event: "enter", op, id });
  return () => process.send!({ event: "leave", op, id });
}
async function watchStore<T>(op: string, operation: () => Promise<T>): Promise<T> {
  const leave = enter(op);
  try { return await operation(); }
  finally { leave(); }
}

process.send!({ event: "ready" });
// Imports and real Windows ACLs may be slow, but the Core thread must remain responsive.
const pulse = setInterval(() => process.send!({ event: "pulse" }), 250);
pulse.unref();
const { defaults } = await import("@plur1bus/config-schema");
const { flatTestInternals } = await import("../../helpers/flat-embedder.ts");
const { createFileBackend } = await import("../../../src/secrets/file-backend.ts");
const { layout } = await import("../../../src/paths.ts");
const { secure } = await import("../helpers.ts");
const [mode, home] = process.argv.slice(2);
assert.ok(mode && home, "fixture requires mode and a parent-owned home");
const timedOut = ["default", "injected", "file-hang", "stop-starting", "blocked-control"].includes(mode);
const secret = randomUUID();
let sourceEntered!: () => void, releaseSource!: () => void;
const sourceReady = new Promise<void>(resolve => { sourceEntered = resolve; });
const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
const config = defaults();
config.agents.main = {};
config.models.scan.enabled = false;
config.secrets.fileFallback.enabled = mode !== "test-internals";
config.engine = { neo: { enabled: false }, gc: { enabled: false }, dreaming: { enabled: false },
  skillMiner: { enabled: false }, reranker: { enabled: false }, merging: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, obsidianBridge: { enabled: false } };
writeFileSync(join(home, "config.json"), JSON.stringify(config));
await watchStore("seed", () => createFileBackend({ dir: layout(home).secrets, secure }).put("startup.only", secret, new Date()));
const configSource = await import("../../../src/config-source.ts");
mock.module(new URL("../../../src/config-source.ts", import.meta.url).href, { namedExports: {
  ...configSource,
  async openConfigSource(options: Parameters<typeof configSource.openConfigSource>[0]) {
    options.logger?.warn(`unsafe queued message ${secret}`, { ordinary: secret });
    const source = await configSource.openConfigSource(options);
    if (mode === "stop-before-store") { sourceEntered(); await sourceGate; }
    return source;
  },
} });
// Before isolation existed, the same fake reached the synchronous native call on Core's own thread.
const keyring = await import("../../../src/secrets/keyring-backend.ts");
mock.module(new URL("../../../src/secrets/keyring-backend.ts", import.meta.url).href, { namedExports: {
  ...keyring,
  createKeyringBackend(options: Parameters<typeof keyring.createKeyringBackend>[0]) {
    if (options.load) return keyring.createKeyringBackend(options);
    return keyring.createKeyringBackend({ ...options, load: async () => ({ Entry: class {
      getPassword(): string | null {
        process.stdout.write("synchronous-keyring-entered\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return null;
      }
      setPassword() {}
      deletePassword() { return false; }
    } }) });
  },
} });
const children: ChildProcess[] = [];
let nativeRequested = false;
let entered!: () => void;
const ioEntered = new Promise<void>(resolve => { entered = resolve; });
const runtime = await import("../../../src/secrets/runtime.ts");
let store: ReturnType<typeof runtime.createCoreSecretStore>;
let startupLogger: Parameters<typeof runtime.createCoreSecretStore>[0]["logger"];
mock.module(new URL("../../../src/secrets/runtime.ts", import.meta.url).href, { namedExports: {
  ...runtime,
  createCoreSecretStore(options: Parameters<typeof runtime.createCoreSecretStore>[0]) {
    startupLogger = options.logger;
    const keepEnvironment = mode === "test-internals" || mode === "file-hang" || mode.startsWith("ungated-");
    const leave = enter("construct");
    try {
      store = runtime.createCoreSecretStore({ ...options, ...(keepEnvironment ? {} : { env: {} }), isolation: {
        budgetMs: timedOut ? 700 : 3000, retryAfterMs: 60_000,
        spawn(description) {
          assert.notEqual(mode, "test-internals", "the trusted Core test seam attempted persistent I/O");
          if (description.kind === "keyring") nativeRequested = true;
          const fixture = mode === "file-hang" ? "./isolated-file-hang.ts"
            : timedOut ? "./isolated-keyring.ts" : "./isolated-memory-keyring.ts";
          const child = fork(fileURLToPath(new URL(fixture, import.meta.url)), [], {
            execArgv: ["--experimental-strip-types", "--conditions=source"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
          });
          children.push(child);
          process.send!({ event: "helper", pid: child.pid });
          child.on("message", message => {
            if ((message as { entered?: boolean }).entered) {
              process.stdout.write("synchronous-keyring-entered\n");
              setTimeout(() => process.stdout.write("core-heartbeat\n"), 0);
              entered();
              if (mode === "blocked-control") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
          });
          return child;
        },
      } } as Parameters<typeof runtime.createCoreSecretStore>[0]);
    } finally { leave(); }
    store = new Proxy(store, {
      get(target, name, receiver) {
        const member: unknown = Reflect.get(target, name, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const finish = enter(String(name));
          try {
            const result: unknown = Reflect.apply(member, target, args);
            if (result instanceof Promise) return result.finally(finish);
            finish();
            return result;
          } catch (error) { finish(); throw error; }
        };
      },
    });
    return store;
  },
} });
const bootstrap = await import("../../../src/logs/bootstrap.ts");
mock.module(new URL("../../../src/logs/bootstrap.ts", import.meta.url).href, { namedExports: {
  ...bootstrap,
  createCoreLog(options: Parameters<typeof bootstrap.createCoreLog>[0]) {
    if (timedOut) startupLogger?.warn(`late unsafe queued message ${secret}`, { ordinary: secret });
    return bootstrap.createCoreLog(options);
  },
} });
const { createCore } = await import("../../../src/core.ts");
mkdirSync(join(home, "logs"), { recursive: true });
const provided = mode === "injected" ? bootstrap.createCoreLog({ dir: join(home, "logs"), role: "core",
  source: { kind: "harness", id: "core", version: "0.1.0" }, timers: false }) : undefined;
const core = createCore({ home, ...(mode === "production" ? {} : { testInternals: flatTestInternals() }),
  ...(provided ? { logger: provided } : {}),
  ...(mode === "acl-refused" ? { securePathOptions: { platform: "win32" as const, execFile() { throw Error("ACL tool refused"); } } } : {}),
  ...(["production", "failed-composition"].includes(mode) ? { inspectHost() { throw Error("controlled composition refusal"); } } : {}),
});
const stop = () => watchStore("shutdown", () => core.stop({ budgetMs: 2000 }));
try {
  if (mode === "stop-before-store") {
    const rejected = assert.rejects(core.start(), /core stopping/);
    await sourceReady;
    await stop();
    releaseSource();
    await rejected;
    assert.equal(children.length, 0, "an already stopped Core started a secret backend helper");
    process.stdout.write("startup-refusal-cleaned\n");
  } else if (mode.startsWith("ungated-")) {
    await assert.rejects(core.start(), /PLUR1BUS_SECRETS_KEYRING requires PLUR1BUS_ALLOW_TEST_INTERNALS=1/);
    assert.equal(children.length, 0);
    process.stdout.write("startup-refusal-cleaned\n");
  } else if (mode === "stop-starting") {
    const rejected = assert.rejects(core.start(), /core stopping/);
    await ioEntered;
    await stop();
    await rejected;
    for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null, "stop during startup left a helper alive");
    process.stdout.write("startup-refusal-cleaned\n");
  } else if (["acl-refused", "production", "failed-composition"].includes(mode)) {
    await assert.rejects(core.start(), mode === "acl-refused" ? /refusing to start: the access control list of run/ : /controlled composition refusal/);
    assert.ok(nativeRequested, "production did not select the isolated native backend");
    assert.ok(children.length > 0);
    for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null, "rejected startup left a helper alive");
    process.stdout.write("startup-refusal-cleaned\n");
  } else if (mode === "test-internals") {
    await core.start();
    assert.equal((await store!.status({ kind: "core" })).backend, "keyring");
    assert.equal(children.length, 0);
    process.stdout.write("test-internals-memory\n");
  } else {
    await core.start();
    const status = await store!.status({ kind: "core" });
    assert.equal(status.backend, "none");
    assert.equal(status.count, null);
    assert.equal(status.activeLeases, 0);
    const unavailable = (error: unknown) => (error as { code?: string }).code === "backend-unavailable";
    await assert.rejects(store!.reveal({ kind: "owner" }, "startup.only"), unavailable);
    await assert.rejects(store!.lease({ kind: "core" }, "startup.only", { purpose: "test", profileId: "test" }), unavailable);
    assert.ok(["ready", "degraded"].includes(core.status().process.state));
    await stop();
    if (provided) await watchStore("log-close", () => provided.close());
    const text = readdirSync(join(home, "logs")).filter(name => name.endsWith(".log"))
      .map(name => readFileSync(join(home, "logs", name), "utf8")).join("\n");
    assert.ok(text.includes("Secret-Store unavailable"));
    assert.ok(!text.includes(secret), "an unread Store value escaped through queued startup diagnostics");
    assert.ok(!text.includes("unsafe queued message"), "unsafe startup diagnostics were replayed after timeout");
    assert.ok(children.length > 0);
    for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null, "a blocked helper survived Core stop");
  }
} finally {
  await stop();
  if (provided) await watchStore("log-close", () => provided.close());
  clearInterval(pulse);
  for (const child of children) child.kill("SIGKILL");
}
