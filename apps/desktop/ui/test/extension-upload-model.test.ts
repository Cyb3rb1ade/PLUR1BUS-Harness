import { test } from "node:test";
import assert from "node:assert/strict";
import * as upload from "../src/models/extension-upload.ts";

test("file offers require an explicit review and a connection choice when multiple origins exist", async () => {
    assert.equal(typeof (upload as any).createExtensionUpload, "function");
    const calls: unknown[] = [];
    const model = (upload as any).createExtensionUpload(17);
    model.connections([{ id: "a", origin: "https://one.example" }, { id: "b", origin: "https://two.example" }]);
    assert.equal(model.selected, null);
    assert.equal(await model.review(async (request: unknown) => { calls.push(request); }), false);
    assert.equal(calls.length, 0);
    model.choose("b");
    assert.equal(await model.review(async (request: unknown) => { calls.push(request); }), true);
    assert.deepEqual(calls, [{ linkId: 17, connectionId: "b" }]);
    assert.equal(model.done, true);
});

test("one connection is selected but never uploaded until review, and duplicate submissions stay bounded", async () => {
    assert.equal(typeof (upload as any).createExtensionUpload, "function");
    const model = (upload as any).createExtensionUpload(18);
    model.connections([{ id: "a", origin: "https://one.example" }]);
    assert.equal(model.selected, "a");
    assert.equal(model.done, false);
    let complete!: () => void;
    const first = model.review(() => new Promise<void>(resolve => { complete = resolve; }));
    assert.equal(await model.review(async () => assert.fail("duplicate upload")), false);
    complete(); await first;
    assert.equal(model.done, true);
});
