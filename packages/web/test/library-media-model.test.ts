import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  adaptersFor, buildParams, classifyFailure, classifyJobCode, editOperations, estimateUsd, eventJobId, generateKinds, isActive, paramProblem,
  paramSpecs, parseAdapters, parseJob, parseJobList, requestFromForm,
} from "../src/pages/library/media-model.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const raw = {
  adapters: [
    { id: "cloud", model: "m1", capabilities: { generate: true, edit: true, inpaint: true } },
    { id: "box", model: "m2", local: true, capabilities: { generate: true, edit: false, inpaint: false } },
    { id: "vid", model: "m3", capabilities: { generate: false, edit: false, inpaint: false,
      video: { textToVideo: true, imageToVideo: true, videoToVideo: false, durationSeconds: [2, 10], resolutions: ["720p", "1080p"], fps: [24, 30], audio: true } } },
    { model: "no id", capabilities: {} },
    "junk",
  ],
};

describe("adapters", () => {
  const adapters = parseAdapters(raw);
  test("malformed rows are dropped, locality defaults to cloud", () => {
    assert.deepEqual(adapters.map((a) => [a.id, a.local]), [["cloud", false], ["box", true], ["vid", false]]);
    assert.deepEqual(parseAdapters(null), []);
  });
  test("kinds and adapters per kind come from the advertised capabilities only", () => {
    assert.deepEqual(generateKinds(adapters), ["image", "video"]);
    assert.deepEqual(adaptersFor(adapters, "image").map((a) => a.id), ["cloud", "box"]);
    assert.deepEqual(adaptersFor(adapters, "video").map((a) => a.id), ["vid"]);
    assert.deepEqual(generateKinds(adapters.filter((a) => a.id === "box")), ["image"]);
  });
  test("edit operations are offered only when advertised", () => {
    const [cloud, box, vid] = adapters;
    assert.deepEqual(editOperations(cloud!, "image").map((o) => o.op), ["edit", "inpaint"]);
    assert.deepEqual(editOperations(box!, "image"), []);
    assert.deepEqual(editOperations(vid!, "image").map((o) => [o.op, o.kind]), [["imageToVideo", "video"]]);
    assert.deepEqual(editOperations(vid!, "video"), []);
    assert.deepEqual(editOperations(cloud!, "audio"), []);
  });
  test("video parameters are rendered from the advertised ranges and lists", () => {
    const specs = paramSpecs(adapters[2]!, "video");
    assert.deepEqual(specs.map((s) => s.key), ["durationSeconds", "resolution", "fps", "audio"]);
    assert.deepEqual(specs[0], { key: "durationSeconds", type: "number", min: 2, max: 10 });
    assert.equal(paramProblem(specs[0]!, { durationSeconds: "11" }), "range");
    assert.equal(paramProblem(specs[0]!, { durationSeconds: "5" }), null);
    assert.equal(paramProblem(specs[1]!, { resolution: "4k" }), "enum");
  });
  test("an adapter's own params replace the derived ones", () => {
    const [a] = parseAdapters({ adapters: [{ id: "x", capabilities: { generate: true, params: [
      { key: "style", type: "enum", options: ["a", "b"] }, { key: "bad key!", type: "int" }, { key: "level", type: "int", min: 1, max: 3, label: "Level" }, { key: "hd", type: "bool" },
    ] } }] });
    assert.deepEqual(paramSpecs(a!, "image").map((s) => s.key), ["style", "level", "hd"]);
  });
});

describe("request", () => {
  const [cloud, , vid] = parseAdapters(raw);
  test("only filled fields are sent and numbers are numbers", () => {
    const specs = paramSpecs(cloud!, "image");
    assert.deepEqual(requestFromForm(specs, { n: "2", "size.width": "512", "size.height": "768", seed: "", aspect: "16:9" }), { n: 2, size: { width: 512, height: 768 }, aspect: "16:9" });
    assert.deepEqual(requestFromForm(specs, { "size.width": "512" }), {});
    assert.equal(paramProblem(specs[1]!, { "size.width": "512" }), "range");
  });
  test("media.generate and media.edit params", () => {
    const specs = paramSpecs(vid!, "video");
    const g = buildParams({ operation: "generate", agentId: "main", adapter: "vid", kind: "video", prompt: " a fox ", negativePrompt: "x", specs, values: { durationSeconds: "4", fps: "24", audio: true } });
    assert.equal(g.method, "media.generate");
    assert.deepEqual(g.params, { agentId: "main", adapter: "vid", kind: "video", request: { prompt: "a fox", durationSeconds: 4, fps: 24, audio: true } });
    const e = buildParams({ operation: "edit", agentId: "main", adapter: "cloud", kind: "image", prompt: "snow", specs: [], values: {}, referenceId: ID, maskId: ID });
    assert.equal(e.method, "media.edit");
    assert.deepEqual(e.params, { agentId: "main", adapter: "cloud", kind: "image", request: { prompt: "snow", referenceIds: [ID], maskId: ID } });
  });
  test("the cost estimate is never invented", () => {
    const [priced] = parseAdapters({ adapters: [{ id: "p", pricing: { perImageUsd: 0.04, perVideoSecondUsd: 0.5 }, capabilities: { generate: true } }] });
    assert.equal(estimateUsd(priced!, "image", { n: "3" }), 0.04 * 3);
    assert.equal(estimateUsd(priced!, "image", {}), 0.04);
    assert.equal(estimateUsd(priced!, "video", { durationSeconds: "4" }), 2);
    assert.equal(estimateUsd(priced!, "video", {}), null);
    assert.equal(estimateUsd(cloud!, "image", {}), null);
  });
});

