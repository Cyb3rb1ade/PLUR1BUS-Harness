// Settings > Security: the numeric limits shown read-only. Whatever shape the running configuration has, the page shows a number
// or boolean, never an object, a string from the wire or NaN.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SECURITY_LIMITS, securityLimits } from "../src/pages/settings/security/limits.ts";

describe("securityLimits", () => {
  test("missing keys and a missing config give the defaults", () => {
    for (const cfg of [undefined, null, {}, { approvals: {}, breakglass: {} }, "x", 7, []]) assert.deepEqual(securityLimits(cfg), DEFAULT_SECURITY_LIMITS);
  });
  test("values of the wrong type fall back to the default", () => {
    const l = securityLimits({ approvals: { maxGrantDays: { a: 1 }, requireOsConfirmation: "no" }, breakglass: { reasonMinChars: "10; DROP", reasonMaxChars: Number.NaN, maxWindowMinutes: -5 } });
    assert.deepEqual(l, DEFAULT_SECURITY_LIMITS);
  });
  test("valid values pass through", () => {
    const cfg = { approvals: { maxGrantDays: 30, requireOsConfirmation: false }, breakglass: { reasonMinChars: 20, reasonMaxChars: 800, maxWindowMinutes: 15 } };
    assert.deepEqual(securityLimits(cfg), { maxGrantDays: 30, requireOsConfirmation: false, reasonMinChars: 20, reasonMaxChars: 800, maxWindowMinutes: 15 });
  });
});
