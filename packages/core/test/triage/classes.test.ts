// core/triage classes and decision validation: chooseClass (the D105 rule), escalate, applyAtBoundary, resolveClass,
// validation of classifier decisions in triage()/triageWithClassifier().
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseClass, escalate, applyAtBoundary, resolveClass, triage, triageWithClassifier, ruleClassifier, MODEL_CLASSES, CLASS_TABLE, type ModelClass, type ClassDistribution, type TriageDecision } from "../../src/triage/index.ts";
import { mulberry32, taskOf, decision, fixed, classIndex } from "./helpers.ts";

const d = (small: number, medium: number, large: number, frontier: number): ClassDistribution => ({ small, medium, large, frontier });

describe("chooseClass (D105: smallest class whose above-class probability is <= threshold)", () => {
  it("the worked examples from the specification", () => {
    const k1 = d(.10, .75, .12, .03), k2 = d(.05, .45, .45, .05);
    assert.equal(chooseClass(k1), "medium"); assert.equal(chooseClass(k1, "balanced"), "medium"); assert.equal(chooseClass(k1, "quality"), "large");
    assert.equal(chooseClass(k2), "large");
  });

  it("thresholds: economy .35, balanced .2, quality .1, boundaries inclusive", () => {
    // P(above small) = .35 exactly -> small under economy only
    assert.equal(chooseClass(d(.65, .25, .08, .02), "economy"), "small");
    assert.equal(chooseClass(d(.65, .25, .08, .02), "balanced"), "medium");
    // P(above medium) = .2 exactly -> medium under balanced
    assert.equal(chooseClass(d(.3, .5, .15, .05), "balanced"), "medium");
    assert.equal(chooseClass(d(.3, .5, .15, .05), "quality"), "large");
    // P(above large) = .1 exactly -> large under quality
    assert.equal(chooseClass(d(0, .2, .7, .1), "quality"), "large");
    assert.equal(chooseClass(d(0, .2, .69, .11), "quality"), "frontier");
  });

  it("the extremes: all mass on one class", () => {
    assert.equal(chooseClass(d(1, 0, 0, 0)), "small"); assert.equal(chooseClass(d(0, 1, 0, 0)), "medium"); assert.equal(chooseClass(d(0, 0, 1, 0)), "large"); assert.equal(chooseClass(d(0, 0, 0, 1)), "frontier");
  });

  it("confidence below .5 raises the class by one, .5 and above does not, frontier is the cap", () => {
    assert.equal(chooseClass(d(1, 0, 0, 0), "balanced", .5), "small"); assert.equal(chooseClass(d(1, 0, 0, 0), "balanced", .4999), "medium");
    assert.equal(chooseClass(d(1, 0, 0, 0), "balanced", 0), "medium"); assert.equal(chooseClass(d(0, 0, 0, 1), "balanced", .1), "frontier");
    assert.equal(chooseClass(d(0, 0, 1, 0), "balanced", .3), "frontier"); assert.equal(chooseClass(d(0, 0, 1, 0), "balanced", 1), "large");
  });

  it("rejects malformed distributions: negative, NaN, infinite, missing, or not summing to 1 (tolerance 1e-6)", () => {
    for (const bad of [d(-.1, 1.1, 0, 0), d(Number.NaN, 1, 0, 0), d(Number.POSITIVE_INFINITY, 0, 0, 0), d(.5, .5, .5, 0), d(.4, .4, .1, .05), { small: 1, medium: 0, large: 0 } as never, {} as never, d(0, 0, 0, 0)]) assert.throws(() => chooseClass(bad), /invalid model class distribution/, JSON.stringify(bad));
    assert.doesNotThrow(() => chooseClass(d(.5, .5, 0, 5e-7)), "within 1e-6");
    assert.throws(() => chooseClass(d(.5, .5, 0, 2e-6)), /distribution/);
  });

  it("extra keys in the distribution are ignored", () => {
    assert.equal(chooseClass({ ...d(1, 0, 0, 0), ultra: 5 } as never), "small");
  });

  it("rejects an invalid confidence", () => {
    for (const c of [-.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => chooseClass(d(1, 0, 0, 0), "balanced", c), /invalid confidence/, String(c));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an unknown cost preference yields no class at all (undefined), neither an error nor a default", () => {
    assert.equal(chooseClass(d(1, 0, 0, 0), "cheapest" as never), undefined);
  });

  it("seeded property: matches an independent integer-percent oracle and is monotone in the cost preference and in confidence", () => {
    const SEED = 0xc1a55;
    const rnd = mulberry32(SEED);
    const pct = { economy: 35, balanced: 20, quality: 10 } as const;
    for (let i = 0; i < 1500; i++) {
      // random composition of 100 into four non-negative integers
      const cuts = [0, Math.floor(rnd() * 101), Math.floor(rnd() * 101), Math.floor(rnd() * 101), 100].sort((a, b) => a - b);
      const parts = [cuts[1]! - cuts[0]!, cuts[2]! - cuts[1]!, cuts[3]! - cuts[2]!, cuts[4]! - cuts[3]!];
      const dist = d(parts[0]! / 100, parts[1]! / 100, parts[2]! / 100, parts[3]! / 100);
      const results: Record<string, number> = {};
      for (const cost of ["economy", "balanced", "quality"] as const) {
        let expected = 3; for (let c = 0; c < 4; c++) { const above = parts.slice(c + 1).reduce((a, b) => a + b, 0); if (above <= pct[cost]) { expected = c; break; } }
        const got = classIndex(chooseClass(dist, cost));
        assert.equal(got, expected, `seed=0x${SEED.toString(16)} case=${i} ${cost} parts=${parts}`);
        assert.equal(classIndex(chooseClass(dist, cost, .3)), Math.min(3, expected + 1), `seed=0x${SEED.toString(16)} case=${i} low confidence`);
        results[cost] = got;
      }
      assert.ok(results["economy"]! <= results["balanced"]! && results["balanced"]! <= results["quality"]!, `seed=0x${SEED.toString(16)} case=${i}: cost monotonicity`);
    }
  });
});

describe("escalate and applyAtBoundary", () => {
  it("escalate raises one class once; a set flag or the frontier class changes nothing", () => {
    const up: Record<ModelClass, ModelClass> = { small: "medium", medium: "large", large: "frontier", frontier: "frontier" };
    for (const c of MODEL_CLASSES) { assert.equal(escalate(c, false), up[c]); assert.equal(escalate(c, true), c); }
  });
  it("applyAtBoundary adopts the recommendation only at a task boundary", () => {
    for (const a of MODEL_CLASSES) for (const b of MODEL_CLASSES) { assert.equal(applyAtBoundary(a, b, false), a); assert.equal(applyAtBoundary(a, b, true), b); }
  });
  it("the class order is small < medium < large < frontier", () => { assert.deepEqual([...MODEL_CLASSES], ["small", "medium", "large", "frontier"]); });
});

describe("resolveClass and the profile table", () => {
  const all = new Set(Object.entries(CLASS_TABLE).flatMap(([p, row]) => Object.values(row).map(profile => `${p}:${profile}`)));

  it("labels match the specification's examples (Haiku/Sonnet/Opus classes; 3-8b / 14-32b / 70b-plus local)", () => {
    assert.deepEqual(CLASS_TABLE["anthropic"], { small: "haiku", medium: "sonnet", large: "opus", frontier: "frontier" });
    assert.deepEqual(CLASS_TABLE["local"], { small: "3-8b", medium: "14-32b", large: "70b-plus" });
    assert.equal(CLASS_TABLE["deepseek"]!.frontier, undefined);
    for (const p of ["openai", "anthropic", "google", "xai", "deepseek", "openrouter", "local"]) assert.ok(CLASS_TABLE[p], p);
  });

  it("the table and its rows are frozen", () => {
    assert.ok(Object.isFrozen(CLASS_TABLE)); for (const row of Object.values(CLASS_TABLE)) assert.ok(Object.isFrozen(row));
    assert.throws(() => { (CLASS_TABLE["local"] as Record<string, string>)["frontier"] = "x"; }, TypeError);
  });

  it("the first provider in the caller's order with an allowed profile wins", () => {
    assert.deepEqual(resolveClass("medium", ["anthropic", "openai"], all), { provider: "anthropic", profile: "sonnet" });
    assert.deepEqual(resolveClass("medium", ["openai", "anthropic"], all), { provider: "openai", profile: "general" });
    assert.deepEqual(resolveClass("medium", ["anthropic", "local"], new Set(["local:14-32b"])), { provider: "local", profile: "14-32b" });
  });

  it("no hidden fallback: a class without an allowed profile is undefined, never a neighbouring class", () => {
    assert.equal(resolveClass("frontier", ["local"], all), undefined);
    assert.equal(resolveClass("frontier", ["deepseek"], all), undefined);
    assert.equal(resolveClass("large", ["anthropic"], new Set(["anthropic:sonnet"])), undefined);
    assert.equal(resolveClass("small", [], all), undefined);
    assert.equal(resolveClass("small", ["anthropic"], new Set()), undefined);
  });

  it("the allowed set is matched exactly as 'provider:profile'", () => {
    for (const bad of ["haiku", "anthropic:Haiku", "anthropic: haiku", "anthropic:haiku ", "ANTHROPIC:haiku", "anthropic/haiku"]) assert.equal(resolveClass("small", ["anthropic"], new Set([bad])), undefined, bad);
    assert.ok(resolveClass("small", ["anthropic"], new Set(["anthropic:haiku"])));
  });

  it("unknown providers and Object.prototype member names never resolve", () => {
    for (const p of ["nonexistent", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(resolveClass("medium", [p], all), undefined, p);
    assert.deepEqual(resolveClass("medium", ["__proto__", "constructor", "anthropic"], all), { provider: "anthropic", profile: "sonnet" });
  });
});

describe("triage(): validation of classifier decisions", () => {
  const msg = "Search reviews; then write the report";
  const good = () => decision([taskOf(msg, { id: "k1", summary: "Search reviews", start: 0, end: 14 }), taskOf(msg, { id: "k2", summary: "write the report", start: 21, end: 37, dependsOn: ["k1"] })]);
  const clone = (): TriageDecision => structuredClone(good());

  it("a well-formed decision passes through, with the class recomputed from the distribution and the cost preference", () => {
    const r = triage(msg, { classifier: fixed(good()) });
    assert.equal(r.tasks.length, 2); assert.equal(r.shape, "multi"); assert.deepEqual(r.tasks[1]!.dependsOn, ["k1"]);
    const claimed = clone(); claimed.tasks[0]!.chosenClass = "frontier"; claimed.tasks[0]!.modelClass = d(.9, .05, .03, .02);
    assert.equal(triage(msg, { classifier: fixed(claimed) }).tasks[0]!.chosenClass, "small", "the classifier's own chosenClass is not trusted");
    const wrong = clone(); wrong.tasks[0]!.chosenClass = "small"; wrong.tasks[0]!.modelClass = d(0, 0, .1, .9);
    assert.equal(triage(msg, { classifier: fixed(wrong) }).tasks[0]!.chosenClass, "frontier");
  });

  const mutations: [string, (x: TriageDecision) => void, RegExp][] = [
    ["wrong schema id", x => { (x as { schema: string }).schema = "plur1bus.triage/2"; }, /invalid triage decision/],
    ["unknown shape", x => { (x as { shape: string }).shape = "burst"; }, /invalid triage decision/],
    ["empty task id", x => { x.tasks[0]!.id = ""; }, /invalid task segmentation/],
    ["duplicate task id", x => { x.tasks[1]!.id = "k1"; x.tasks[1]!.dependsOn = []; }, /invalid task segmentation/],
    ["overlapping spans", x => { x.tasks[1]!.start = 10; }, /invalid task segmentation/],
    ["tasks out of order", x => { [x.tasks[0], x.tasks[1]] = [x.tasks[1]!, x.tasks[0]!]; x.tasks[1]!.dependsOn = []; x.tasks[0]!.dependsOn = []; }, /invalid task segmentation/],
    ["empty span", x => { x.tasks[0]!.end = x.tasks[0]!.start; }, /invalid task segmentation/],
    ["negative start", x => { x.tasks[0]!.start = -1; }, /invalid task segmentation/],
    ["span beyond the message", x => { x.tasks[1]!.end = msg.length + 1; }, /invalid task segmentation/],
    ["empty summary", x => { x.tasks[0]!.summary = ""; }, /invalid task segmentation/],
    ["dependency on an unknown task", x => { x.tasks[1]!.dependsOn = ["k9"]; }, /invalid task segmentation/],
    ["dependency on a later task", x => { x.tasks[0]!.dependsOn = ["k2"]; }, /invalid task segmentation/],
    ["dependency on itself", x => { x.tasks[1]!.dependsOn = ["k2"]; }, /invalid task segmentation/],
    ["no categories", x => { x.tasks[0]!.categories = {}; }, /invalid category distribution/],
    ["four categories", x => { x.tasks[0]!.categories = { "a.a": .25, "b.b": .25, "c.c": .25, "d.d": .25 }; }, /invalid category distribution/],
    ["negative category weight", x => { x.tasks[0]!.categories = { "a.a": 1.5, "b.b": -.5 }; }, /invalid category distribution/],
    ["NaN category weight", x => { x.tasks[0]!.categories = { "a.a": Number.NaN }; }, /invalid category distribution/],
    ["category weights not summing to 1", x => { x.tasks[0]!.categories = { "a.a": .5, "b.b": .4 }; }, /invalid category distribution/],
    ["class distribution not summing to 1", x => { x.tasks[0]!.modelClass = d(.5, .5, .5, 0); }, /invalid model class distribution/],
    ["negative class probability", x => { x.tasks[0]!.modelClass = d(-.5, 1.5, 0, 0); }, /invalid model class distribution/],
    ["confidence above 1", x => { x.tasks[0]!.confidence = 1.5; }, /invalid confidence/],
    ["confidence NaN", x => { x.tasks[0]!.confidence = Number.NaN; }, /invalid confidence/],
    ["negative confidence", x => { x.tasks[0]!.confidence = -.1; }, /invalid confidence/],
  ];
  for (const [label, mutate, pattern] of mutations) it(`refuses: ${label}`, () => {
    const x = clone(); mutate(x);
    assert.throws(() => triage(msg, { classifier: fixed(x) }), pattern);
  });

  it("three categories are the maximum and a sum within 1e-6 is accepted", () => {
    const x = clone(); x.tasks[0]!.categories = { "a.a": .3333335, "b.b": .3333335, "c.c": .333333 };
    assert.doesNotThrow(() => triage(msg, { classifier: fixed(x) }));
  });

  it("the result is a deep copy: later changes to the classifier's object do not leak into it, and vice versa", () => {
    const x = clone(); const r = triage(msg, { classifier: fixed(x) });
    x.tasks[0]!.summary = "changed"; r.tasks[0]!.categories["z.z"] = 1;
    assert.equal(r.tasks[0]!.summary, "Search reviews"); assert.equal(x.tasks[0]!.categories["z.z"], undefined);
  });

  it("an invalid decision does not echo the message in its error (it is untrusted user text)", () => {
    const x = clone(); x.tasks[0]!.categories = {};
    assert.throws(() => triage("redact-probe-alpha " + msg, { classifier: fixed(x) }), (e: Error) => !e.message.includes("redact-probe-alpha"));
  });

  it("chat and followup decisions with no tasks are accepted", () => {
    for (const shape of ["chat", "followup", "single"] as const) assert.deepEqual(triage("x", { classifier: fixed({ schema: "plur1bus.triage/1", shape, tasks: [] }) }), { schema: "plur1bus.triage/1", shape, tasks: [] });
  });

  it("rejects fractional offsets before routing; runtime owns shape/task consistency", () => {
    const one = decision([taskOf("hello", { start: 0.5, end: 4.5 })], { shape: "chat" });
    assert.throws(() => triage("hello", { classifier: fixed(one) }), /invalid task segmentation/);
    assert.equal(triage("hello", { classifier: fixed(decision([taskOf("hello")], { shape: "multi" })) }).shape, "multi");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a classifier that throws or returns a non-decision makes triage throw (no fallback to the rule classifier)", () => {
    assert.throws(() => triage("x", { classifier: () => { throw new Error("model offline"); } }), /model offline/);
    for (const garbage of [null, undefined, 5, "text", {}, { schema: "plur1bus.triage/1", shape: "single" }, { schema: "plur1bus.triage/1", shape: "single", tasks: "no" }]) assert.throws(() => triage("x", { classifier: () => garbage as never }), Error, JSON.stringify(garbage));
  });

  it("a classifier decision that is not an object, or whose tasks field is missing or not an array, is refused with the documented 'invalid triage decision' error", () => {
    assert.throws(() => triage("x", { classifier: () => ({ schema: "plur1bus.triage/1", shape: "single" }) as never }), /invalid triage decision/);
    assert.throws(() => triage("x", { classifier: () => ({ schema: "plur1bus.triage/1", shape: "single", tasks: "no" }) as never }), /invalid triage decision/);
    assert.throws(() => triage("x", { classifier: () => null as never }), /invalid triage decision/);
    assert.throws(() => triage("x", { classifier: () => undefined as never }), /invalid triage decision/);
  });
});

describe("triageWithClassifier", () => {
  const msg = "Search reviews; then write the report";
  const good = decision([taskOf(msg, { id: "k1", summary: "Search reviews", start: 0, end: 14 }), taskOf(msg, { id: "k2", summary: "write the report", start: 21, end: 37, dependsOn: ["k1"] })]);

  it("calls the async port once with the message and the cost (default balanced) and validates its answer", async () => {
    const seen: unknown[] = [];
    const r = await triageWithClassifier(msg, async (input) => { seen.push(input); return structuredClone(good); });
    assert.deepEqual(seen, [{ message: msg, cost: "balanced" }]); assert.equal(r.tasks.length, 2);
    const q: unknown[] = [];
    await triageWithClassifier(msg, async (input) => { q.push(input); return structuredClone(good); }, { cost: "quality" });
    assert.deepEqual(q, [{ message: msg, cost: "quality" }]);
  });

  it("the cost preference also reaches the class recomputation", async () => {
    const medium = decision([taskOf("fix", { summary: "fix", start: 0, end: 3, modelClass: d(.1, .75, .12, .03), confidence: .9 })]);
    assert.equal((await triageWithClassifier("fix", async () => structuredClone(medium))).tasks[0]!.chosenClass, "medium");
    assert.equal((await triageWithClassifier("fix", async () => structuredClone(medium), { cost: "quality" })).tasks[0]!.chosenClass, "large");
  });

  it("an invalid answer is refused with the same errors as the synchronous path", async () => {
    const bad = structuredClone(good); bad.tasks[1]!.dependsOn = ["k7"];
    await assert.rejects(triageWithClassifier(msg, async () => bad), /invalid task segmentation/);
  });

  it("a rejecting port rejects the call", async () => {
    await assert.rejects(triageWithClassifier(msg, async () => { throw new Error("llm timeout"); }), /llm timeout/);
  });

  it("a followup in an active task never reaches the port; any other message does", async () => {
    let calls = 0;
    const port = async (): Promise<TriageDecision> => { calls++; return { schema: "plur1bus.triage/1", shape: "chat", tasks: [] }; };
    assert.equal((await triageWithClassifier("yes", port, { activeTask: "k1" })).shape, "followup");
    assert.equal((await triageWithClassifier("ja", port, { activeTask: "k1" })).tasks.length, 0);
    assert.equal(calls, 0);
    await triageWithClassifier(msg, port, { activeTask: "k1" }); assert.equal(calls, 1);
    await triageWithClassifier("yes", port); assert.equal(calls, 2, "without an active task 'yes' is a normal message");
  });

  it("the rule classifier's own decision survives the async path unchanged", async () => {
    const rule = ruleClassifier({ message: msg, cost: "balanced" });
    assert.deepEqual(await triageWithClassifier(msg, async () => structuredClone(rule)), triage(msg));
  });
});
