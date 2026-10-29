/** Host-side real-model recordings. Model artifacts and NC results never belong in the repository. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative, isAbsolute, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const E5 = "intfloat/multilingual-e5-small";
const GEMMA = "google/embeddinggemma-2";
const BGE = "woxpas-ai/bge-reranker-v2-m3-onnx";
const JINA3 = "jinaai/jina-embeddings-v3";
const JINA5 = "jinaai/jina-embeddings-v5-text-nano-retrieval";
const JINA_RERANK = "jinaai/jina-reranker-v2-base-multilingual";
const MAX_BYTES = 1_000_000;
const METADATA = new Set(["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]);

const GERMAN = [
  "Heute scheint die Sonne.",
  "Bitte speichere diese Erinnerung.",
  "Der Zug fährt morgen um sieben Uhr am Hauptbahnhof ab.",
  "Meine Schwester trinkt ihren Kaffee ohne Zucker und mit Hafermilch.",
  "Wo liegt das blaue Notizbuch, das wir gestern im Büro benutzt haben?",
  "Ich möchte nächste Woche einen Termin beim Zahnarzt vereinbaren.",
  "Beim Wandern im Schwarzwald haben wir einen seltenen Vogel beobachtet.",
  "Der neue Server beantwortet Anfragen schneller, verbraucht aber mehr Arbeitsspeicher.",
  "Nach dem langen Gespräch haben sich beide Seiten auf einen gemeinsamen Vorschlag geeinigt.",
  "Die Bibliothek öffnet dienstags erst am Nachmittag und bleibt dafür bis zwanzig Uhr geöffnet.",
  "Eine gute Zusammenfassung nennt die wichtigsten Tatsachen und trennt Beobachtungen von Vermutungen.",
  "Für das Rezept benötigen wir Kartoffeln, frischen Rosmarin, Olivenöl und eine kleine Prise Salz.",
  "Obwohl es morgens geregnet hatte, konnten die Kinder am Nachmittag draußen im Garten spielen.",
  "Das Protokoll der Sitzung enthält drei offene Fragen, zwei Entscheidungen und den nächsten Besprechungstermin.",
  "Wenn die Verbindung unterbrochen wird, soll die Anwendung den letzten gespeicherten Zustand wiederherstellen.",
  "Im vergangenen Sommer fuhren wir mit dem Fahrrad entlang des Flusses und übernachteten in kleinen Pensionen.",
  "Die Forscherin erklärte, dass eine einzelne Messung noch keinen zuverlässigen Schluss über die gesamte Entwicklung erlaubt.",
  "Unter dem Dach lagern alte Briefe, vergilbte Fotografien und eine Landkarte, auf der die Grenzen längst anders verlaufen.",
  "Beim Vergleich verschiedener Suchverfahren müssen neben der Genauigkeit auch Laufzeit, Speicherbedarf und nachvollziehbare Fehlerfälle betrachtet werden.",
  "Für die Vorbereitung der Reise notierte Lea alle Abfahrtszeiten, reservierte ein ruhiges Zimmer und prüfte, ob ihr Ausweis noch gültig war.",
  "Die Besprechung begann mit einem Rückblick auf die letzte Woche. Anschließend sammelten wir offene Aufgaben und ordneten sie nach ihrer Dringlichkeit. Zwei Vorschläge ließen sich sofort umsetzen, während für den dritten noch eine Rückmeldung aus der Fachabteilung fehlte. Zum Schluss hielten wir fest, wer welche Entscheidung vorbereitet und wann wir die Ergebnisse gemeinsam prüfen wollen.",
  "In einer kleinen Werkstatt am Rand der Stadt repariert ein älterer Mann seit vielen Jahren mechanische Uhren. Auf seinem Tisch liegen winzige Schrauben, Lupen und sorgfältig beschriftete Schachteln. Jede Uhr erzählt eine andere Geschichte: Manche wurden verschenkt, andere vererbt oder auf einem Flohmarkt entdeckt. Bevor er mit der Arbeit beginnt, hört er dem Ticken zu und fragt nach der Vergangenheit des Stücks. Erst danach öffnet er das Gehäuse und untersucht die einzelnen Teile.",
  "Als die Gemeinde über die Nutzung des alten Bahnhofs nachdachte, kamen sehr unterschiedliche Wünsche zusammen. Jugendliche wollten einen Proberaum, ältere Einwohner einen Treffpunkt und mehrere Vereine einen Ort für Ausstellungen. Statt sofort über einen fertigen Entwurf abzustimmen, vereinbarten sie einen Versuch über drei Monate. Freiwillige richteten die Räume einfach ein, führten einen gemeinsamen Kalender und sammelten nach jeder Veranstaltung kurze Rückmeldungen. Dabei zeigte sich, dass nicht alle Wünsche miteinander konkurrierten. An manchen Tagen fanden nachmittags Lesungen und abends Musikproben statt. Ein kleiner Nebenraum bot Platz für Beratungsgespräche, während im großen Saal wechselnde Bilder hingen. Schwieriger waren die Fragen nach Reinigung, Heizung und verlässlichen Öffnungszeiten. Dafür bildete sich eine Arbeitsgruppe, die Kosten notierte und mit der Verwaltung sprach. Am Ende des Versuchs lag noch kein perfekter Plan vor. Es gab jedoch konkrete Erfahrungen, einen realistischen Haushalt und viele Menschen, die sich bereits für den Ort verantwortlich fühlten. Diese Grundlage machte die nächste Entscheidung deutlich leichter.",
  "Öffne bitte die Übersicht über sämtliche Änderungen seit dem letzten Dienstag.",
  "",
];

const ENGLISH = [
  "The garden is quiet.",
  "Please remember this appointment.",
  "Our train leaves the central station at seven tomorrow morning.",
  "My brother prefers tea with lemon and no sugar.",
  "Where did we put the small notebook after yesterday's meeting?",
  "I need to arrange a dental appointment for next week.",
  "During our walk through the forest we noticed a bird we had never seen before.",
  "The new service responds faster but needs more memory under heavy load.",
  "After a long discussion both teams agreed to test the proposal before making a final decision.",
  "The library opens later on Tuesdays and remains available until eight in the evening.",
  "A useful summary records the main facts and makes uncertainty easy to recognize.",
  "For dinner we need potatoes, fresh herbs, olive oil, and a small pinch of salt.",
  "Although the morning had been rainy, the children were able to play outside after lunch.",
  "The meeting notes contain three open questions, two decisions, and the date of our next discussion.",
  "If the connection drops, the application should restore the last state that was saved successfully.",
  "Last summer we cycled along the river and stayed in small guest houses near the old bridges.",
  "The researcher explained why one measurement could not establish a reliable trend for the whole population.",
  "In the attic we found old letters, faded photographs, and a map showing borders that no longer exist.",
  "When comparing search methods, consider accuracy together with response time, memory use, and understandable failure cases.",
  "Before leaving for the trip, Maya checked the departure times, booked a quiet room, and confirmed that her passport was valid.",
  "We started the meeting by reviewing the previous week. Then we listed unfinished work and arranged the tasks by urgency. Two ideas could be tested immediately, while a third required additional information from another department. Before leaving, everyone knew which decision they were preparing and when the group would review the evidence together.",
  "A small repair shop at the edge of town has looked after mechanical clocks for many years. Tiny screws, magnifying glasses, and carefully labeled boxes cover the workbench. Each clock arrives with a different history. Some were wedding presents, some were inherited, and others were found at local markets. The owner first listens to the ticking and asks about the object before opening its case and examining the mechanism.",
  "When the town began discussing the future of its old railway station, residents brought very different hopes to the first meeting. Young musicians wanted rehearsal rooms, older neighbors wanted a welcoming place to meet, and several volunteer groups needed space for exhibitions. Instead of choosing a complete design at once, they agreed to run a trial for three months. Volunteers furnished the rooms with borrowed tables, kept a shared calendar, and collected short comments after every event. The trial showed that many wishes could coexist. Readings took place in the afternoon, music rehearsals followed in the evening, and a small side room offered privacy for advice sessions. The hardest questions concerned heating, cleaning, and reliable opening hours. A working group recorded expenses and discussed practical options with the council. By the end, nobody claimed to have a perfect plan. They did have direct experience, a realistic budget, and a growing number of people who already felt responsible for the building. That shared knowledge made the next decision much easier and helped everyone understand why a small experiment had been useful.",
  "Show me all changes recorded since last Tuesday, including the notes that still require review.",
  "A curious brain explores the world with care: 🧠 🌍 🚲.",
];

/** Corpus input only: no model-derived data. IDs are stable references used by all other recordings. */
export function buildSentences() {
  assert.equal(GERMAN.length, 25); assert.equal(ENGLISH.length, 25);
  const normal = [...GERMAN.map(text => ({ language: "de", text })), ...ENGLISH.map(text => ({ language: "en", text }))];
  return [...normal.map(row => ({ ...row, kind: "normal" })),
    { language: "en", kind: "over-cap", text: "memory ".repeat(10_000) },
    { language: "de", kind: "nfd", text: "Für schöne Grüße übt Jörg täglich das sorgfältige Lesen überfüllter Bücherregale.".normalize("NFD") },
    { language: "de", kind: "compound", text: "Die Donaudampfschifffahrtsgesellschaftskapitänsanwärterin prüft den Kraftfahrzeughaftpflichtversicherungsnachweis im Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverfahren." },
  ].map((row, id) => ({ id, ...row }));
}

