// Settings > Users & roles: the role preset texts (en and de) restate docs/rbac.md in plain language. The policy table
// (packages/core/src/rbac/policy.ts, the source of the docs table) decides: a line that says a role "can" do something it is
// denied, or "cannot" do something it holds, fails here. Logs and the audit trail are `logs.query` / `audit.read`, Owner and
// Admin only (narrower than `logs.read`, which only opens the Sessions tab for Operator and Viewer).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { POLICY } from "../../core/src/rbac/policy.ts";
import { de, en } from "../src/i18n/users.ts";

type Role = "owner" | "admin" | "operator" | "member" | "viewer";
const ROLES: readonly Role[] = ["owner", "admin", "operator", "member", "viewer"];
const holds = (role: Role, action: string): boolean => (POLICY.find((s) => s.action === action)?.grants[role]?.length ?? 0) > 0;

type Term = { re: RegExp; action: string };
// Words a preset line uses for something the policy table gates by one action. A "can" line naming the word needs the action;
// a "cannot" line naming the word needs its absence.
const TERMS: Record<"en" | "de", readonly Term[]> = {
  en: [
    { re: /\blogs?\b/i, action: "logs.query" }, { re: /\baudit\b/i, action: "audit.read" },
    { re: /\bsessions\b/i, action: "sessions.read" }, { re: /\bdoctor\b/i, action: "doctor.run" },
    { re: /\breveal\b/i, action: "secrets.reveal" },
  ],
  de: [
    { re: /\bLogs?\b/, action: "logs.query" }, { re: /\bAudit/, action: "audit.read" },
    { re: /\bSitzungen\b/, action: "sessions.read" }, { re: /\bDoctor\b/, action: "doctor.run" },
    { re: /\bGeheimnisse anzeigen\b/, action: "secrets.reveal" },
  ],
};
// `sessions` and `doctor` in a "cannot" line are not asserted: the sentence may deny something else in the same line.
const NEGATIVE_OK = new Set(["logs.query", "audit.read"]);

for (const [lang, cat] of [["en", en], ["de", de]] as const) {
  describe(`users presets (${lang}) agree with the RBAC policy table`, () => {
    for (const role of ROLES) {
      test(role, () => {
        for (const n of [1, 2, 3]) {
          const can = cat[`users.preset.${role}.can${n}` as keyof typeof en];
          for (const t of TERMS[lang]) if (t.re.test(can)) assert.ok(holds(role, t.action), `${lang}/${role}: "${can}" names ${t.action}, which ${role} does not hold`);
        }
        for (const n of [1, 2]) {
          const not = cat[`users.preset.${role}.not${n}` as keyof typeof en];
          for (const t of TERMS[lang]) if (NEGATIVE_OK.has(t.action) && t.re.test(not)) assert.ok(!holds(role, t.action), `${lang}/${role}: "${not}" denies ${t.action}, which ${role} holds`);
        }
      });
    }
    test("Logs and the audit trail are said to be readable by exactly the roles that hold logs.query and audit.read", () => {
      for (const t of TERMS[lang].filter((x) => NEGATIVE_OK.has(x.action))) {
        for (const role of ROLES) {
          const lines = [1, 2, 3].map((n) => cat[`users.preset.${role}.can${n}` as keyof typeof en]);
          if (holds(role, t.action)) // The Owner's first line is "Everything an Admin can do", which covers logs and the audit trail.
          assert.ok(lines.some((l) => t.re.test(l)) || role === "owner", `${lang}/${role} holds ${t.action} but no "can" line says so`);
        }
      }
    });
  });
}

describe("users presets: the stale 'assigning roles is not available' text is gone", () => {
  test("neither catalogue has users.presets.unavailable", () => {
    assert.ok(!("users.presets.unavailable" in en));
    assert.ok(!("users.presets.unavailable" in de));
  });
});
