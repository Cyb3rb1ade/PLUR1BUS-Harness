import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeOrigin } from "../src/models/origin-input.ts";
import { pairingErrors, pairingFailure, transition } from "../src/models/pairing-model.ts";
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
