/** Core shutdown may remove the credential file; only the successful run's narrowly bound native operations retain it. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectOptions, CoreClient } from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";

const runId = "12345678-1234-4123-8123-123456789012",
  planId = "12345678-1234-4123-8123-123456789013";
const principal = { userId: "alice", role: "owner", kind: "person" } as const;
function fixture(t: import("node:test").TestContext, delayedClose = false) {
  const home = mkdtempSync(join(tmpdir(), "import-run-credential-"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  const path = join(home, "run", "api-delegation.token"),
    token = "a".repeat(64);
  writeFileSync(path, token, { mode: 0o600 });
  writeFileSync(join(home, "run", "supervisor.token"), "b".repeat(64), { mode: 0o600 });
  writeFileSync(join(home, "run", "core.token"), "b".repeat(64), { mode: 0o600 });
  let now = 1000,
    state = "applying",
    denied = false;
  const opened: ConnectOptions[] = [],
    called: string[] = [],
    drops: (() => void)[] = [],
    closing: (() => void)[] = [];
  const connect = async (options: ConnectOptions): Promise<CoreClient> => {
    opened.push(options);
    const handlers = new Set<() => void>();
    const drop = () => {
      for (const handler of [...handlers]) handler();
    };
    drops.push(drop);
    return {
      hello: { pid: process.pid, rpc: "1.7.0", instanceId: "fixture" },
      supports: () => true,
      onClose: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      onNotification: () => () => {},
      close: async () => {
        if (delayedClose) closing.push(drop);
        else drop();
      },
      call: async <T>(method: string) => {
        called.push(method);
        if (method === "admin.import.apply") {
          unlinkSync(path);
          return { runId, state: "queued" } as T;
        }
        if (denied) throw { error: "E_DENIED", reason: "native-proof" };
        if (method === "admin.import.status")
          return {
            run: {
              runId,
              planId,
              sourceType: "fixture",
              state,
              attempt: 1,
              createdAt: "2026-10-29T00:00:00Z",
              updatedAt: "2026-10-29T00:00:00Z",
              restored: false,
              resumable: false,
              rollbackAvailable: false,
            },
          } as T;
        if (method === "admin.import.abort") return { runId, accepted: true, state: "rolling-back" } as T;
        return { ok: true } as T;
      },
    };
  };
  const link = createCoreLink(home, { connect, now: () => now });
  t.after(async () => {
    await link.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    link,
    path,
    token,
    opened,
    called,
    drops,
    closeRetired: () => {
      for (const close of closing.splice(0)) close();
    },
    advance: (ms: number) => {
      now += ms;
    },
    finish: () => {
      state = "completed";
    },
    deny: () => {
      denied = true;
    },
    allow: () => {
      denied = false;
    },
  };
}
test("actual credential-file deletion preserves only the successful person/connection/run's status, abort and progress", async (t) => {
  const f = fixture(t);
  await f.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie-one");
  assert.equal(
    (
      await f.link.callAs!<{ run: { runId: string } }>(
        "admin.import.status",
        { runId },
        principal,
        "supervisor",
        "cookie-one",
      )
    ).run.runId,
    runId,
  );
  for (const [method, params, who, connection] of [
    ["config.set", {}, principal, "cookie-one"],
    ["admin.import.apply", { planId, preflightId: planId }, principal, "cookie-one"],
    ["admin.import.status", { runId }, { ...principal, userId: "other" }, "cookie-one"],
    ["admin.import.status", { runId }, { ...principal, kind: "agent" }, "cookie-one"],
    ["admin.import.status", { runId }, principal, "cookie-two"],
    ["admin.import.status", { runId: planId }, principal, "cookie-one"],
  ] as const)
    await assert.rejects(f.link.callAs!(method, params, who, "supervisor", connection));
  const off = await f.link.subscribeImportAs!(
    principal,
    runId,
    () => {},
    () => {},
    "cookie-one",
  );
  off();
  assert.equal(f.opened.length, 2);
  assert.equal(f.opened[1]!.api?.token, f.token);
  await f.link.callAs!("admin.import.abort", { runId }, principal, "supervisor", "cookie-one");
  f.finish();
  await f.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie-one");
  await assert.rejects(f.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie-one"));
  assert.ok(!f.called.includes("config.set"));
});

test("a retired progress connection closing after reconnect cannot revoke its replacement's active-run proof", async (t) => {
  const f = fixture(t, true);
  await f.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  const first = await f.link.subscribeImportAs!(
    principal,
    runId,
    () => {},
    () => {},
    "cookie",
  );
  first();
  const second = await f.link.subscribeImportAs!(
    principal,
    runId,
    () => {},
    () => {},
    "cookie",
  );
  f.closeRetired();
  await f.link.callAs!("admin.import.abort", { runId }, principal, "supervisor", "cookie");
  second();
});
test("expiry, native proof refusal and fresh Core credential rotation cannot revive old run credentials", async (t) => {
  const expired = fixture(t);
  await expired.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  expired.advance(4500000);
  await assert.rejects(expired.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
  const denied = fixture(t);
  await denied.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  denied.deny();
  await assert.rejects(denied.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
  assert.equal(denied.opened.length, 1);
  denied.allow();
  await assert.rejects(denied.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
  const closed = fixture(t);
  await closed.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  closed.drops[0]!();
  await assert.rejects(closed.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
  const rotated = fixture(t);
  await rotated.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  writeFileSync(rotated.path, "c".repeat(64), { mode: 0o600 });
  await rotated.link.callAs!("config.set", {}, principal, "supervisor", "cookie");
  assert.equal(rotated.opened.at(-1)!.api?.token, "c".repeat(64));
  unlinkSync(rotated.path);
  await assert.rejects(rotated.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
  const service = fixture(t);
  await service.link.callAs!("admin.import.apply", { planId, preflightId: planId }, principal, "supervisor", "cookie");
  writeFileSync(service.path, "d".repeat(64), { mode: 0o600 });
  await service.link.serviceCall!("admin.api.person.resolve", { userId: "alice" });
  unlinkSync(service.path);
  await assert.rejects(service.link.callAs!("admin.import.status", { runId }, principal, "supervisor", "cookie"));
});
