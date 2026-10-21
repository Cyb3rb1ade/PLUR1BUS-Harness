import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { catalogues, t, type Key } from "../src/i18n.ts";
import { AREAS, registerArea } from "../src/i18n/index.ts";
import * as audit from "../src/i18n/audit.ts";
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
import * as projects from "../src/i18n/projects.ts";
import * as providers from "../src/i18n/providers.ts";
import * as recurring from "../src/i18n/recurring.ts";
import * as secrets from "../src/i18n/secrets.ts";
import * as sessions from "../src/i18n/sessions.ts";
import * as setup from "../src/i18n/setup.ts";
import * as switchboard from "../src/i18n/switchboard.ts";
import * as voice from "../src/i18n/voice.ts";
import * as users from "../src/i18n/users.ts";
import * as inbox from "../src/i18n/inbox.ts";
import * as breakglass from "../src/i18n/breakglass.ts";
import * as modules from "../src/i18n/modules.ts";

// The lazy areas register as their page chunk loads; load them here so every check below covers them too.
registerArea("chat", chat);
registerArea("projects", projects);
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
registerArea("audit", audit);
registerArea("sessions", sessions);
registerArea("approvals", approvals);
registerArea("voice", voice);
registerArea("extensions", extensions);
registerArea("recurring", recurring);
registerArea("inbox", inbox);
registerArea("breakglass", breakglass);
registerArea("modules", modules);

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

test("i18n areas: core plus the page areas are registered", () => {
  assert.deepEqual(AREAS.map((a) => a.name), [
    "surfaces", "core", "chat", "projects", "memory", "mediasearch", "models", "budget", "doctor", "palette",
    "shared", "setup", "agents", "settings", "users", "providers", "secrets", "switchboard", "devices", "logs", "activity", "audit", "sessions", "approvals", "voice", "extensions", "recurring", "inbox", "breakglass", "modules",
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

// German text addresses the person with "du" throughout (owner decision, like docs/user/de), and does not gender. "Sie" that means a thing
// or "they" ("Sie gilt nur für diese Freigabe") is correct German and not matched: only the forms of the polite address are.
const FORMAL_ADDRESS = [
  /\b\p{L}+(?:en|et|ten) Sie\b/u, // "Wählen Sie", "Sind Sie", "versuchen Sie", "Haben Sie"
  /\b(?:wenn|dass|ob|falls|sobald|bevor|damit|weil|wie|bitte) Sie\b/u,
  /\b(?:an|für|bei|mit|von|zu|auf|über|um|nach|vor|ohne|durch|gegen|aus) Sie\b/u,
  /\bIh(?:r|re|ren|rem|rer|res|nen)\b/u, // "Ihr Konto", "Ihnen"
  /(?:^|[.!?:;] )Sie (?:müssen|besitzen|möchten|sollten|dürfen|benötigen|haben|sind)\b/u, // "Sie müssen ... bestätigen."
];
const GENDERING = /\p{L}[:*_/]in(?:nen)?\b|\((?:in|innen)\)|\p{Ll}Innen\b|\p{Ll}-innen\b/u;

test("i18n: German text uses du, never the polite Sie, and does not gender", async () => {
  const dir = new URL("../src/i18n/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  assert.ok(files.length >= 30, "the catalogue files are found");
  for (const file of files) {
    const de = ((await import(new URL(file, dir).href)) as { de: Record<string, string> }).de;
    for (const [k, v] of Object.entries(de)) {
      for (const re of FORMAL_ADDRESS) assert.ok(!re.test(v), `${file}: ${k} addresses the person with Sie: ${v}`);
      assert.ok(!GENDERING.test(v), `${file}: ${k} genders: ${v}`);
    }
  }
});
