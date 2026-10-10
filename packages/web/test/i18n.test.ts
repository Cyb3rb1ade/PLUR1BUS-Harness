import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogues, t, type Key } from "../src/i18n.ts";
import { AREAS, registerArea } from "../src/i18n/index.ts";
import * as activity from "../src/i18n/activity.ts";
import * as agents from "../src/i18n/agents.ts";
import * as approvals from "../src/i18n/approvals.ts";
import * as budget from "../src/i18n/budget.ts";
import * as chat from "../src/i18n/chat.ts";
import * as devices from "../src/i18n/devices.ts";
import * as doctor from "../src/i18n/doctor.ts";
import * as extensions from "../src/i18n/extensions.ts";
import * as logs from "../src/i18n/logs.ts";
import * as memory from "../src/i18n/memory.ts";
import * as providers from "../src/i18n/providers.ts";
import * as recurring from "../src/i18n/recurring.ts";
import * as secrets from "../src/i18n/secrets.ts";
import * as sessions from "../src/i18n/sessions.ts";
import * as setup from "../src/i18n/setup.ts";
import * as switchboard from "../src/i18n/switchboard.ts";
import * as voice from "../src/i18n/voice.ts";
import * as users from "../src/i18n/users.ts";

// The lazy areas register as their page chunk loads; load them here so every check below covers them too.
registerArea("chat", chat);
registerArea("budget", budget);
registerArea("doctor", doctor);
registerArea("setup", setup);
registerArea("agents", agents);
registerArea("users", users);
registerArea("providers", providers);
registerArea("secrets", secrets);
registerArea("switchboard", switchboard);
registerArea("devices", devices);
registerArea("logs", logs);
registerArea("activity", activity);
registerArea("sessions", sessions);
registerArea("approvals", approvals);
registerArea("voice", voice);
registerArea("extensions", extensions);
registerArea("recurring", recurring);

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

test("i18n areas: core plus the page areas are registered", () => {
  assert.deepEqual(AREAS.map((a) => a.name), [
    "surfaces", "core", "chat", "memory", "mediasearch", "models", "budget", "doctor", "palette",
    "shared", "setup", "agents", "settings", "users", "providers", "secrets", "switchboard", "devices", "logs", "activity", "sessions", "approvals", "voice", "extensions", "recurring",
  ]);
});

test("i18n: every area has the same keys in de and en, no empty text, matching placeholders", () => {
  for (const area of AREAS) {
    assert.deepEqual(Object.keys(area.de).sort(), Object.keys(area.en).sort(), `${area.name}: keys differ between de and en`);
    for (const [k, v] of Object.entries(area.en)) {
      const d = (area.de as Record<string, string>)[k]!;
      assert.ok(v.trim().length > 0, `en.${k} is empty`);
      assert.ok(d.trim().length > 0, `de.${k} is empty`);
      assert.deepEqual(placeholders(d), placeholders(v), `${area.name}: placeholders of ${k}`);
    }
  }
});

test("i18n: no key is defined by two areas, and the merged catalogues hold every key", () => {
  const seen = new Map<string, string>();
  for (const area of AREAS) {
    for (const k of Object.keys(area.en)) {
      assert.equal(seen.get(k), undefined, `${k} is defined in both ${seen.get(k)} and ${area.name}`);
      seen.set(k, area.name);
    }
  }
  assert.equal(Object.keys(catalogues.en).length, seen.size);
  assert.deepEqual(Object.keys(catalogues.de).sort(), Object.keys(catalogues.en).sort());
});

test("i18n: keys follow area.topic naming (lowercase dotted segments)", () => {
  for (const k of Object.keys(catalogues.en)) assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, k);
});

test("i18n: Key is strictly typed", () => {
  const ok: Key = "nav.models";
  assert.equal(t(ok), "Models");
  // @ts-expect-error unknown keys are compile errors
  const bad: Key = "no.such.key";
  assert.ok(bad);
});