describe("jobs", () => {
  test("parseJob reads the public job and clamps progress", () => {
    const j = parseJob({ id: ID, kind: "video", agentId: "main", adapter: "vid", operation: "generate", state: "running", progress: { fraction: 1.7, stage: "downloading" }, createdAt: 1, updatedAt: 2 });
    assert.equal(j?.fraction, 1);
    assert.equal(j?.stage, "downloading");
    assert.equal(isActive(j!), true);
    assert.equal(parseJob({ state: "running" }), null);
    assert.equal(isActive(parseJob({ id: ID, state: "succeeded", outputId: "o" })!), false);
  });
  test("job list is newest first", () => {
    const list = parseJobList({ jobs: [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 5 }, null] });
    assert.deepEqual(list.map((j) => j.id), ["b", "a"]);
  });
  test("event hints carry a job id or nothing", () => {
    assert.equal(eventJobId(JSON.stringify({ jobId: ID, state: "running" })), ID);
    assert.equal(eventJobId("not json"), null);
    assert.equal(eventJobId(JSON.stringify({ jobId: "../x" })), null);
  });
});

describe("failures", () => {
  const rpc = (errorCode: string, reason?: string, message = "m", dataError = errorCode) => ({ kind: "rpc-error", errorCode, reason, message, data: { error: dataError, ...(reason ? { reason } : {}) } });
  test("privacy, licence, budget, adapter", () => {
    assert.equal(classifyFailure(rpc("E_MEDIA_PRIVACY")).text, "privacy");
    assert.equal(classifyFailure({ kind: "rpc-error", errorCode: null, data: { error: "E_MEDIA_PRIVACY" } }).text, "privacy");
    assert.equal(classifyFailure(rpc("E_MEDIA_LICENSE")).text, "license");
    assert.deepEqual(classifyFailure({ kind: "forbidden", errorCode: "E_DENIED", reason: "budget_exceeded", message: "media budget exceeded" }), { text: "budget", code: "E_DENIED", reason: "budget_exceeded" });
    assert.deepEqual(classifyFailure({ kind: "unavailable", errorCode: "E_NOT_AVAILABLE", reason: "backend_unavailable", message: "media request refused" }), { text: "adapter", code: "E_NOT_AVAILABLE", reason: "backend_unavailable" });
    assert.equal(classifyFailure({ kind: "unavailable", errorCode: "E_NOT_AVAILABLE", reason: "core-unavailable", message: "budget unavailable" }).text, "unavailable");
    assert.equal(classifyFailure({ kind: "unavailable", errorCode: "E_NOT_AVAILABLE", message: "budget unavailable" }).text, "budgetUnavailable");
  });
  test("everything else keeps its code and is never swallowed", () => {
    assert.equal(classifyFailure(rpc("E_INVALID_PARAMS", "unsupported_parameter")).text, "invalid");
    assert.equal(classifyFailure({ kind: "forbidden", errorCode: "E_DENIED", message: "agent rights required" }).text, "denied");
    assert.equal(classifyFailure(new Error("boom")).text, "generic");
    assert.equal(classifyFailure(rpc("E_STORAGE")).code, "E_STORAGE");
  });
  test("job error codes", () => {
    for (const [code, text] of [["content_policy", "policy"], ["quota", "quota"], ["timeout", "timeout"], ["interrupted", "interrupted"], ["auth_invalid", "authInvalid"], ["nope", "generic"]] as const) {
      assert.equal(classifyJobCode(code).text, text, code);
    }
  });
});
