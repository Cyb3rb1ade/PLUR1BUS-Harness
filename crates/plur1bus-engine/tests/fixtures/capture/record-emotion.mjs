// RE-05/T3 emotion recordings and production vocabulary extraction from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned emotion source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}
const files = ["lib/emotion-score.js", "lib/emotion-blends.js", "lib/tier1-lexicon.js", "lib/tier2-transformer.js",
  "lib/tier3-llm.js", "lib/emotion-engine.js", "lib/emotion.js", "lib/emotional-state.js", "lib/encoding-llm.js"];
for (const file of files) verify(file);
const load = (file) => import(pathToFileURL(path.join(root, file)));
async function constants(file, names) {
  // Only append exports to verified source. Rewrite relative imports so the data URL loads the same pinned dependencies.
  const source = readFileSync(path.join(root, file), "utf8").replace(/(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_, start, relative, end) => `${start}${pathToFileURL(path.resolve(root, path.dirname(file), relative))}${end}`);
  const instrumented = `${source}\nexport { ${names.join(", ")} };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(instrumented).toString("base64")}`);
}
const [scoreApi, blendApi, tier1Api, tier2Api, tier3Api, engineApi, legacyApi, stateApi, encodingApi,
  tier1Data, tier2Data, blendData] = await Promise.all([
  ...files.map(load),
  constants(files[2], ["LEXICON_EN", "LEXICON_DE", "EMOTION_VAD", "NUANCE_VAD"]),
  constants(files[3], ["XLM_EMO_LABELS", "EMOTION_VAD_T2", "FALLBACK_KEYWORDS"]),
  constants(files[1], ["BLEND_RULES"]),
]);
const provenance = { engine: "node", commit: PIN, node: process.version,
  sourceHashes: Object.fromEntries([...verified].sort(([a], [b]) => a.localeCompare(b))) };
const here = path.dirname(fileURLToPath(import.meta.url));
const rootCapture = path.resolve(here, "../../../src/capture");
const words = tier2Api.Tier2TransformerClassifier.prototype._detectLanguage.toString()
  .match(/const germanMarkers = (\[[\s\S]*?\]);/)[1];
