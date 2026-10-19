// core/triage rule classifier: table tests per classification rule (positive and negative), segmentation, class mapping,
// edge cases (empty, emoji only, very long, mixed languages), determinism, followup/greeting heuristics.
// Expectations: docs/tool-reliability.md "Message triage" and D105 in docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md
// (English/German intents, explicit connectors, ';' and list/newline boundaries, ordinary "and" does not split, followups skip classification,
// class by the smallest class whose above-class probability is <= .2 / .35 / .1, confidence < .5 raises one class, 200 ms p95 budget).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triage, ruleClassifier, type TriageDecision, type CostPreference } from "../../src/triage/index.ts";
import { mulberry32, gap, classIndex } from "./helpers.ts";

const categoryOf = (message: string, cost?: CostPreference): string => {
  const d = triage(message, cost ? { cost } : {});
  assert.equal(d.tasks.length, 1, `expected one task for ${JSON.stringify(message)}, got ${d.tasks.length}`);
  return Object.keys(d.tasks[0]!.categories)[0]!;
};

describe("rule classifier: one rule at a time", () => {
  const table: [string, string[], string[]][] = [
    // [category, positive examples (en + de, case variants, suffixes), negative examples (must NOT be this category)]
    ["web.research", ["Search laptop reviews", "search", "SEARCH the web", "Searching for flights", "Research the market", "Find online prices", "Reviews of the Framework 16", "Suche Bewertungen", "suche nach Hotels", "Recherchiere das Thema", "Bewertungen lesen"], ["Surf the net", "unsearchable thing", "Hello friend", "Wo ist die Bahn", "find prices"]],
    ["web.browse", ["Open the browser", "Browse to the site", "Scroll down", "Navigate to settings", "Show the website", "Öffne die Webseite", "scrolle nach unten", "navigiere zur Seite"], ["I like surfing", "unbrowsable", "Brows", "Seite öffnen bitte"]],
    ["docs.create", ["Write a poem", "Create a PDF", "A report please", "The document", "Bericht bitte", "Dokument anlegen", "schreibe einen Text", "erstelle eine Liste"], ["Rewrite this", "He wrote it", "Hello there", "Liste anlegen"]],
    ["code.edit", ["Debug this", "Implement a parser", "Fix the bug", "Run the tests", "Look at the code", "Programmiere eine App", "Fehler beheben", "code"], ["latest news", "decode it", "prefix", "Hello there"]],
    ["code.review", ["Review the diff", "Audit the logs", "review", "Prüfe das", "PRÜFE den Plan", "Review my report", "Code review"], ["Reviews of laptops", "Reviewer comments", "auditorium", "Hello there"]],
    ["files.manage", ["Move the file", "List my files", "Datei öffnen", "Ordner anlegen", "verschiebe das", "Move it"], ["profile settings", "Hello there", "Prozess starten"]],
    ["ops.system", ["Check the system", "How full is the disk", "List running process", "Install node", "Speicher prüfen", "Prozess beenden"], ["ecosystem tour", "reinstall", "Hello there"]],
    ["data.analyse", ["Analyse the sales", "Analyze the logs", "Look at the data", "Daten auswerten", "Analyse bitte", "data"], ["metadata", "update", "Hello there"]],
    ["comm.email", ["Send an email", "Check my mail", "Tell her via message", "Nachricht senden", "email", "e-mail Anna"], ["gmail", "female", "Hello there"]],
    ["media.image", ["Show the image", "Edit this photo", "Ein Bild malen", "Foto drehen", "images"], ["imagine that", "Hello there", "Bahnhof"]],
    ["memory.manage", ["Remember this", "Recall what I said", "Erinnere mich", "Gedächtnis löschen", "memory"], ["memorial", "Hello there", "Erinnerung"]],
    ["general.chat", ["Hello there", "How is the weather", "Wie geht es dir", "Tell me a joke", "Surf the net"], ["Search laptop reviews", "Fix the bug"]],
  ];
  for (const [category, positive, negative] of table) {
    it(`${category}: positives`, () => { for (const m of positive) assert.equal(categoryOf(m), category, JSON.stringify(m)); });
    it(`${category}: negatives are classified as something else`, () => { for (const m of negative) assert.notEqual(categoryOf(m), category, JSON.stringify(m)); });
  }

  it("characterization: Ist-Verhalten, nicht spezifiziert - the keyword rules are prefix matches, so some near-words are false positives", () => {
    for (const [m, c] of [["Reportage", "docs.create"], ["codec", "code.edit"], ["filet", "files.manage"], ["Bildung", "media.image"], ["bildlich gesprochen", "media.image"], ["He is a researcher", "web.research"], ["Reviewer comments", "web.research"], ["fixture", "code.edit"]] as const) assert.equal(categoryOf(m), c, m);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - when several rules match, code.review and media.image win, otherwise the first rule in table order", () => {
    const priorities: [string, string][] = [
      ["search images", "media.image"], ["Create an image of a report", "media.image"], ["review the report", "code.review"], ["Review and fix the bug", "code.review"],
      ["write code", "docs.create"], ["debug the system", "code.edit"], ["find files on disk", "files.manage"], ["Search my files", "web.research"],
      ["send a message with a report", "docs.create"], ["analyse the data on disk", "ops.system"], ["remember the email", "comm.email"],
    ];
    for (const [m, c] of priorities) assert.equal(categoryOf(m), c, m);
  });

  it("matching is case-insensitive for ASCII and for German umlauts in the pattern, and anchored at word starts", () => {
    assert.equal(categoryOf("SEARCH"), "web.research"); assert.equal(categoryOf("sEaRcH"), "web.research"); assert.equal(categoryOf("PRÜFE"), "code.review");
    assert.equal(categoryOf("xsearch"), "general.chat"); assert.equal(categoryOf("1search"), "general.chat", "digits are word characters, so no boundary");
    assert.equal(categoryOf("(search)"), "web.research"); assert.equal(categoryOf("re-search"), "web.research", "a hyphen is a boundary");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - look-alike and decomposed spellings are not recognised", () => {
    assert.equal(categoryOf("sеarch the web"), "general.chat", "Cyrillic е");
    assert.equal(categoryOf("prüfe das"), "general.chat", "NFD ü");
    assert.equal(categoryOf("ｓｅａｒｃｈ"), "general.chat", "full-width letters");
    assert.equal(categoryOf("sea​rch"), "general.chat", "zero-width space inside the keyword");
  });

  it("every category the rule classifier can emit is a registered capability category", async () => {
    const { CATEGORIES } = await import("../../src/toolcall/categories.ts");
    const ids = new Set(CATEGORIES.map(c => c.id));
    for (const [category] of table) assert.ok(ids.has(category), category);
  });
});

