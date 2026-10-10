import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLicenceAccepted, builtinCatalog, downloadable, licenceKey, licenceNotice, loadCatalog, modelsFor, needsLicenceConfirmation, parseCatalog } from "../src/local/catalog.ts";
import { isVoiceProviderError } from "../src/errors.ts";

test("the shipped catalog loads and gives every language a fast and a quality tier for stt and tts", () => {
  const c = builtinCatalog();
  assert.deepEqual(Object.keys(c.languages).sort(), ["de", "en"]);
  for (const code of Object.keys(c.languages)) for (const profile of ["fast", "quality"] as const) {
    const m = modelsFor(c, code, profile);
    assert.equal(m.stt.kind, "stt");
    assert.equal(m.tts.kind, "tts");
    assert.equal(m.vad.kind, "vad");
  }
  assert.equal(modelsFor(c, "de", "fast").stt.id, "kroko-de");
  assert.equal(modelsFor(c, "de", "fast").stt.streaming, true);
  assert.equal(modelsFor(c, "de", "quality").tts.id, "voice-martin-de");
  assert.equal(modelsFor(c, "de", "quality").ttsFallback?.id, "piper-de-thorsten-low");
  assert.equal(modelsFor(c, "en", "quality").stt.id, "parakeet-110m-en");
  assert.equal(modelsFor(c, "en", "quality").ttsFallback?.id, "kokoro-multi");
});

test("Martin is marked unconfirmed and cannot be downloaded; a model is downloadable only with URL and pinned sha256", () => {
  const c = builtinCatalog();
  const martin = c.models["voice-martin-de"]!;
  assert.equal(martin.licence.status, "unconfirmed");
  assert.equal(downloadable(martin).ok, false);
  assert.equal(needsLicenceConfirmation(martin), true);
  for (const m of Object.values(c.models)) {
    const d = downloadable(m);
    assert.equal(d.ok, m.download.every((x) => x.url !== null && x.sha256 !== null), m.id);
    if (!d.ok) assert.match(d.reason, /unconfirmed|sha256|URL/);
  }
});

test("licence gate: confirmed commercial licences pass, non-commercial and unconfirmed need explicit acceptance", () => {
  const c = builtinCatalog();
  assert.equal(needsLicenceConfirmation(c.models["kokoro-multi"]!), false);
  assert.doesNotThrow(() => assertLicenceAccepted(c.models["kokoro-multi"]!, []));
  for (const id of ["kroko-de", "voice-martin-de"]) {
    assert.throws(() => assertLicenceAccepted(c.models[id]!, []), (e) => isVoiceProviderError(e) && e.code === "licence_required" && /UNCONFIRMED/.test(e.message));
    assert.doesNotThrow(() => assertLicenceAccepted(c.models[id]!, [licenceKey(c.models[id]!)]));
  }
  assert.match(licenceNotice(c.models["voice-martin-de"]!), /commercial use not confirmed/);
  assert.match(licenceNotice(c.models["piper-en-lessac-low"]!), /NON-COMMERCIAL/);
});

test("adding a language is data only: an override adds models and a language, and the result validates", () => {
  const c = loadCatalog({
    models: {
      "fr-stt": { kind: "stt", engine: "streaming-transducer", streaming: true, displayName: "FR STT", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: "https://example.invalid/a", sha256: "a".repeat(64), sizeBytes: 1, path: "a.onnx" }], roles: { model: "a.onnx" } },
      "fr-tts": { kind: "tts", engine: "vits", displayName: "FR TTS", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: "https://example.invalid/b", sha256: "b".repeat(64), sizeBytes: 1, path: "b.onnx" }], roles: { model: "b.onnx" } },
    },
    languages: { fr: { name: "Francais", stt: { fast: "fr-stt" }, tts: { fast: "fr-tts" } } },
  });
  assert.ok(c.languages["fr"]);
  assert.equal(modelsFor(c, "fr", "quality").stt.id, "fr-stt", "quality falls back to fast when a language has no quality tier");
  assert.ok(c.languages["de"], "built-in languages stay");
  assert.equal(downloadable(c.models["fr-stt"]!).ok, true);
});

