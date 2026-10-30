import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeOrigin } from "../src/models/origin-input.ts";
import { pairingErrors, pairingFailure, transition } from "../src/models/pairing-model.ts";
import * as pairing from "../src/models/pairing-model.ts";
test("pairing accepts complete current API codes while preserving an eight-character offer", () => {
    const code = (pairing as any).pairingCode;
    assert.equal(typeof code, "function");
    assert.equal(code("ABCD", "1234", ""), "ABCD-1234");
    assert.equal(code("", "", "c".repeat(43)), "c".repeat(43));
    assert.equal(code("ABCD", "1234", "bad"), null);
    assert.equal(code("", "", "c".repeat(43) + "\n"), null);
});
test("origin-input consumes the exact Rust case table", async () => {
    const cases = JSON.parse(await readFile(new URL("../../src-tauri/tests/fixtures/origin-cases.json", import.meta.url), "utf8"));
    for (const c of cases)
        assert.equal(normalizeOrigin(c.input), c.normalized, c.input);
});
test("pairing-model maps every reachable error and requires start before success", () => {
    for (const error of pairingErrors) {
        const state = pairingFailure(error);
        assert.equal(state.error, error);
        assert.ok(["code", "repair", "retry"].includes(state.retry));
    }
    assert.equal(pairingFailure("denied").retry, "code");
    assert.equal(pairingFailure("revoked").retry, "repair");
    assert.equal(transition({ phase: "idle" }, "success").phase, "idle");
    assert.equal(transition({ phase: "pairing" }, "success").phase, "paired");
});

test("incompatible failures show only bounded public API versions", () => {
    assert.deepEqual(pairingFailure("incompatible:2.3.4:1.0.0").versions, { server: "2.3.4", client: "1.0.0" });
    assert.equal(pairingFailure("incompatible:arbitrary payload:1.0.0").versions, undefined);
    assert.equal(pairingFailure("trust-unavailable").retry, "retry");
});
