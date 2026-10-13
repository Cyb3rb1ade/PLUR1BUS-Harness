// The local voice model catalog the core ships and consumes (packages/voice-providers/src/local/catalog.json via
// src/voice/v3-catalog.ts; docs/voice-local.md "Licences"): every entry is checked, ids are unique, references resolve, and
// an entry whose licence is research-only (Lessac and the like) is never a default or preselection the core hands out.
// Rule from the owner: such voices are never the default; they need an explicit, per-model confirmation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaults, validate } from "@plur1bus/config-schema";
import { assertLicenceAccepted, builtinCatalog, downloadable, licenceKey, loadCatalog, mergeCatalog, modelsFor, needsLicenceConfirmation, parseCatalog, type Catalog, type CatalogModel } from "../../../voice-providers/src/index.ts";
import { V3_TTS_DEFAULTS, voiceV3Catalog } from "../../src/voice/v3-catalog.ts";
import { duplicateKeys, gap } from "./helpers.ts";

const FILE = fileURLToPath(new URL("../../../voice-providers/src/local/catalog.json", import.meta.url));
const TEXT = readFileSync(FILE, "utf8");
const RAW = JSON.parse(TEXT) as { vad: string; models: Record<string, Record<string, any>>; languages: Record<string, { stt: Record<string, string>; tts: Record<string, string> }> };
const cat = builtinCatalog();
const models = Object.values(cat.models);
// "false: non-commercial only" (Licence.commercial), or a licence id that says research; an unresolved claim (null) is a different case.
const isResearchOnly = (m: CatalogModel) => m.licence.commercial === false || /research/i.test(m.licence.id);
const clone = <T>(v: T): T => structuredClone(v);
const slotsOf = (c: Catalog, lang: string) => { const l = c.languages[lang]!; return [...Object.entries(l.stt).map(([k, id]) => [`stt.${k}`, id] as const), ...Object.entries(l.tts).map(([k, id]) => [`tts.${k}`, id] as const)]; };