test("a malformed catalog is rejected with a catalog error naming the problem", () => {
  const base = { version: 1, vad: "v", languages: {}, models: { v: { kind: "vad", engine: "silero-vad", displayName: "V", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: "https://x/y", sha256: null, sizeBytes: null, path: "v.onnx" }], roles: { model: "v.onnx" } } } };
  assert.doesNotThrow(() => parseCatalog(base));
  const bad: Array<[string, unknown, RegExp]> = [
    ["unknown model ref", { ...base, languages: { xx: { name: "X", stt: { fast: "nope" }, tts: { fast: "v" } } } }, /unknown model/],
    ["wrong kind", { ...base, languages: { xx: { name: "X", stt: { fast: "v" }, tts: { fast: "v" } } } }, /a vad model/],
    ["bad sha", { ...base, models: { v: { ...base.models.v, download: [{ url: "https://x", sha256: "xyz", sizeBytes: 1, path: "p" }] } } }, /sha256/],
    ["path traversal in download", { ...base, models: { v: { ...base.models.v, download: [{ url: "https://x", sha256: null, sizeBytes: 1, path: "../evil" }] } } }, /escapes/],
    ["path traversal in role", { ...base, models: { v: { ...base.models.v, roles: { model: "/etc/passwd" } } } }, /escapes/],
    ["unsafe model id", { ...base, models: { "../v": base.models.v }, vad: "../v" }, /safe directory/],
    ["bad version", { ...base, version: 2 }, /version/],
    ["missing licence status", { ...base, models: { v: { ...base.models.v, licence: { id: "x", name: "x", commercial: true } } } }, /licence/],
    ["bad language code", { ...base, languages: { "X!": { name: "X", stt: { fast: "v" }, tts: { fast: "v" } } } }, /language code/],
  ];
  for (const [name, doc, re] of bad) assert.throws(() => parseCatalog(doc), (e) => isVoiceProviderError(e) && e.code === "catalog" && re.test(e.message), name);
});

test("licence confirmation is per model and licence id: accepting one does not accept another, a changed licence id needs a new confirmation", () => {
  const c = builtinCatalog();
  const kroko = c.models["kroko-de"]!;
  const martin = c.models["voice-martin-de"]!;
  assert.equal(licenceKey(kroko), "kroko-de@CC-BY-SA");
  assert.throws(() => assertLicenceAccepted(martin, [licenceKey(kroko)]), (e) => isVoiceProviderError(e) && e.code === "licence_required" && /voice-martin-de@unknown/.test(e.message));
  assert.doesNotThrow(() => assertLicenceAccepted(kroko, new Set([licenceKey(kroko)])));
  const updated = { ...kroko, licence: { ...kroko.licence, id: "CC-BY-SA-v2" } };
  assert.throws(() => assertLicenceAccepted(updated, new Set([licenceKey(kroko)])), (e) => isVoiceProviderError(e) && e.code === "licence_required" && /kroko-de@CC-BY-SA-v2/.test(e.message));
  assert.throws(() => assertLicenceAccepted({ ...kroko, id: "kroko-new" }, [licenceKey(kroko)]), (e) => isVoiceProviderError(e) && e.code === "licence_required");
});

test("catalogOverride cannot change the licence of a built-in model, but may change its other fields and add new models with their own licence", () => {
  const builtin = builtinCatalog();
  const flipped = { id: "x", name: "Free for all", commercial: true, status: "confirmed" };
  const c = loadCatalog({ models: {
    "kroko-de": { ...builtin.models["kroko-de"]!, licence: flipped, displayName: "Kroko override" },
    "voice-martin-de": { ...builtin.models["voice-martin-de"]!, licence: flipped },
  } });
  assert.deepEqual(c.models["kroko-de"]!.licence, builtin.models["kroko-de"]!.licence);
  assert.equal(c.models["kroko-de"]!.displayName, "Kroko override");
  assert.equal(needsLicenceConfirmation(c.models["kroko-de"]!), true);
  assert.equal(needsLicenceConfirmation(c.models["voice-martin-de"]!), true);
  assert.throws(() => assertLicenceAccepted(c.models["voice-martin-de"]!, []), (e) => isVoiceProviderError(e) && e.code === "licence_required");
  const added = loadCatalog({ models: { "new-nc": { ...builtin.models["piper-de-thorsten-low"]!, licence: { id: "NC", name: "NC", commercial: false, status: "confirmed" } } } });
  assert.equal(needsLicenceConfirmation(added.models["new-nc"]!), true);
});
