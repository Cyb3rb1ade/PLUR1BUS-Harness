import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker, chunkSentences } from "../src/realtime/chunker.ts";

const table: Array<{ name: string; input: string; maxWords?: number; expect: string[] }> = [
  { name: "plain sentences", input: "Hello there. How are you? Fine!", expect: ["Hello there.", "How are you?", "Fine!"] },
  { name: "decimal number is not a stop", input: "Pi is 3.14 roughly. Next.", expect: ["Pi is 3.14 roughly.", "Next."] },
  { name: "german abbreviation z. B.", input: "Das geht, z.B. morgen. Oder heute.", expect: ["Das geht, z.B. morgen.", "Oder heute."] },
  { name: "german ordinal before month", input: "Wir treffen uns am 3. Mai in Berlin. Danach nicht.", expect: ["Wir treffen uns am 3. Mai in Berlin.", "Danach nicht."] },
  { name: "ordinal before lowercase", input: "Er wurde 3. beim Rennen. Gut so.", expect: ["Er wurde 3. beim Rennen.", "Gut so."] },
  { name: "title abbreviation", input: "Dr. Meyer kommt. Prof. Schulz auch.", expect: ["Dr. Meyer kommt.", "Prof. Schulz auch."] },
  { name: "english titles and initials", input: "Mr. J. Smith left. It rained.", expect: ["Mr. J. Smith left.", "It rained."] },
  { name: "ellipsis ends a chunk", input: "Well... I think so. Yes.", expect: ["Well...", "I think so.", "Yes."] },
  { name: "closing quote after stop", input: 'She said "stop." Then left.', expect: ['She said "stop."', "Then left."] },
  { name: "newline is a boundary", input: "Line one\nLine two", expect: ["Line one", "Line two"] },
  { name: "no terminator at all", input: "just a fragment", expect: ["just a fragment"] },
  { name: "empty", input: "", expect: [] },
  { name: "question and exclamation run", input: "Really?! Yes.", expect: ["Really?!", "Yes."] },
  { name: "maxWords cuts at comma in second half", input: "one two three four five, six seven eight nine ten eleven twelve.", maxWords: 8, expect: ["one two three four five,", "six seven eight nine ten eleven twelve."] },
  { name: "maxWords hard cut without comma", input: "a b c d e f g h i j.", maxWords: 4, expect: ["a b c d", "e f g h", "i j."] },
];
for (const row of table) {
  test(`chunker table: ${row.name}`, () => {
    assert.deepEqual(chunkSentences(row.input, row.maxWords === undefined ? {} : { maxWords: row.maxWords }), row.expect);
  });
}

test("streaming deltas give the same chunks as the whole text, however they are split", () => {
  const text = "Pi is 3.14 roughly. Dr. Meyer sagt: am 3. Mai geht es. Fertig!";
  const whole = chunkSentences(text);
  for (const size of [1, 2, 3, 5, 7, 11]) {
    const c = new SentenceChunker();
    const got: string[] = [];
    for (let i = 0; i < text.length; i += size) got.push(...c.push(text.slice(i, i + size)));
    got.push(...c.flush());
    assert.deepEqual(got, whole, `delta size ${size}`);
  }
});

test("a terminator at the buffer end is held until the next delta decides", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Value is 3."), []);
  assert.deepEqual(c.push("14 units. Next"), ["Value is 3.14 units."]);
  assert.equal(c.pending.trim(), "Next");
  assert.deepEqual(c.flush(), ["Next"]);
  assert.equal(c.pending, "");
});

test("maxWords never cuts inside a word that is still arriving", () => {
  const c = new SentenceChunker({ maxWords: 3 });
  assert.deepEqual(c.push("alpha beta gamma delt"), []);
  assert.deepEqual(c.push("a epsilon "), ["alpha beta gamma"]);
  assert.deepEqual(c.flush(), ["delta epsilon"]);
});
