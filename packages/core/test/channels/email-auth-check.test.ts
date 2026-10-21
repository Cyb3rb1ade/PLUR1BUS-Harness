import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { emailAuthChecks } from "../../src/channels/email-auth-check.ts";

const cfg = (patch: Record<string, unknown>) => { const c = defaults() as unknown as { channels: { email: Record<string, unknown> } }; Object.assign(c.channels.email, patch); return c; };

test("doctor: an enabled e-mail channel without requireAuthPass is a warning that names the setting", () => {
  const [c, ...rest] = emailAuthChecks(cfg({ enabled: true }));
  assert.equal(rest.length, 0);
  assert.equal(c!.id, "channels.email.auth");
  assert.equal(c!.status, "warn");
  assert.match(c!.summary, /requireAuthPass/);
  assert.match(c!.repair!.label, /authServId/);
});

test("doctor: requireAuthPass on is ok; a disabled e-mail channel reports nothing", () => {
  assert.deepEqual(emailAuthChecks(cfg({ enabled: true, requireAuthPass: true })).map((c) => c.status), ["ok"]);
  assert.deepEqual(emailAuthChecks(cfg({ enabled: false })), []);
  assert.deepEqual(emailAuthChecks(defaults()), []);
  assert.deepEqual(emailAuthChecks(null), []);
});
