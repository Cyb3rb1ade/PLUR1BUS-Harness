// Pure parts of the voice pages: licence classification, preselection (no research-only voice for English), confirmations, download
// progress, the exact params of the profile save, inheritance markers. No browser, no network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acceptList, allConfirmed, applyProgress, clampInt, confirmationsNeeded, draftOf, formatBytes, isResearchOnly, licenceKey, overriddenFields, parseBudget,
  parseProgress, preselectProfile, sameDraft, setParams, summarize, systemLanguage, voiceErrorOf, type Downloads,
} from "../src/pages/voice/model.ts";
import { LANGUAGES, profileOf } from "./voice-fixtures.ts";

const langs = LANGUAGES();
const de = langs.find((l) => l.language === "de")!;
const en = langs.find((l) => l.language === "en")!;
const fr = langs.find((l) => l.language === "fr")!;

describe("voice model: licences", () => {
  test("research-only and non-commercial licences are recognised, permissive ones are not", () => {
    for (const id of ["blizzard-2013", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "research-only", "Research"]) assert.equal(isResearchOnly(id), true, id);
    for (const id of ["MIT", "Apache-2.0", "CC-BY-SA-4.0", "CC0-1.0", "CC-BY-4.0"]) assert.equal(isResearchOnly(id), false, id);
  });
  test("confirmation key is modelId@licenceId; installed models need none; all must be ticked", () => {
    const models = de.profiles.fast!.models;
    assert.deepEqual(confirmationsNeeded(models).map(licenceKey), ["kroko-de@CC-BY-SA-4.0"]);
    assert.equal(allConfirmed(models, new Set()), false);
    assert.equal(allConfirmed(models, new Set(["kroko-de@CC-BY-SA-4.0"])), true);
    assert.deepEqual(acceptList(models, new Set(["kroko-de@CC-BY-SA-4.0", "other@x"])), ["kroko-de@CC-BY-SA-4.0"]);
    const installed = models.map((m) => ({ ...m, installed: true }));
    assert.deepEqual(confirmationsNeeded(installed), []);
    assert.equal(allConfirmed(installed, new Set()), true);
  });
});

describe("voice model: preselection", () => {
  test("English prefers quality (Kokoro) and never preselects the research-only Lessac profile", () => {
    assert.equal(preselectProfile(en), "quality");
    const onlyFast = { language: "en", profiles: { fast: en.profiles.fast! } };
    assert.equal(preselectProfile(onlyFast), null, "nothing safe is left: nothing is preselected");
  });
  test("German prefers fast (Thorsten + Kroko); a language with only a research-only profile gets none", () => {
    assert.equal(preselectProfile(de), "fast");
    assert.equal(preselectProfile(fr), null);
    assert.equal(preselectProfile(undefined), null);
  });
  test("system language: exact, base language, none", () => {
    assert.equal(systemLanguage("de-DE", langs), "de");
    assert.equal(systemLanguage("en", langs), "en");
    assert.equal(systemLanguage("pt-BR", langs), "");
    assert.equal(systemLanguage(undefined, langs), "");
  });
});

describe("voice model: downloads and formats", () => {
  test("progress events parse strictly and sum up per model set", () => {
    assert.equal(parseProgress("not json"), null);
    assert.equal(parseProgress(JSON.stringify({ modelId: "a", receivedBytes: "1" })), null);
    let d: Downloads = {};
    const ids = ["a", "b"];
    assert.equal(summarize(ids, d).status, "running");
    d = applyProgress(d, parseProgress(JSON.stringify({ modelId: "a", receivedBytes: 50, totalBytes: 100, done: false }))!);
    assert.equal(summarize(ids, d).percent, 25);
    d = applyProgress(d, { modelId: "a", receivedBytes: 100, totalBytes: 100, done: true });
    d = applyProgress(d, { modelId: "b", receivedBytes: 10, totalBytes: 10, done: true });
    assert.deepEqual(summarize(ids, d), { status: "done", percent: 100, failed: [] });
    d = applyProgress(d, { modelId: "b", receivedBytes: 3, totalBytes: 10, done: true, error: "disk full" });
    assert.deepEqual(summarize(ids, d).failed, ["b"]);
    assert.equal(summarize(ids, d).status, "failed");
    assert.equal(summarize([], d).status, "idle");
  });
  test("sizes", () => {
    assert.equal(formatBytes(512, "en"), "512 B");
    assert.equal(formatBytes(1536, "en"), "1.5 KiB");
    assert.equal(formatBytes(330 * 1024 * 1024, "en"), "330 MiB");
    assert.equal(formatBytes(-1), "–");
  });
  test("E_VOICE_* codes are read from error.data", () => {
    assert.equal(voiceErrorOf({ data: { error: "E_VOICE_LICENCE" } }), "E_VOICE_LICENCE");
    assert.equal(voiceErrorOf({ data: { error: "E_INTERNAL" } }), null);
    assert.equal(voiceErrorOf(null), null);
  });
});

describe("voice model: realtime profile", () => {
  test("the save params carry the editable fields only (no `effective`), agentId only when given", () => {
    const d = draftOf(profileOf());
    const p = setParams(d);
    assert.deepEqual(Object.keys(p).sort(), ["ackSound", "enabled", "endpointingMs", "features", "speculative"]);
    assert.equal(JSON.stringify(p).includes("effective"), false);
    assert.deepEqual(p.features.postTurnRefine, { mode: "deferred", maxMs: 400 });
    assert.deepEqual(p.features.autoRecall, { mode: "on" });
    assert.equal(setParams(d, "main").agentId, "main");
  });
  test("overridden fields are the ones that differ from the global profile", () => {
    const base = draftOf(profileOf());
    assert.equal(overriddenFields(base, base).size, 0);
    const agent = { ...base, endpointingMs: 900, features: { ...base.features, reranker: { mode: "off" as const } } };
    assert.deepEqual([...overriddenFields(agent, base)].sort(), ["endpointingMs", "feature.reranker"]);
    assert.equal(sameDraft(base, draftOf(profileOf())), true);
    assert.equal(sameDraft(base, agent), false);
  });
  test("number parsing clamps and rejects", () => {
    assert.equal(parseBudget(""), undefined);
    assert.equal(parseBudget("abc"), undefined);
    assert.equal(parseBudget("999999"), 60000);
    assert.equal(parseBudget("250"), 250);
    assert.equal(clampInt(10, 200, 2000), 200);
  });
});