describe("rule classifier: classes, effort, confidence, cost", () => {
  const dist = {
    small: { small: .85, medium: .1, large: .04, frontier: .01 },
    medium: { small: .1, medium: .75, large: .12, frontier: .03 },
    complex: { small: 0, medium: .1, large: .85, frontier: .05 },
  };

  it("code/data/web categories get the medium profile, matching the D105 example (balanced -> medium, quality -> large)", () => {
    for (const m of ["Fix the bug", "Analyse the data", "Search laptop reviews", "Navigate to settings"]) {
      const t = triage(m).tasks[0]!;
      assert.deepEqual(t.modelClass, dist.medium, m); assert.equal(t.effort, "medium"); assert.equal(t.confidence, .85);
      assert.equal(t.chosenClass, "medium", m);
      assert.equal(triage(m, { cost: "economy" }).tasks[0]!.chosenClass, "medium", m);
      assert.equal(triage(m, { cost: "quality" }).tasks[0]!.chosenClass, "large", m);
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - all other categories (docs, files, ops, comm, media, memory) get the small profile", () => {
    for (const m of ["Write a poem", "Move the file", "Check the system", "Send an email", "Edit this photo", "Remember this"]) {
      const t = triage(m).tasks[0]!;
      assert.deepEqual(t.modelClass, dist.small, m); assert.equal(t.effort, "low"); assert.equal(t.chosenClass, "small", m);
      assert.equal(triage(m, { cost: "economy" }).tasks[0]!.chosenClass, "small");
      assert.equal(triage(m, { cost: "quality" }).tasks[0]!.chosenClass, "medium");
    }
  });

  it("complexity keywords (EN/DE) switch to the large profile and high effort, on top of any category", () => {
    for (const m of ["Design the architecture", "security audit", "Prove it, a proof please", "distributed locking", "Sicherheit prüfen", "Architektur planen", "ein Beweis", "Write about security"]) {
      const t = triage(m).tasks[0]!;
      assert.deepEqual(t.modelClass, dist.complex, m); assert.equal(t.effort, "high", m);
      // Messages without a keyword rule have confidence .4, which raises "large" to "frontier"; recognised ones stay at "large".
      const expected = categoryOf(m) === "general.chat" ? "frontier" : "large";
      for (const cost of ["economy", "balanced", "quality"] as const) assert.equal(triage(m, { cost }).tasks[0]!.chosenClass, expected, `${m} ${cost}`);
    }
    assert.equal(categoryOf("security audit"), "code.review");
    assert.notEqual(triage("insecure").tasks[0]!.effort, "high", "'security' must start a word");
  });

  it("an unrecognised message has confidence .4, which raises the small class by one", () => {
    const t = triage("Tell me a joke").tasks[0]!;
    assert.equal(t.confidence, .4); assert.deepEqual(t.modelClass, dist.small); assert.equal(t.chosenClass, "medium");
    assert.equal(triage("Tell me a joke", { cost: "quality" }).tasks[0]!.chosenClass, "large");
  });

  it("the reason names the rule and the threshold of the chosen cost preference", () => {
    assert.equal(triage("Fix it", { cost: "economy" }).tasks[0]!.reason, "rule:code.edit; smallest class above-tail <= 0.35");
    assert.equal(triage("Fix it").tasks[0]!.reason, "rule:code.edit; smallest class above-tail <= 0.2");
    assert.equal(triage("Fix it", { cost: "quality" }).tasks[0]!.reason, "rule:code.edit; smallest class above-tail <= 0.1");
  });

  it("category distribution is a single category with probability 1; ids are k1..kn", () => {
    const d = triage("Search reviews; then create a report; Fix the bug");
    assert.deepEqual(d.tasks.map(t => t.id), ["k1", "k2", "k3"]);
    for (const t of d.tasks) { assert.equal(Object.keys(t.categories).length, 1); assert.equal(Object.values(t.categories)[0], 1); }
  });

  it("the cost preference never changes segmentation or categories, only the chosen class (and never lowers it for a higher preference)", () => {
    const rnd = mulberry32(0x7a1);
    for (let i = 0; i < 100; i++) {
      const m = randomMessage(rnd);
      const e = triage(m, { cost: "economy" }), b = triage(m), q = triage(m, { cost: "quality" });
      const strip = (d: TriageDecision) => d.tasks.map(t => [t.summary, t.start, t.end, JSON.stringify(t.categories), t.dependsOn.join()]);
      assert.deepEqual(strip(e), strip(b)); assert.deepEqual(strip(q), strip(b));
      e.tasks.forEach((t, k) => { assert.ok(classIndex(t.chosenClass) <= classIndex(b.tasks[k]!.chosenClass), `case ${i}`); assert.ok(classIndex(b.tasks[k]!.chosenClass) <= classIndex(q.tasks[k]!.chosenClass), `case ${i}`); });
    }
  });
});

describe("rule classifier: segmentation", () => {
  const spans = (m: string) => triage(m).tasks.map(t => [t.summary, t.start, t.end] as const);

  it("splits on ';' and keeps exact spans into the original text", () => {
    const m = "Search reviews; create a report";
    assert.deepEqual(spans(m), [["Search reviews", 0, 14], ["create a report", 16, 31]]);
    for (const t of triage(m).tasks) assert.equal(m.slice(t.start, t.end), t.summary);
  });

  it("explicit sequence connectors split and record a dependency; plain separators do not", () => {
    const dep = (m: string) => triage(m).tasks.map(t => t.dependsOn);
    assert.deepEqual(dep("Search reviews; then create a report"), [[], ["k1"]]);
    assert.deepEqual(dep("Search reviews; danach create a report"), [[], ["k1"]]);
    assert.deepEqual(dep("Suche Bewertungen; anschließend erstelle einen Bericht"), [[], ["k1"]]);
    assert.deepEqual(dep("Search reviews and then create a report"), [[], ["k1"]]);
    assert.deepEqual(dep("Suche Bewertungen und danach erstelle einen Bericht"), [[], ["k1"]]);
    assert.deepEqual(dep("Search reviews then create a report"), [[], ["k1"]]);
    assert.deepEqual(dep("Search reviews danach create a report"), [[], ["k1"]]);
    assert.deepEqual(dep("Search reviews; create a report"), [[], []]);
    assert.deepEqual(dep("Search reviews\ncreate a report"), [[], []]);
    assert.deepEqual(dep("a; then b; then c"), [[], ["k1"], ["k2"]]);
    assert.deepEqual(dep("a; b; then c"), [[], [], ["k2"]]);
  });

  it("connectors are case-insensitive", () => {
    assert.equal(triage("Search reviews AND THEN create a report").tasks.length, 2);
    assert.equal(triage("Search reviews; THEN create a report").tasks[1]!.dependsOn[0], "k1");
    assert.equal(triage("Suche; DANACH schreibe").tasks.length, 2);
  });

  it("an ordinary 'and' (and 'und') inside a task never splits", () => {
    for (const m of ["Salt and pepper", "Search reviews and create a report", "Suche Hotels und Flüge", "research cats and dogs and birds", "Write a note and then", "bathen"]) assert.equal(triage(m).tasks.length, 1, m);
  });

  it("'then' is only a connector between whitespace; at the start or end of the message it is ordinary text", () => {
    assert.equal(triage("then create a report").tasks.length, 1);
    assert.equal(triage("Search reviews then").tasks.length, 1);
    assert.equal(triage("authentic thenceforth").tasks.length, 1);
  });

  it("newlines split; blank lines and bullet or number markers are consumed by the separator", () => {
    const summaries = (m: string) => triage(m).tasks.map(t => t.summary);
    assert.deepEqual(summaries("search a\nfix b"), ["search a", "fix b"]);
    assert.deepEqual(summaries("search a\n\n\nfix b"), ["search a", "fix b"]);
    assert.deepEqual(summaries("search a\r\nfix b"), ["search a", "fix b"]);
    assert.deepEqual(summaries("search a\n- fix b\n* write c\n1. move d\n2) check e"), ["search a", "fix b", "write c", "move d", "check e"]);
    assert.deepEqual(summaries("- search a\n- fix b"), ["- search a", "fix b"], "characterization: Ist-Verhalten, nicht spezifiziert - the first item keeps its marker");
    assert.deepEqual(summaries("1. search a\n2. fix b"), ["1. search a", "fix b"]);
  });

  it("empty fragments are dropped without shifting offsets", () => {
    const m = ";;  search a ;; ; fix b;";
    const tasks = triage(m).tasks;
    assert.deepEqual(tasks.map(t => t.summary), ["search a", "fix b"]);
    for (const t of tasks) assert.equal(m.slice(t.start, t.end), t.summary);
  });

  it("leading and trailing whitespace is excluded from the span", () => {
    const m = "   \t search a  ;  fix b \n ";
    for (const t of triage(m).tasks) { assert.equal(m.slice(t.start, t.end), t.summary); assert.equal(t.summary, t.summary.trim()); }
    assert.equal(triage(m).tasks.length, 2);
  });

  it("the shape follows the task count: one task is 'single', several are 'multi'", () => {
    assert.equal(triage("search a").shape, "single"); assert.equal(triage("search a; fix b").shape, "multi"); assert.equal(triage("a; b; c").shape, "multi");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a comma before a connector stays on the previous task, 'anschließend' only connects after a semicolon", () => {
    assert.deepEqual(triage("search a, then fix b").tasks.map(t => t.summary), ["search a,", "fix b"]);
    assert.equal(triage("search a anschließend fix b").tasks.length, 1);
  });

  it("generative: spans are ordered, disjoint, exact; dependencies point backwards; ids are sequential (seeded)", () => {
    const SEED = 0x5e61;
    const rnd = mulberry32(SEED);
    for (let i = 0; i < 600; i++) {
      const m = randomMessage(rnd);
      const ctx = `seed=0x${SEED.toString(16)} case=${i} message=${JSON.stringify(m.slice(0, 100))}`;
      const d = triage(m);
      let prevEnd = 0;
      d.tasks.forEach((t, k) => {
        assert.equal(t.id, `k${k + 1}`, ctx);
        assert.ok(t.start >= prevEnd && t.end > t.start && t.end <= m.length, `${ctx}: span ${t.start}-${t.end}`);
        assert.equal(m.slice(t.start, t.end), t.summary, ctx); assert.equal(t.summary, t.summary.trim(), ctx); assert.ok(t.summary.length > 0, ctx);
        assert.ok(t.dependsOn.every(id => Number(id.slice(1)) < k + 1), ctx);
        assert.ok(t.dependsOn.length <= 1, ctx);
        prevEnd = t.end;
      });
      assert.equal(d.shape, d.tasks.length === 0 ? "chat" : d.tasks.length === 1 ? "single" : "multi", ctx);
      assert.deepEqual(triage(m), d, `${ctx}: not deterministic`);
    }
  });
});

describe("rule classifier: edge cases", () => {
  it("empty and whitespace-only messages are chat with no tasks", () => {
    for (const m of ["", " ", "   \n\t  ", "\r\n", " ", " "]) assert.deepEqual(triage(m), { schema: "plur1bus.triage/1", shape: "chat", tasks: [] }, JSON.stringify(m));
  });

  it("greetings and thanks (the whole message) are chat; anything more is a normal task", () => {
    for (const m of ["hi", "Hi!", "HELLO.", "hallo", "Hallo!!!", "danke", "Danke.", "thanks", "Thanks!!!", "hi \n", "hello ... !"]) assert.equal(triage(m).shape, "chat", JSON.stringify(m));
    for (const m of ["hi there", "hello world", "thanks a lot", "danke schön", "hi, search reviews", "hey", "guten Tag", "hi 👋", "hi?"]) assert.equal(triage(m).shape, "single", JSON.stringify(m));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a message made only of separators has no task but the shape is 'single' (not 'chat' like an empty message)", () => {
    for (const m of [";", ";;;", "; ;\n;", "\n\n"]) assert.deepEqual(triage(m), { schema: "plur1bus.triage/1", shape: m.trim() ? "single" : "chat", tasks: [] }, JSON.stringify(m));
  });

  it("emoji-only messages are one ordinary low-confidence task, with exact spans in UTF-16 units", () => {
    for (const m of ["👍", "👍🏽", "👨‍👩‍👧‍👦", "🔥🔥🔥", "❤️"]) {
      const d = triage(m);
      assert.equal(d.tasks.length, 1, m); assert.equal(d.tasks[0]!.summary, m); assert.equal(d.tasks[0]!.start, 0); assert.equal(d.tasks[0]!.end, m.length);
      assert.deepEqual(Object.keys(d.tasks[0]!.categories), ["general.chat"]); assert.equal(d.tasks[0]!.confidence, .4);
    }
  });

  it("emoji next to keywords do not disturb recognition or offsets", () => {
    const m = "🔥 Search reviews 🔥; then fix the bug 🐛";
    const d = triage(m);
    assert.equal(d.tasks.length, 2); assert.equal(categoryOf("🔍search"), "web.research");
    for (const t of d.tasks) assert.equal(m.slice(t.start, t.end), t.summary);
    assert.equal(d.tasks[1]!.summary, "fix the bug 🐛");
  });

  it("mixed German/English messages classify each part with its own language rules", () => {
    const d = triage("Suche Bewertungen for the Framework 16; then erstelle a report; fix the Fehler");
    assert.deepEqual(d.tasks.map(t => Object.keys(t.categories)[0]), ["web.research", "docs.create", "code.edit"]);
    assert.deepEqual(d.tasks.map(t => t.dependsOn), [[], ["k1"], []]);
    assert.equal(categoryOf("Prüfe the Dokument"), "code.review");
  });

  it("non-Latin scripts and right-to-left text are accepted without error (one low-confidence task)", () => {
    for (const m of ["今日の天気は？", "ابحث عن مراجعات", "Поищи отзывы", "שלום עולם", "🇩🇪 Bitte schreibe einen Bericht"]) {
      const d = triage(m);
      assert.equal(d.tasks.length, 1, m); assert.equal(m.slice(d.tasks[0]!.start, d.tasks[0]!.end), d.tasks[0]!.summary);
    }
    assert.equal(categoryOf("🇩🇪 Bitte schreibe einen Bericht"), "docs.create");
  });

  it("control characters, NUL and lone surrogates do not throw and keep offsets exact", () => {
    for (const m of ["search\u0000reviews", "\u0001\u0002 fix", "lone \ud800 surrogate; fix", "tab\tsearch", "\u0085next line"]) {
      const d = triage(m);
      for (const t of d.tasks) assert.equal(m.slice(t.start, t.end), t.summary, JSON.stringify(m));
    }
  });

  it("very long inputs: 200 000 characters in one task and 5 000 separated tasks both complete with consistent spans", () => {
    const long = "word ".repeat(40_000);
    const single = triage(long);
    assert.equal(single.tasks.length, 1); assert.equal(single.tasks[0]!.end - single.tasks[0]!.start, long.trim().length);
    const many = Array.from({ length: 5000 }, (_, i) => `search item ${i}`).join("; ");
    const d = triage(many);
    assert.equal(d.tasks.length, 5000); assert.equal(d.tasks[4999]!.id, "k5000");
    for (const t of d.tasks.filter((_, i) => i % 499 === 0)) assert.equal(many.slice(t.start, t.end), t.summary);
    assert.equal(triage(";".repeat(100_000)).tasks.length, 0, "separators only: no tasks, no crash");
    assert.equal(triage("a".repeat(200_000)).tasks.length, 1);
  });

  it("segments long whitespace input within the local decision budget", () => {
    // Wall-clock on purpose: the property under test is the runtime itself. A linear implementation needs a few milliseconds
    // for this input; the 200 ms budget from D105 leaves a margin of ~50x.
    const message = "a" + " ".repeat(30_000) + "b";
    const started = performance.now();
    triage(message);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `triage took ${Math.round(elapsed)} ms`);
  });

  it("the decision is a deep copy: mutating it does not influence the next call", () => {
    const a = triage("search a"); a.tasks[0]!.categories["x.y"] = 5; a.tasks.length = 0;
    assert.equal(triage("search a").tasks[0]!.categories["x.y"], undefined);
  });
});