describe("shipped voice catalog: every entry", () => {
  it("the file has no duplicated key anywhere: no model id and no language appears twice (JSON.parse would drop one silently)", () => {
    assert.deepEqual(duplicateKeys(TEXT), []);
  });

  it("parses, and it has the models the documentation lists (docs/voice-local.md) and nothing unexplained", () => {
    assert.deepEqual(Object.keys(cat.models).sort(), ["kokoro-multi", "kroko-de", "parakeet-110m-en", "parakeet-v3-int8", "piper-de-thorsten-low", "piper-en-lessac-low", "pocket-tts-en", "silero-vad", "voice-martin-de", "zipformer-en-streaming"]);
  });

  for (const m of models) {
    it(`${m.id}: safe id, known kind, complete licence record, relative paths`, () => {
      assert.match(m.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      assert.equal(RAW.models[m.id]!["kind"], m.kind); assert.ok(["stt", "tts", "vad"].includes(m.kind));
      assert.ok(m.engine && m.displayName);
      assert.equal(typeof m.licence.id, "string"); assert.ok(m.licence.name);
      assert.ok(m.licence.commercial === true || m.licence.commercial === false || m.licence.commercial === null);
      assert.ok(m.licence.status === "confirmed" || m.licence.status === "unconfirmed");
      if (m.licence.commercial !== true || m.licence.status !== "confirmed") assert.ok(m.licence.notice, `${m.id}: a licence that is not plainly commercial and confirmed must carry a notice the owner sees`);
      assert.ok(Object.keys(m.roles).length > 0, "roles");
      for (const p of Object.values(m.roles)) assert.ok(!p.startsWith("/") && !p.split(/[\\/]/).includes(".."), p);
      for (const d of m.download) if (d.path !== undefined) assert.ok(!d.path.startsWith("/") && !d.path.split(/[\\/]/).includes(".."), d.path);
    });

    it(`${m.id}: downloads are either fully pinned (https, 64-hex sha256, positive size) or fully unset, and an unset one is refused by the downloader`, () => {
      assert.ok(m.download.length > 0);
      for (const d of m.download) {
        if (d.url === null) { assert.equal(d.sha256, null, "no URL, so no checksum either"); assert.equal(downloadable(m).ok, false); continue; }
        assert.equal(new URL(d.url).protocol, "https:"); assert.equal(new URL(d.url).username, "");
        assert.match(d.sha256 ?? "", /^[0-9a-f]{64}$/); assert.ok(Number.isSafeInteger(d.sizeBytes) && (d.sizeBytes as number) > 0);
      }
      if (m.download.every((d) => d.url !== null)) assert.deepEqual(downloadable(m), { ok: true });
    });

    it(`${m.id}: the licence gate refuses it without the exact '<id>@<licence id>' confirmation iff its licence is not plainly commercial and confirmed`, () => {
      const needs = m.licence.commercial !== true || m.licence.status !== "confirmed";
      assert.equal(needsLicenceConfirmation(m), needs);
      const key = `${m.id}@${m.licence.id}`; assert.equal(licenceKey(m), key);
      if (!needs) { assert.doesNotThrow(() => assertLicenceAccepted(m, [])); return; }
      assert.throws(() => assertLicenceAccepted(m, []), (e: unknown) => (e as { code?: string }).code === "licence_required" && (e as Error).message.includes(key));
      for (const wrong of [`${m.id}@other`, `other@${m.licence.id}`, m.id, m.licence.id, key.toUpperCase(), ` ${key}`]) assert.throws(() => assertLicenceAccepted(m, [wrong]), (e: unknown) => (e as { code?: string }).code === "licence_required", wrong);
      assert.doesNotThrow(() => assertLicenceAccepted(m, [key])); assert.doesNotThrow(() => assertLicenceAccepted(m, new Set([key])));
    });
  }
});

describe("shipped voice catalog: references resolve", () => {
  it("the VAD names an existing vad model", () => assert.equal(cat.models[cat.vad]?.kind, "vad"));

  it("every language slot names an existing model of the right kind", () => {
    assert.deepEqual(Object.keys(cat.languages).sort(), ["de", "en"]);
    for (const lang of Object.keys(cat.languages)) for (const [slot, id] of slotsOf(cat, lang)) {
      const m = cat.models[id]; assert.ok(m, `${lang} ${slot} -> ${id}`); assert.equal(m!.kind, slot.split(".")[0], `${lang} ${slot} -> ${id}`);
    }
  });

  it("every language has both a fast stt and a fast tts, and modelsFor resolves every profile to concrete models", () => {
    for (const lang of Object.keys(cat.languages)) for (const profile of ["fast", "quality"] as const) {
      const r = modelsFor(cat, lang, profile);
      assert.equal(r.stt.kind, "stt"); assert.equal(r.tts.kind, "tts"); assert.equal(r.vad.id, cat.vad);
    }
  });

  it("a language that is not in the catalog is an error naming it, not an undefined model", () => {
    assert.throws(() => modelsFor(cat, "xx", "fast"), (e: unknown) => (e as { code?: string }).code === "catalog" && (e as Error).message.includes('"xx"'));
  });
});

describe("shipped voice catalog: research-only licences are never defaults", () => {
  const researchOnly = models.filter(isResearchOnly).map((m) => m.id);

  it("the research-only models are exactly the ones the documentation says (Lessac), so the check below is not vacuous", () => {
    assert.deepEqual(researchOnly, ["piper-en-lessac-low"]);
  });

  it("what the core hands out (voiceV3Catalog with its default profiles) selects no research-only model in any slot, any language, or as VAD", () => {
    const v3 = voiceV3Catalog();
    for (const lang of Object.keys(v3.languages)) for (const [slot, id] of slotsOf(v3, lang)) {
      assert.equal(isResearchOnly(v3.models[id]!), false, `${lang} ${slot} -> ${id}`);
    }
    assert.equal(isResearchOnly(v3.models[v3.vad]!), false);
  });

  it("the core's own default profiles name existing tts models whose licence is commercial and confirmed (nothing to confirm on first use)", () => {
    for (const lang of ["de", "en"] as const) for (const tier of ["fast", "quality"] as const) {
      const m = cat.models[V3_TTS_DEFAULTS[lang][tier]]!; assert.ok(m, `${lang}.${tier}`); assert.equal(m.kind, "tts");
      assert.equal(needsLicenceConfirmation(m), false, `${lang}.${tier} -> ${m.id}`);
    }
    assert.deepEqual(defaults().voice.v3.profiles, { de: { ...V3_TTS_DEFAULTS.de }, en: { ...V3_TTS_DEFAULTS.en } });
  });

  it("the configuration cannot select a research-only (or unconfirmed) voice as a profile: every id the schema accepts is a commercial, confirmed tts model", () => {
    for (const lang of ["de", "en"] as const) for (const tier of ["fast", "quality"] as const) {
      const accepted: string[] = [];
      for (const id of [...Object.keys(cat.models), "", "nope", "__proto__"]) {
        const c = clone(defaults()); c.voice.v3.profiles[lang][tier] = id;
        if (validate(c).ok) accepted.push(id);
      }
      assert.ok(accepted.length >= 1, `${lang}.${tier}: at least the default is accepted`);
      for (const id of accepted) { const m = cat.models[id]!; assert.ok(m && m.kind === "tts" && !needsLicenceConfirmation(m), `${lang}.${tier} accepts ${id}`); }
      assert.equal(accepted.includes("piper-en-lessac-low"), false);
    }
  });

  it("a catalog override cannot put a research-only voice into the core's de/en selection: the profiles win", () => {
    const override = { languages: { en: { name: "English", stt: { fast: "zipformer-en-streaming" }, tts: { fast: "piper-en-lessac-low", quality: "piper-en-lessac-low" } } } };
    assert.equal(loadCatalog(override).languages.en!.tts.fast, "piper-en-lessac-low", "the plain loader takes the override (it is the owner's data)");
    const v3 = voiceV3Catalog(override);
    assert.equal(v3.languages.en!.tts.fast, V3_TTS_DEFAULTS.en.fast); assert.equal(v3.languages.en!.tts.quality, V3_TTS_DEFAULTS.en.quality);
  });

  const lessacTitle = gap("voice-providers builtin catalog (loadCatalog without profiles)",
    "no research-only model preselected as a language's default (owner rule: Lessac and its like are never a default)",
    "the built-in catalog preselects piper-en-lessac-low as English tts.fast (docs/voice-local.md lists it as the English fast voice); only the core's voiceV3Catalog replaces it and the licence gate refuses it until confirmed per model");
  it(lessacTitle, { todo: lessacTitle }, () => {
    for (const lang of Object.keys(cat.languages)) for (const [slot, id] of slotsOf(cat, lang)) assert.equal(isResearchOnly(cat.models[id]!), false, `${lang} ${slot} -> ${id}`);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: the built-in catalog's German quality voice is a model with an unknown licence and no package (gated by the licence confirmation and by the missing download)", () => {
    const m = cat.models[cat.languages.de!.tts.quality!]!;
    assert.equal(m.id, "voice-martin-de"); assert.equal(m.licence.commercial, null); assert.equal(needsLicenceConfirmation(m), true); assert.equal(downloadable(m).ok, false);
  });
});

describe("voiceV3Catalog", () => {
  it("does not touch the shared built-in catalog: loading twice gives the same built-in selection", () => {
    voiceV3Catalog();
    assert.equal(builtinCatalog().languages.en!.tts.fast, "piper-en-lessac-low");
    assert.equal(builtinCatalog().languages.de!.tts.quality, "voice-martin-de");
  });

  it("replaces the tts selection of de and en with the profiles and keeps stt, vad, models and licences as they are", () => {
    const v3 = voiceV3Catalog();
    assert.deepEqual(v3.languages.de!.stt, cat.languages.de!.stt); assert.deepEqual(v3.languages.en!.stt, cat.languages.en!.stt);
    assert.equal(v3.vad, cat.vad); assert.deepEqual(v3.models, cat.models);
    assert.equal(v3.languages.de!.tts.fast, "piper-de-thorsten-low");
  });

  it("another language from an override keeps its own selection", () => {
    const override = { models: { "x-tts": { kind: "tts", engine: "vits", displayName: "X", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: null, sha256: null, sizeBytes: null, path: "m.onnx" }], roles: { model: "m.onnx" } } }, languages: { fr: { name: "Francais", stt: { fast: "parakeet-v3-int8" }, tts: { fast: "x-tts" } } } };
    const v3 = voiceV3Catalog(override);
    assert.equal(v3.languages.fr!.tts.fast, "x-tts"); assert.deepEqual(Object.keys(v3.languages).sort(), ["de", "en", "fr"]);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: the declared tts fallback of de and en is dropped when the profiles are applied (docs/voice-local.md describes the fallback tier)", () => {
    assert.equal(cat.languages.en!.tts.fallback, "kokoro-multi");
    assert.equal(voiceV3Catalog().languages.en!.tts.fallback, undefined);
    assert.equal(voiceV3Catalog().languages.de!.tts.fallback, undefined);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: profile ids are not checked against the catalog here (the configuration schema restricts them to an enum); a dangling one leaves a language pointing at nothing", () => {
    const c = voiceV3Catalog(undefined, { de: { fast: "nope", quality: "silero-vad" }, en: { fast: "kokoro-multi", quality: "kokoro-multi" } });
    assert.equal(c.models["nope"], undefined); assert.equal(modelsFor(c, "de", "fast").tts, undefined);
    assert.equal(modelsFor(c, "de", "quality").tts.kind, "vad");
  });
});