const germanMarkers = Function(`"use strict"; return (${words});`)();
if (process.argv.includes("--write-data")) {
  const [tier3Data, encodingData, stateData] = await Promise.all([
    constants(files[4], ["SYSTEM_PROMPT"]), constants(files[8], ["SYSTEM_PROMPT"]),
    constants(files[7], ["BASELINE_MOOD", "DECAY_HALF_LIFE_MS", "NUANCE_DECAY_HALF_LIFE_MS", "DEFAULT_DECAY_MS"]),
  ]);
  const objectFromFunction = (fn, pattern) => Function(`"use strict"; return (${fn.toString().match(pattern)[1]});`)();
  const emoji = objectFromFunction(legacyApi.emotionEmoji, /const map = (\{[\s\S]*?\n  \});/);
  const hints = objectFromFunction((await constants(files[7], ["textValenceHint"])).textValenceHint,
    /const patterns = (\{[\s\S]*?\n  \});/);
  const moodLabels = objectFromFunction(stateApi.EmotionalState.prototype.describeMood,
    /const dominantDe = (\{[\s\S]*?\})\[/);
  const nuanceLabels = objectFromFunction(stateApi.EmotionalState.prototype.describeMood,
    /const nuanceDe = (\{[\s\S]*?\})\[/);
  mkdirSync(path.join(rootCapture, "data"), { recursive: true });
  const data = { provenance, lexiconEn: tier1Data.LEXICON_EN, lexiconDe: tier1Data.LEXICON_DE,
    baseVad: tier1Data.EMOTION_VAD, nuanceVad: tier1Data.NUANCE_VAD,
    tier2Labels: tier2Data.XLM_EMO_LABELS, tier2Vad: tier2Data.EMOTION_VAD_T2,
    tier2Keywords: tier2Data.FALLBACK_KEYWORDS, germanMarkers, blendRules: blendData.BLEND_RULES,
    tier3SystemPrompt: tier3Data.SYSTEM_PROMPT, encodingSystemPrompt: encodingData.SYSTEM_PROMPT,
    encodingPromptPrefix: encodingApi.buildEncodingPrompt(""), baselineMood: stateData.BASELINE_MOOD,
    decayHalfLifeMs: stateData.DECAY_HALF_LIFE_MS, nuanceDecayHalfLifeMs: stateData.NUANCE_DECAY_HALF_LIFE_MS,
    defaultDecayMs: stateData.DEFAULT_DECAY_MS, temperaments: stateApi.TEMPERAMENT_PRESETS,
    defaultTemperaments: stateApi.DEFAULT_TEMPERAMENTS, emoji, moodLabels, nuanceLabels,
    stateHints: Object.fromEntries(Object.entries(hints).map(([key, expression]) => [key, expression.source])) };
  writeFileSync(path.join(rootCapture, "data/emotion-lexicon.json"), `${JSON.stringify(data, null, 2)}\n`);
}

const realDate = Date;
let currentNow = 1_710_000_000_000;
globalThis.Date = class FixedDate extends realDate {
  constructor(...args) { super(...(args.length ? args : [currentNow])); }
  static now() { return currentNow; }
};
const raw = (value) => JSON.stringify(value);
const scoreView = (score) => score === null ? null : { dictLine: raw(score.toDict()),
  vectorLine: raw(Array.from(score.toVadVector())), highIntensity: score.isHighIntensity,
  ambivalent: score.isAmbivalent, effectiveLabel: score.effectiveLabel, activeLine: raw(score.activeEmotions),
  unrounded: { valence: score.valence, arousal: score.arousal, dominance: score.dominance, intensity: score.intensity,
    confidence: score.confidence, labels: Object.entries(score.emotion_labels) } };
const output = { score: [], tier1: [], tier2: [], blends: [], engine: [], legacy: [], encoding: [], state: [] };
try {
  for (const input of [{}, { valence: -0.12345, arousal: 0.99999, dominance: 0.2, intensity: 0.6,
    confidence: 0.12345, emotion_labels: { joy: 0.10001, sadness: 0.3, trust: 0.3 },
    primary_emotion: "sadness", secondary_emotion: "trust", source: "assistant", language: "de",
    nuances: [{ label: "hope", intensity: 0.2, confidence: 0.4 }], blend_factors: { joy: 0.12345 } },
    { valence: 1.1 }, { intensity: -0.01 }, { confidence: 1.01 },
    { nuances: [{ label: "bad", intensity: 1.1 }] }, { complex_emotion: { label: "bad", confidence: -1 } },
    { timestamp: "2024-01-02T03:04:05.006Z", primary_emotion: "neutral", nuances: [{ label: "curiosity" }] }]) {
    try { output.score.push({ input, ok: true, result: scoreView(new scoreApi.EmotionScore(input)) }); }
    catch { output.score.push({ input, ok: false }); }
  }
  const tier1Cases = ["", "1234 😀", "The build is ready for shipping.", "happy glad joyful", "sad angry", "love grateful proud",
    "Ich bin glücklich und hoffnungsvoll.", "Ich bin glücklich und glücklich.", "İYİ glücklich", "nostalgic sad trust remember childhood",
    "angry disgusted pathetic deserved", "afraid scared terrified", "safe happy finally", "fine normal usual okay"];
  for (const [language, lexicon] of [["en", tier1Data.LEXICON_EN], ["de", tier1Data.LEXICON_DE]]) {
    for (const word of Object.keys(lexicon)) tier1Cases.push(word);
  }
  for (const text of tier1Cases) {
    const classifier = new tier1Api.Tier1LexiconClassifier();
    output.tier1.push({ text, options: {}, source: "user", result: scoreView(classifier.classify(text)) });
  }
  const custom = { customEn: { codexword: "joy" }, customDe: { codexword: "sadness" } };
  output.tier1.push({ text: "codexword", options: custom, source: "assistant",
    result: scoreView(new tier1Api.Tier1LexiconClassifier(custom).classify("codexword", "assistant")) });
  for (const text of ["", "1234 😀", "The build is ready for shipping.", "happy", "happy happy happy sad", "love love love love love",
    "ich sie happy ", "ich happy sie", "der die das happy", "Der ist glücklich und froh.", "gross sick übel", "angry joy scared surprised",
    "Überraschung plötzlich wow", "Ich bin glücklich und glücklich."]) {
    const classifier = new tier2Api.Tier2TransformerClassifier();
    await classifier.loadModel();
    output.tier2.push({ text, source: "user", modelRemainsAbsent: classifier._session === null,
      result: scoreView(classifier.classify(text)) });
  }
  for (const rule of blendData.BLEND_RULES) {
    for (const trigger of [true, false]) {
      const labels = Object.fromEntries(rule.requiredEmotions.map((label) => [label, 0.4]));
      const text = trigger ? rule.semanticTriggers[0] : "public fixture sentence";
      const context = rule.transitionFrom ? { previous_top_emotion: rule.transitionFrom } : null;
      output.blends.push({ labels, text, context, line: raw(blendApi.detectBlend(labels, text, context)) });
    }
  }
  const fixtureAnswer = raw({ valence: 0.5, arousal: 0.2, dominance: 0.1, intensity: 0.6,
    primary_emotion: "joy", secondary_emotion: "trust", emotion_labels: { joy: 0.7, trust: 0.3 }, confidence: 0.92, language: "en" });
  const pending = [];
  const routingCases = [
    { name: "default-no-provider", text: "plain ordinary sentence", config: {} },
    { name: "t2-disabled", text: "plain ordinary sentence", config: { tier2: { enabled: false } } },
    { name: "force-t1-fallback", text: "plain ordinary sentence", forceTier: 1, config: {} },
    { name: "force-t2-disabled", text: "happy", forceTier: 2, config: { tier2: { enabled: false } } },
    { name: "force-t3-disabled", text: "happy", forceTier: 3, config: { tier3: { enabled: false } } },
    { name: "force-t3-no-provider", text: "happy", forceTier: 3, config: { tier3: { enabled: true } } },
    { name: "force-t3-fixture", text: "A public fixture needs an emotional judgment.", forceTier: 3, provider: "fixture", config: {} },
    { name: "auto-escalate", text: "plain ordinary sentence", provider: "fixture", config: {} },
    { name: "auto-skip-t3", text: "plain ordinary sentence", provider: "fixture", skipTier3: true, config: {} },
    { name: "auto-t3-disabled", text: "plain ordinary sentence", provider: "fixture", config: { tier3: { enabled: false } } },
    { name: "provider-failure", text: "An ordinary public sentence for an unavailable endpoint.", provider: "reject", config: {} },
    { name: "malformed-answer", text: "An ordinary public sentence for malformed response.", provider: "malformed", config: {} },
    { name: "threshold-zero", text: "plain ordinary sentence", provider: "fixture", config: { escalationConfidence: 0 } },
    { name: "threshold-one", text: "sad angry", provider: "fixture", config: { escalationConfidence: 1 } },
    { name: "t1-high-confidence", text: "happy joyful", provider: "fixture", config: {} },
    { name: "timeout", text: "An ordinary public sentence awaiting delayed fixture completion.", provider: "delayed", config: { tier3: { timeoutMs: 1 } } },
    { name: "timeout-zero-immediate", text: "plain ordinary sentence", provider: "fixture", config: { tier3: { timeoutMs: 0 } } },
  ];
  const llm = {};
  for (const scenario of routingCases) {
    const calls = [];
    const config = { ...scenario.config, tier3: { ...scenario.config.tier3 } };
    if (scenario.provider) config.tier3.callLlm = async (messages) => {
      const promptLine = raw(messages);
      const hash = digest(promptLine);
      calls.push({ hash, promptLine });
      if (scenario.provider === "reject") throw new Error("fixture transport failure");
      const answer = scenario.provider === "malformed" ? "invalid fixture answer" : fixtureAnswer;
      llm[hash] = { promptLine, answer };
      if (scenario.provider === "delayed") {
        const work = new Promise((resolve) => setTimeout(resolve, 20));
        pending.push(work);
        await work;
      }
      return answer;
    };
    const engine = new engineApi.EmotionEngine(config);
    try {
      const score = await engine.analyze(scenario.text, "user", scenario.forceTier ?? null, { skipTier3: scenario.skipTier3 === true });
      output.engine.push({ ...scenario, result: scoreView(score), calls, statsLine: raw(engine.stats) });
    } catch {
      output.engine.push({ ...scenario, rejected: true, calls });
    }
  }
  await Promise.all(pending);
  const engine = new engineApi.EmotionEngine({ tier2: { enabled: false }, tier3: { enabled: false } });
  const sequence = [];
  for (const text of ["afraid scared terrified", "happy safe finally", "sad trust once past"]) {
    sequence.push({ text, result: scoreView(await engine.analyze(text, "user", 1)) });
  }
  output.sequence = sequence;
  for (const text of ["happy joyful", "afraid scared", "plain ordinary sentence", "love grateful proud", "nostalgic sad remember childhood"]) {
    legacyApi.setEmotionConfig({ t2: { enabled: false }, t3: { enabled: false } });
    const value = legacyApi.inferEmotionalValence(text);
    output.legacy.push({ text, line: raw(value), serialized: legacyApi.serializeEmotionalValence(value),
      deserializedLine: raw(legacyApi.deserializeEmotionalValence(legacyApi.serializeEmotionalValence(value))) });
  }
  for (const rawAnswer of [fixtureAnswer,
    raw({ importance: 0.99, intensity: 0.8, dominant: "disgust", emotions: { trust: 0.7, anger: 0.9 }, reason: "fixture judgment" }),
    raw({ importance: null }), raw({ importance: 0.4, intensity: "bad", dominant: "absent", emotions: { joy: -2, fear: 4 } }),
    "```json\n{\"importance\":0.5,\"intensity\":0.3,\"dominant\":\"joy\"}\n```", "invalid fixture answer"]) {
    output.encoding.push({ input: rawAnswer, line: raw(encodingApi.parseEncodingResponse(rawAnswer)) });
  }
  output.encodingPrompts = [];
  for (const text of ["A public fixture memory.", "x".repeat(1999) + "😀", "x".repeat(1998) + "😀", "cut\ud83d"]) {
    let captured;
    await encodingApi.classifyEncoding(text, { callLlm: async (messages) => { captured = messages; return "{}"; } });
    const promptLine = raw(captured);
    output.encodingPrompts.push({ input: text, truncatedLine: raw(encodingApi.truncateForPrompt(text)),
      promptLine, promptHash: digest(promptLine) });
  }
  for (const options of [{}, { sensitivity: 1.5, decayMultiplier: 1.3, blendFactor: 0.7, moodInfluence: 0.5 },
    { sensitivity: 0, decayMultiplier: -1, blendFactor: 2, moodInfluence: -1 }]) {
    currentNow = 1_710_000_000_000;
    const state = new stateApi.EmotionalState(options);
    const steps = [{ op: "initial", stateLine: raw(state.serializeState()), moodLine: raw(state.describeMood()), snapshotLine: raw(state.snapshot()) }];
    const value = { joy: 0.8, trust: 0.4, emotionalIntensity: 0.7, nuances: [{ label: "shame", intensity: 0.6 }] };
    state.applyEmotionScore(value);
    steps.push({ op: "apply", input: value, stateLine: raw(state.serializeState()), moodLine: raw(state.describeMood()), snapshotLine: raw(state.snapshot()) });
    currentNow += 13_731;
    state.decay();
    steps.push({ op: "decay", elapsed: 13_731, stateLine: raw(state.serializeState()), moodLine: raw(state.describeMood()), snapshotLine: raw(state.snapshot()) });
    const messages = [{ role: "assistant", content: "Das ist leider nicht gut, wir haben ein Problem." },
      { role: "user", content: "Super, klar, ich bin bereit und freue mich." }];
    state.updateFromMessages(messages);
    steps.push({ op: "messages", input: messages, stateLine: raw(state.serializeState()), moodLine: raw(state.describeMood()),
      moodText: stateApi.formatMoodFile(state.describeMood(), "alpha", currentNow), moodPrompt: stateApi.formatMoodLine(state.describeMood()) });
    const recalled = { anger: 0.8, trust: 0.7, fear: 0.6, emotionalIntensity: 0.9, nuances: [{ label: "resentment", intensity: 0.4 }] };
    state.updateFromRecalledMemory(recalled);
    steps.push({ op: "recalled", input: recalled, stateLine: raw(state.serializeState()), moodLine: raw(state.describeMood()),
      compatibility: state.computeMoodCompatibility(recalled), boost: state.computeRecallBoost(recalled, 0.8) });
    const scratch = mkdtempSync(path.join(tmpdir(), "emotion-state-record-"));
    try {
      const mood = state.describeMood();
      const record = { ...mood, agentId: "alpha", ts: currentNow, state: state.serializeState() };
      const filename = path.join(scratch, ".emotional-state.json");
      writeFileSync(filename, raw(record));
      const restored = new stateApi.EmotionalState(options);
      currentNow += 8_643_001;
      const hydrated = restored.hydrateOnce(filename);
      steps.push({ op: "hydrate", elapsed: 8_643_001, recordLine: readFileSync(filename, "utf8"), hydrated,
        secondHydrate: restored.hydrateOnce(filename), stateLine: raw(restored.serializeState()), moodLine: raw(restored.describeMood()) });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    output.state.push({ options, steps });
  }
  mkdirSync(path.join(here, "golden"), { recursive: true });
  mkdirSync(path.join(here, "llm"), { recursive: true });
  writeFileSync(path.join(here, "golden/emotion.json"), `${JSON.stringify({ provenance: { ...provenance,
    flags: ["--emotion"], fixedClock: 1_710_000_000_000,
    providers: "recorded synthetic answers; absent/rejected/malformed/delayed provider cases",
    disabledOptions: [], transport: "no network; pure tier2 loadModel keeps null session" }, results: output }, null, 2)}\n`);
  writeFileSync(path.join(here, "llm/emotion.json"), `${JSON.stringify({ provenance, answers: llm }, null, 2)}\n`);
  console.log(`recorded emotion: ${output.tier1.length} tier1 + ${output.tier2.length} tier2 cases; ${verified.size} verified source hashes`);
} finally { globalThis.Date = realDate; }