describe("determinism", () => {
  it("the same message gives the identical decision, regardless of earlier calls, cost order or call count (no hidden state)", () => {
    const messages = ["Search reviews; then create a report", "", "Tell me a joke", "🔥", "Prüfe den Plan\n- fix the Fehler", "hi", "x".repeat(1000)];
    const first = messages.map(m => triage(m));
    for (let round = 0; round < 50; round++) for (const [i, m] of messages.entries()) assert.deepEqual(triage(m), first[i], `round ${round}`);
    for (const m of messages.slice().reverse()) triage(m, { cost: "quality" });
    messages.forEach((m, i) => assert.deepEqual(triage(m), first[i]));
  });

  it("ruleClassifier and triage agree (triage only validates and recomputes the class)", () => {
    for (const cost of ["economy", "balanced", "quality"] as const) for (const m of ["Search reviews; then create a report", "Tell me a joke", "security audit\nfix it"]) assert.deepEqual(triage(m, { cost }), ruleClassifier({ message: m, cost }), `${cost} ${m}`);
  });
});

describe("followup and activeTask", () => {
  it("short confirmations inside an open task are followups with no tasks, trimmed and case-insensitive", () => {
    for (const m of ["yes", "No.", "OK!", "continue", "ja", "nein", "weiter", "genau", "  Yes  ", "YES!!!", "ok ...", "Ja."]) assert.deepEqual(triage(m, { activeTask: "k1" }), { schema: "plur1bus.triage/1", shape: "followup", tasks: [] }, JSON.stringify(m));
  });

  it("without an active task the same words are ordinary messages; an empty activeTask counts as none", () => {
    for (const m of ["yes", "ja", "weiter"]) { assert.equal(triage(m).shape, "single"); assert.equal(triage(m, { activeTask: "" }).shape, "single"); }
  });

  it("anything beyond the exact word is not a followup, even with an active task", () => {
    for (const m of ["yes please", "ja, suche Hotels", "ok then fix it", "no way", "continue with the report", "y", "yeah", "nope"]) assert.notEqual(triage(m, { activeTask: "k1" }).shape, "followup", m);
  });

  it("the classifier port gets the untouched message and the cost preference, exactly once", () => {
    const seen: unknown[] = [];
    triage("  Search reviews  ", { cost: "economy", classifier: (input) => { seen.push(input); return ruleClassifier(input); } });
    assert.deepEqual(seen, [{ message: "  Search reviews  ", cost: "economy" }]);
  });
});

/** Random message made of keyword fragments, connectors, whitespace and awkward characters. */
export function randomMessage(rnd: () => number): string {
  const fragments = ["search reviews", "create a report", "fix the bug", "Suche Bewertungen", "erstelle einen Bericht", "move the file", "analyse data", "send an email", "foo", "👍", "über", "x".repeat(30), "security audit", "Prüfe das", "and", "then", "und"];
  const separators = [" ", "; ", ";then ", ";  danach ", " then ", " and then ", " und danach ", "\n", "\n- ", "\n1. ", "\r\n", "  ", ";;", " ; ", "\t", "\n\n", "; anschließend "];
  const n = Math.floor(rnd() * 7);
  let out = rnd() < .2 ? " ".repeat(Math.floor(rnd() * 4)) : "";
  for (let i = 0; i < n; i++) out += fragments[Math.floor(rnd() * fragments.length)]! + separators[Math.floor(rnd() * separators.length)]!;
  return out;
}