describe("voice catalog overrides: invalid entries are rejected with a message that names them", () => {
  const goodModel = () => ({ kind: "tts", engine: "vits", displayName: "New", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: null, sha256: null, sizeBytes: null, path: "m.onnx" }], roles: { model: "m.onnx" } });
  const rejects = (override: unknown, fragment: string) => assert.throws(() => loadCatalog(override), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "catalog"); assert.ok((e as Error).message.startsWith("voice catalog: "), (e as Error).message); assert.ok((e as Error).message.includes(fragment), `${(e as Error).message} lacks ${fragment}`); return true;
  });
  const withModel = (id: string, m: unknown) => ({ models: { [id]: m } });

  it("the baseline override with a new model is accepted, and null or undefined changes nothing", () => {
    assert.ok(loadCatalog(withModel("new-voice", goodModel())).models["new-voice"]);
    assert.equal(loadCatalog(undefined), cat); assert.equal(loadCatalog(null), cat);
  });

  it("an override that is not an object is refused", () => { for (const bad of [5, "x", true, [], [1]]) rejects(bad, "catalogOverride is not an object"); });

  it("a model with a bad kind, no engine, a broken licence, no downloads or no roles is refused by id", () => {
    rejects(withModel("m1", { ...goodModel(), kind: "music" }), "model m1: bad kind");
    rejects(withModel("m2", { ...goodModel(), engine: undefined }), "model m2: engine and displayName are required");
    rejects(withModel("m3", { ...goodModel(), displayName: 5 }), "model m3: engine and displayName are required");
    for (const licence of [undefined, null, "MIT", { id: "MIT" }, { id: "MIT", name: "MIT", commercial: "yes", status: "confirmed" }, { id: "MIT", name: "MIT", commercial: true, status: "maybe" }, { id: 1, name: "MIT", commercial: true, status: "confirmed" }])
      rejects(withModel("m4", { ...goodModel(), licence }), "model m4: licence needs id, name, commercial (true|false|null) and status");
    rejects(withModel("m5", { ...goodModel(), download: [] }), "model m5: download list is required");
    rejects(withModel("m6", { ...goodModel(), roles: undefined }), "model m6: roles are required");
    rejects(withModel("m7", 5), "model m7 is not an object");
  });

  it("download items: a non-string url, a malformed checksum, a plain file without a path and a path that escapes the model directory are each refused", () => {
    const d = (x: object) => ({ ...goodModel(), download: [{ url: null, sha256: null, sizeBytes: null, path: "m.onnx", ...x }] });
    rejects(withModel("a", d({ url: 5 })), "download url must be a string or null");
    rejects(withModel("b", d({ sha256: "abc" })), "sha256 must be 64 hex characters or null");
    rejects(withModel("c", d({ sha256: 5 })), "sha256 must be 64 hex characters or null");
    rejects(withModel("d", d({ path: undefined })), "a plain download needs a path");
    for (const p of ["/etc/passwd", "../x", "a/../../x", "a\\..\\x", ".."]) rejects(withModel("e", d({ path: p })), "download path escapes the model directory");
    rejects(withModel("f", { ...goodModel(), download: [7] }), "bad download item");
  });

  it("role paths that escape the model directory are refused", () => {
    for (const p of ["/abs", "../up", "a/../../up", 5]) rejects(withModel("r", { ...goodModel(), roles: { model: p } }), "role path escapes the model directory");
  });

  it("an id that is not a safe directory name is refused: separators, dots-first, leading dash, empty, spaces, non-ASCII", () => {
    for (const id of ["../evil", "a/b", "a\\b", ".hidden", "-lead", "", " x", "x y", "é"]) rejects(withModel(id, goodModel()), `model id ${id} is not a safe directory name`);
  });

  const protoTitle = gap("voice-providers mergeCatalog / parseCatalog (model id '__proto__')",
    "an override model whose id is '__proto__' is rejected like every other unsafe id ('model id __proto__ is not a safe directory name')",
    "it is dropped silently: mergeCatalog assigns it to a local object's prototype slot, so parseCatalog never sees it (no pollution of Object.prototype or the catalog; the entry just vanishes)");
  it(protoTitle, { todo: protoTitle }, () => rejects(withModel("__proto__", goodModel()), "model id __proto__ is not a safe directory name"));

  it("an entry named '__proto__' leaves no trace: nothing is added to the catalog and Object.prototype stays clean (what does happen today, pinned next to the gap above)", () => {
    const parsed = JSON.parse('{"models":{"__proto__":{"polluted":true}}}');
    const c = loadCatalog(parsed);
    assert.deepEqual(Object.keys(c.models), Object.keys(cat.models)); assert.equal(({} as { polluted?: boolean }).polluted, undefined); assert.equal(Object.hasOwn(c.models, "__proto__"), false);
  });

  it("language codes are checked, and a language must name existing models of the right kind", () => {
    const lang = (x: object) => ({ languages: { fr: { name: "F", stt: { fast: "kroko-de" }, tts: { fast: "kokoro-multi" }, ...x } } });
    assert.ok(loadCatalog(lang({})).languages.fr);
    for (const code of ["", "F", "english", "fr_FR", "__proto__", "1a"]) rejects({ languages: { [code]: { name: "x", stt: { fast: "kroko-de" }, tts: { fast: "kokoro-multi" } } } }, `language code ${code} is not valid`);
    rejects(lang({ stt: { fast: "zz" } }), "language fr: stt.fast names unknown model zz");
    rejects(lang({ tts: { fast: "kroko-de" } }), "language fr: tts.fast names kroko-de, a stt model");
    rejects(lang({ stt: { fast: "kokoro-multi" } }), "language fr: stt.fast names kokoro-multi, a tts model");
    rejects(lang({ tts: { fast: "kokoro-multi", fallback: "ghost" } }), "language fr: tts.fallback names unknown model ghost");
    rejects(lang({ stt: undefined }), "language fr: stt.fast and tts.fast are required");
    rejects(lang({ tts: { quality: "kokoro-multi" } }), "language fr: stt.fast and tts.fast are required");
    rejects({ languages: { fr: 5 } }, "language fr: stt.fast and tts.fast are required");
  });

  it("references through inherited object properties do not resolve: 'toString', 'constructor' and the like are not models", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      assert.throws(() => loadCatalog({ languages: { fr: { name: "F", stt: { fast: name }, tts: { fast: "kokoro-multi" } } } }), (e: unknown) => (e as { code?: string }).code === "catalog", name);
      assert.throws(() => loadCatalog({ vad: name }), (e: unknown) => (e as { code?: string }).code === "catalog" && (e as Error).message.includes("vad must name a vad model"), name);
    }
  });

  it("the VAD must be a vad model that exists", () => {
    rejects({ vad: "kokoro-multi" }, "vad must name a vad model"); rejects({ vad: "nope" }, "vad must name a vad model"); rejects({ vad: 5 }, "vad must name a vad model");
  });

  it("the licence of a built-in model cannot be changed by an override: a research-only voice cannot be relabelled commercial, and a confirmed one cannot be downgraded", () => {
    const relabel = { models: { "piper-en-lessac-low": { ...clone(RAW.models["piper-en-lessac-low"]), licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" } } } };
    const m = loadCatalog(relabel).models["piper-en-lessac-low"]!;
    assert.deepEqual(m.licence, cat.models["piper-en-lessac-low"]!.licence); assert.equal(needsLicenceConfirmation(m), true);
    const noLicence = loadCatalog({ models: { "piper-en-lessac-low": { ...clone(RAW.models["piper-en-lessac-low"]), licence: undefined } } }).models["piper-en-lessac-low"]!;
    assert.equal(noLicence.licence.commercial, false);
    const junk = loadCatalog({ models: { "kokoro-multi": { ...clone(RAW.models["kokoro-multi"]), licence: "junk" } } }).models["kokoro-multi"]!;
    assert.deepEqual(junk.licence, cat.models["kokoro-multi"]!.licence);
  });

  it("an override with a built-in id and a different licence id cannot dodge a stored confirmation key: the key still carries the built-in licence id", () => {
    const m = loadCatalog({ models: { "piper-en-lessac-low": { ...clone(RAW.models["piper-en-lessac-low"]), licence: { ...RAW.models["piper-en-lessac-low"]!["licence"], id: "relabelled" } } } }).models["piper-en-lessac-low"]!;
    assert.equal(licenceKey(m), "piper-en-lessac-low@Blizzard-2013-Lessac-research");
  });

  it("a new id carries and is gated by its own licence (documented): a new research-only voice needs its own confirmation, a new commercial one does not", () => {
    const nc = loadCatalog(withModel("new-nc", { ...goodModel(), licence: { id: "NC", name: "NC", commercial: false, status: "confirmed" } })).models["new-nc"]!;
    assert.equal(needsLicenceConfirmation(nc), true);
    assert.equal(needsLicenceConfirmation(loadCatalog(withModel("new-ok", goodModel())).models["new-ok"]!), false);
  });

  it("the merge does not change the built-in catalog or the override object it was given", () => {
    const override = withModel("new-voice", goodModel()); const before = JSON.stringify(override);
    loadCatalog(override);
    assert.equal(JSON.stringify(override), before);
    assert.equal(builtinCatalog().models["new-voice"], undefined);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: 'models' or 'languages' that are not objects are ignored without a message (only a non-object override as a whole is refused)", () => {
    assert.deepEqual(Object.keys(loadCatalog({ models: 5 }).models), Object.keys(cat.models));
    assert.deepEqual(Object.keys(loadCatalog({ languages: "x" }).languages), Object.keys(cat.languages));
    assert.deepEqual(Object.keys(loadCatalog({ models: [1] }).models), Object.keys(cat.models));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: an override of a built-in model may replace everything but the licence, including its download url and checksum", () => {
    const sha = "a".repeat(64);
    const m = loadCatalog({ models: { "kokoro-multi": { ...clone(RAW.models["kokoro-multi"]), download: [{ url: "https://example.invalid/m.tar.bz2", sha256: sha, sizeBytes: 5, archive: "tar.bz2" }] } } }).models["kokoro-multi"]!;
    assert.equal(m.download[0]!.sha256, sha);
  });

  it("parseCatalog on garbage: not an object, wrong version, missing blocks", () => {
    for (const bad of [null, 5, "x", []]) assert.throws(() => parseCatalog(bad), /voice catalog: not an object/);
    assert.throws(() => parseCatalog({ version: 2, models: {}, languages: {}, vad: "x" }), /unsupported version/);
    assert.throws(() => parseCatalog({ version: 1, vad: "x" }), /models and languages are required/);
    assert.throws(() => mergeCatalog(cat, 5), /catalogOverride is not an object/);
  });
});