/** A shortest tested decimal spelling that round trips a finite IEEE-754 float32. */
export function f32Decimal(input) {
  const value = Math.fround(input);
  if (!Number.isFinite(value)) throw new Error("recorded vector components must be finite float32 values");
  if (Object.is(value, -0)) return "-0";
  const candidates = new Set([String(value)]);
  const compact = text => {
    let [mantissa, exponent] = text.split("e");
    if (mantissa.includes(".")) mantissa = mantissa.replace(/0+$/u, "").replace(/\.$/u, "");
    return mantissa + (exponent === undefined ? "" : `e${Number(exponent)}`);
  };
  for (let precision = 1; precision <= 9; precision++) {
    for (const source of [value.toPrecision(precision), value.toExponential(precision - 1)]) {
      const text = compact(source);
      if (Object.is(Math.fround(Number(text)), value)) {
        candidates.add(text); candidates.add(JSON.stringify(Number(text)));
      }
    }
  }
  return [...candidates].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/** Float32Array explicitly marks vector data; integer IDs and sigmoid scores retain their JSON number values. */
export function stringifyRecording(value) {
  return `${JSON.stringify(value, (_key, item) => item instanceof Float32Array
    ? Array.from(item, number => JSON.rawJSON(f32Decimal(number))) : item)}\n`;
}

/** No NC access, even a tokenizer metadata fetch, happens before these two explicit test guards. */
export function assertJinaConsent(environment) {
  if (environment.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") throw new Error("--jina requires PLUR1BUS_ALLOW_TEST_INTERNALS=1 before any NC model access");
  if (environment.PLUR1BUS_TEST_ACCEPT_NC_MODELS !== "1") throw new Error("--jina requires explicit PLUR1BUS_TEST_ACCEPT_NC_MODELS=1 before any NC model access");
}

const inside = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };

/** NC outputs require a caller-named temporary destination outside the worktree. */
export function assertOutputDirectory({ mode, repositoryRoot, outputDir, explicit }) {
  if (mode !== "--jina") return;
  if (!explicit) throw new Error("--jina requires an explicit --output-dir in the system temporary directory");
  if (inside(repositoryRoot, outputDir) || !inside(tmpdir(), outputDir)) throw new Error("--jina output directory must be temporary and outside the repository");
}

/** Reuse Node's pinned artifact verifier/downloader with only tokenizer metadata selected. */
export function metadataOnlyProfile(profile) {
  const artifacts = profile.artifacts.filter(artifact => METADATA.has(artifact.path));
  for (const path of ["tokenizer.json", "tokenizer_config.json"]) assert.ok(artifacts.some(row => row.path === path), `missing pinned ${path}`);
  return { ...profile, artifacts };
}

/** Invoke the real tokenizer with special tokens and no truncation, then cut completed arrays. */
export async function encodeThenCut(tokenizer, text, cap, textPair) {
  assert.ok(Number.isSafeInteger(cap) && cap > 0, "tokenizer cap must be a positive integer");
  const full = await tokenizer(text, { add_special_tokens: true, truncation: false, padding: false,
    return_tensor: false, ...(textPair === undefined ? {} : { text_pair: textPair }) });
  const ids = Array.from(full.input_ids, Number), mask = Array.from(full.attention_mask, Number);
  assert.equal(ids.length, mask.length); assert.ok(ids.every(Number.isSafeInteger));
  const input_ids = ids.slice(0, cap), attention_mask = mask.slice(0, cap);
  return { input_ids, attention_mask, fullLength: ids.length, fullLastTokenId: ids.at(-1),
    truncated: ids.length > cap, closingTokenLost: ids.length > cap && input_ids.at(-1) !== ids.at(-1) };
}

async function writeSmall(directory, name, value) {
  const text = stringifyRecording(value);
  if (Buffer.byteLength(text) >= MAX_BYTES) throw new Error(`${name} exceeds the strict 1 MB recording limit`);
  await writeFile(join(directory, name), text);
}

async function writeCases(directory, name, metadata, cases) {
  const chunks = []; let current = [];
  const overhead = Buffer.byteLength(stringifyRecording({ ...metadata, cases: [] }));
  let currentBytes = overhead;
  for (const row of cases) {
    const rowBytes = Buffer.byteLength(stringifyRecording(row)) - 1;
    if (currentBytes + rowBytes + (current.length ? 1 : 0) >= MAX_BYTES) {
      if (current.length === 0) throw new Error(`${name}: a single case exceeds 1 MB`);
      chunks.push(current); current = []; currentBytes = overhead;
    }
    currentBytes += rowBytes + (current.length ? 1 : 0); current.push(row);
  }
  if (current.length || chunks.length === 0) chunks.push(current);
  const parts = [];
  for (let index = 0; index < chunks.length; index++) {
    const file = index === 0 ? name : name.replace(/\.json$/u, `-extra-${index}.json`);
    await writeSmall(directory, file, { ...metadata, cases: chunks[index] }); parts.push(file);
  }
  if (parts.length > 1) await writeSmall(directory, name.replace(/\.json$/u, ".index.json"), { ...metadata, parts });
}

async function loadTransformers(context) {
  if (context.transformers) return context.transformers;
  const require = createRequire(join(context.engineRoot, "package.json"));
  const entry = require.resolve("@huggingface/transformers");
  const pkg = JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8"));
  assert.equal(pkg.version, "4.3.1", "model recordings must use the engine's exact Transformers.js 4.3.1");
  const { importTransformersBehindSharpProbe } = await context.importEngine("lib/native/sharp-unavailable.js");
  context.transformers = await importTransformersBehindSharpProbe({});
  return context.transformers;
}

async function modelContext(context) {
  const catalogue = await context.importEngine("lib/providers/local-model-artifacts.js");
  const cacheDir = context.environment.PLUR1BUS_MODELS_CACHE;
  if (!cacheDir || !isAbsolute(cacheDir)) throw new Error("PLUR1BUS_MODELS_CACHE must name an explicit absolute external model cache directory");
  if (inside(context.repositoryRoot, cacheDir)) throw new Error("PLUR1BUS_MODELS_CACHE must remain outside the repository");
  await mkdir(cacheDir, { recursive: true });
  if (inside(await realpath(context.repositoryRoot), await realpath(cacheDir))) throw new Error("PLUR1BUS_MODELS_CACHE must resolve outside the repository");
  return { ...context, catalogue, cacheDir: resolve(cacheDir) };
}

function profileFor(context, model) {
  const profile = context.catalogue.pinnedLocalModelProfile(model);
  assert.ok(profile, `Node pin has no verified profile for ${model}`); return profile;
}

/** The one licence receipt accepted for BGE goldens: the conversion has no LICENSE file of its own, so the owner
 * decided (2026-10-29) that the original's Apache-2.0 applies, proven by its pinned model card and the licence text. */
const BGE_LICENCE_RECEIPT = Object.freeze({
  version: 1, model: BGE, revision: "c44ebc43de724ae8816668bb44d2e728e17faa18",
  upstream: { repository: "BAAI/bge-reranker-v2-m3", revision: "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e", file: "README.md",
    url: "https://huggingface.co/BAAI/bge-reranker-v2-m3/resolve/953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e/README.md",
    size: 17229, sha256: "c887aa6dd2598f908bf0582ca7068cc816585c7a1b6a07df305b631ede0cb174", declares: "license: apache-2.0" },
  license: "Apache-2.0",
  licenseText: { file: "Apache-2.0.txt", url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
    sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" },
});

/** Reads the committed receipt and licence text that `assertBgeLicence` checks. */
export async function readBgeLicence(fixtureDir) {
  const directory = join(fixtureDir, "licences");
  const receipt = JSON.parse(await readFile(join(directory, "bge-reranker-v2-m3.json"), "utf8"));
  const text = await readFile(join(directory, BGE_LICENCE_RECEIPT.licenseText.file));
  return { receipt, text };
}

export function assertBgeLicence(profile, licence) {
  // A flag, a claimed licence or a LICENSE row in the catalogue cannot replace the exact receipt: the pinned
  // conversion, the original's pinned model card and the byte-exact licence text.
  const { decision: _decision, ...receipt } = licence?.receipt ?? {};
  const exact = profile?.model === BGE_LICENCE_RECEIPT.model && profile?.revision === BGE_LICENCE_RECEIPT.revision
    && isDeepStrictEqual(receipt, BGE_LICENCE_RECEIPT) && typeof licence?.receipt?.decision === "string"
    && Buffer.isBuffer(licence?.text) && createHash("sha256").update(licence.text).digest("hex") === BGE_LICENCE_RECEIPT.licenseText.sha256;
  if (!exact) {
    throw new Error(`refusing BGE-derived goldens: ${profile?.model}@${profile?.revision} has no verified pinned LICENSE artifact or licence receipt; resolve the repository licence before recording`);
  }
}

const documentText = text => text.trim().split(/\s+/u).filter(Boolean).slice(0, 150).join(" ");
const pairsFor = sentences => sentences.slice(0, 50).map((row, index) => ({ id: index, queryId: row.id, docId: (index + 1) % 50 }));

/** Record actual provider ordering/top-N for a single query with several normal documents. */
export async function recordRerankerRankingCases(provider, sentences) {
  const normal = sentences.filter(row => row.kind === "normal");
  assert.ok(normal.length >= 5, "reranker ranking recordings need five normal documents");
  const cases = [], topN = 3;
  for (const start of [0, Math.floor(normal.length / 2)]) {
    const query = normal[start];
    const documents = Array.from({ length: 5 }, (_value, offset) => normal[(start + offset) % normal.length]);
    const recorded = await provider.rerank(query.text, documents.map(row => documentText(row.text)), topN);
    assert.equal(recorded.length, topN, "reranker returned the wrong top-N cardinality");
    const seen = new Set();
    const hits = recorded.map(hit => {
      assert.ok(Number.isSafeInteger(hit.index) && hit.index >= 0 && hit.index < documents.length && !seen.has(hit.index), "reranker returned an invalid or duplicate document index");
      seen.add(hit.index);
      const score = hit.score ?? hit.relevance_score;
      assert.ok(Number.isFinite(score), "reranker returned a non-finite score");
      return { index: hit.index, score };
    });
    cases.push({ queryId: query.id, docIds: documents.map(row => row.id), topN, hits });
  }
  return cases;
}

async function ensureTokenizer(context, profile, accepted = false) {
  await context.catalogue.ensurePinnedModelArtifacts(metadataOnlyProfile(profile), context.cacheDir, { acceptNonCommercialLicense: accepted, signal: AbortSignal.timeout(120_000) });
  const mod = await loadTransformers(context);
  return mod.AutoTokenizer.from_pretrained(profile.model, { cache_dir: context.cacheDir, revision: profile.revision, local_files_only: true });
}

async function recordTokenModel(context, profile, sentences, { accepted = false, reranker = false } = {}) {
  const tokenizer = await ensureTokenizer(context, profile, accepted);
  const truncationLen = reranker || profile.model === E5 ? tokenizer.model_max_length : profile.maxTokens ?? 512;
  assert.ok(Number.isSafeInteger(truncationLen) && truncationLen > 0, `invalid model_max_length for ${profile.model}`);
  const cases = [];
  if (reranker) {
    for (const pair of [...pairsFor(sentences), { id: 50, queryId: 0, docId: 50 }]) {
      const document = pair.docId === 50 ? sentences[50].text : documentText(sentences[pair.docId].text);
      cases.push({ ...pair, kind: "pair", ...await encodeThenCut(tokenizer, sentences[pair.queryId].text, truncationLen, document) });
    }
  } else {
    for (const row of sentences) for (const kind of ["query", "passage"]) {
      const prefix = profile[`${kind}Prefix`] ?? `${kind}: `;
      const encoded = await encodeThenCut(tokenizer, prefix + row.text, truncationLen);
      if (row.kind === "over-cap") assert.ok(encoded.fullLength > 8192 && encoded.closingTokenLost, "over-cap input must exceed every profile cap and lose its closing special token");
      if (row.kind === "normal" && row.text) assert.ok(encoded.fullLength <= 400, `normal sentence ${row.id} exceeds 400 tokens for ${profile.model}`);
      cases.push({ id: row.id, kind, ...encoded });
    }
  }
  const result = { model: profile.model, revision: profile.revision, dtype: profile.dtype ?? (reranker ? "q8" : "float32"), role: reranker ? "reranker" : "embedding",
    tokenizerSha256: profile.artifacts.find(row => row.path === "tokenizer.json").sha256, truncationLen,
    ...(reranker ? {} : { queryPrefix: profile.queryPrefix ?? "query: ", passagePrefix: profile.passagePrefix ?? "passage: " }), cases };
  if (profile.model === JINA5) {
    const previous = tokenizer.padding_side; result.paddingCases = [];
    try { for (const paddingSide of ["left", "right"]) {
      tokenizer.padding_side = paddingSide;
      const encoded = await tokenizer(["Query: short text", "Query: this is a somewhat longer input sentence"], { add_special_tokens: true, truncation: false, padding: true, return_tensor: false });
      result.paddingCases.push({ paddingSide, input_ids: encoded.input_ids, attention_mask: encoded.attention_mask,
        lastAttendedIndices: encoded.attention_mask.map(mask => mask.findLastIndex(value => Number(value) === 1)) });
    } } finally { tokenizer.padding_side = previous; }
  }
  return result;
}

async function recordEmbedding(context, profile, sentences, file, { accepted = false, observations } = {}) {
  await context.catalogue.ensurePinnedModelArtifacts(profile, context.cacheDir, { acceptNonCommercialLicense: accepted, signal: AbortSignal.timeout(120_000) });
  const { LocalTransformersEmbeddingProvider } = await context.importEngine("lib/providers/embedding-local-transformers.js");
  const mod = await loadTransformers(context);
  const dimensions = profile.outputDimensions ?? 384;
  const load = async () => {
    if (!observations || profile.model !== JINA3) return mod;
    return { ...mod, AutoModel: { from_pretrained: async (...args) => {
      const model = await mod.AutoModel.from_pretrained(...args);
      return new Proxy(model, { apply(target, thisArg, args) {
        observations.taskIds.push({ ...observations.current, task_id: Array.from(args[0].task_id.data, Number) });
        return Reflect.apply(target, thisArg, args);
      } });
    } } };
  };
  const options = { model: profile.model, revision: profile.revision, dimensions, cacheDir: context.cacheDir,
    ...(profile.dtype ? { dtype: profile.dtype } : {}), ...(profile.runtime === "embeddinggemma-2" ? { maxBatchSize: 1 } : {}),
    embeddingCacheEnabled: false, acceptNonCommercialLicense: accepted, loadTransformers: load };
  const provider = new LocalTransformersEmbeddingProvider(options);
  const cases = [];
  try {
    for (const row of sentences) {
      if (observations) observations.current = { id: row.id, kind: "query" };
      const query = new Float32Array(await provider.embedQuery(row.text));
      if (observations) observations.current = { id: row.id, kind: "passage" };
      const passage = new Float32Array(await provider.embedPassage(row.text));
      assert.equal(query.length, dimensions); assert.equal(passage.length, dimensions);
      cases.push({ id: row.id, query, passage });
    }
  } finally { await provider.shutdown(); }
  await writeCases(context.outputDir, file, { nodeCommit: context.nodeCommit, model: profile.model,
    revision: profile.revision, dtype: profile.dtype ?? "float32", dimensions }, cases);
  return { model: profile.model, identity: provider.identity };
}

async function recordReranker(context, profile, sentences, file, accepted = false) {
  await context.catalogue.ensurePinnedModelArtifacts(profile, context.cacheDir, { acceptNonCommercialLicense: accepted, signal: AbortSignal.timeout(120_000) });
  const { LocalTransformersRerankerProvider } = await context.importEngine("lib/providers/reranker-local-transformers.js");
  const provider = new LocalTransformersRerankerProvider({ model: profile.model, revision: profile.revision, dtype: profile.dtype ?? "q8", cacheDir: context.cacheDir,
    loadTransformers: () => loadTransformers(context), ensureModelArtifacts: (value, cache, options) => context.catalogue.ensurePinnedModelArtifacts(value, cache, { ...options, acceptNonCommercialLicense: accepted }) });
  const pairs = []; let rankingCases;
  try { for (const pair of pairsFor(sentences)) {
    const hits = await provider.rerank(sentences[pair.queryId].text, [documentText(sentences[pair.docId].text)], 1);
    assert.equal(hits.length, 1); const score = hits[0].score ?? hits[0].relevance_score;
    assert.ok(Number.isFinite(score), "reranker returned a non-finite score"); pairs.push({ ...pair, score });
  }
    rankingCases = await recordRerankerRankingCases(provider, sentences);
  } finally { await provider.shutdown(); }
  await writeSmall(context.outputDir, file, { nodeCommit: context.nodeCommit, model: profile.model, revision: profile.revision,
    dtype: profile.dtype ?? "q8", docWordCap: 150, pairs, rankingCases, order: [...pairs].sort((a, b) => b.score - a.score || a.id - b.id).map(row => row.id) });
}

/** Model modes use the resolution/pin context of record.mjs, never a package-store path. */
export async function recordModels(context, mode, { outputDir, explicitOutputDir = false } = {}) {
  const environment = context.environment ?? process.env;
  outputDir = resolve(outputDir ?? context.fixtureDir);
  if (mode === "--jina") assertJinaConsent(environment);
  assertOutputDirectory({ mode, repositoryRoot: context.repositoryRoot, outputDir, explicit: explicitOutputDir });
  await mkdir(outputDir, { recursive: true });
  // Resolve symlinks too: a /tmp alias must not publish NC results back into the repository.
  assertOutputDirectory({ mode, repositoryRoot: await realpath(context.repositoryRoot), outputDir: await realpath(outputDir), explicit: explicitOutputDir });
  const sentences = buildSentences();
  if (mode === "--sentences") { await writeSmall(outputDir, "sentences.json", { nodeCommit: context.nodeCommit, normalCount: 50, cases: sentences }); return; }
  context = await modelContext({ ...context, environment, outputDir });
  if (mode === "--bge") {
    const profile = profileFor(context, BGE); assertBgeLicence(profile, await readBgeLicence(context.fixtureDir));
    await recordReranker(context, profile, sentences, "bge-scores.json");
    await writeSmall(outputDir, "token-ids-bge.json", { nodeCommit: context.nodeCommit, models: [await recordTokenModel(context, profile, sentences, { reranker: true })] }); return;
  }
  if (mode === "--e5" || mode === "--gemma") {
    const model = mode === "--e5" ? E5 : GEMMA;
    const profile = profileFor(context, model);
    const identity = await recordEmbedding(context, profile, sentences, mode === "--e5" ? "e5-small.json" : "embeddinggemma-2.json");
    if (mode === "--gemma") {
      await writeSmall(outputDir, "identity-embeddinggemma-2-runtime.json", { nodeCommit: context.nodeCommit, ...identity });
      await writeSmall(outputDir, "token-ids-gemma.json", { nodeCommit: context.nodeCommit, models: [await recordTokenModel(context, profile, sentences)] });
    }
    return;
  }
  if (mode === "--token-ids") {
    const models = [];
    for (const model of [E5, GEMMA]) models.push(await recordTokenModel(context, profileFor(context, model), sentences));
    await writeSmall(outputDir, "token-ids.json", { nodeCommit: context.nodeCommit, models,
      excludedModels: [{ model: BGE, reason: "recorded-by-bge-mode-in-token-ids-bge" }, { model: JINA3, reason: "NC-results-require-jina-temp-mode" }, { model: JINA5, reason: "NC-results-require-jina-temp-mode" }, { model: JINA_RERANK, reason: "NC-results-require-jina-temp-mode" }] }); return;
  }
  if (mode === "--jina") {
    await writeSmall(outputDir, "sentences.json", { nodeCommit: context.nodeCommit, normalCount: 50, cases: sentences });
    const identities = [], models = [], observations = { taskIds: [], current: null }, prefixChecks = [];
    for (const [model, file] of [[JINA3, "jina-v3.json"], [JINA5, "jina-v5.json"]]) {
      const profile = profileFor(context, model);
      identities.push(await recordEmbedding(context, profile, sentences, file, { accepted: true, observations }));
      models.push(await recordTokenModel(context, profile, sentences, { accepted: true }));
      if (model === JINA5) {
        const { LocalTransformersEmbeddingProvider } = await context.importEngine("lib/providers/embedding-local-transformers.js");
        assert.throws(() => new LocalTransformersEmbeddingProvider({ model, dimensions: profile.outputDimensions, queryPrefix: "", passagePrefix: "", acceptNonCommercialLicense: true }), /requires queryPrefix/u);
        prefixChecks.push({ model, nonProfilePrefixRejected: true });
      }
    }
    const rerank = { ...profileFor(context, JINA_RERANK), commercialUse: false, license: "CC-BY-NC-4.0" };
    await recordReranker(context, rerank, sentences, "jina-reranker.json", true);
    models.push(await recordTokenModel(context, rerank, sentences, { accepted: true, reranker: true }));
    assert.equal(observations.taskIds.length, sentences.length * 2, "every Jina v3 call must record its actual task_id tensor");
    const taskAdaptations = profileFor(context, JINA3).taskAdaptations;
    for (const row of observations.taskIds) assert.deepEqual(row.task_id, [taskAdaptations.indexOf(`retrieval.${row.kind}`)]);
    await writeSmall(outputDir, "identities-jina.json", { nodeCommit: context.nodeCommit, identities, taskIds: observations.taskIds, taskAdaptations, prefixChecks });
    await writeSmall(outputDir, "token-ids-jina.json", { nodeCommit: context.nodeCommit, models }); return;
  }
  throw new Error(`unsupported model recorder mode: ${mode}`);
}
