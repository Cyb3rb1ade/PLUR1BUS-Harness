import assert from "node:assert/strict";
import { test } from "node:test";
import { toSignalText, toPlatformMarkdown, formatTextStyles, type TextStyle } from "../src/index.ts";

const S = (start: number, length: number, style: TextStyle["style"]): TextStyle => ({ start, length, style });

// [name, input, expected text, expected styles]
const table: Array<[string, string, string, TextStyle[]]> = [
  ["plain", "hello world", "hello world", []],
  ["bold **", "**bold**", "bold", [S(0, 4, "BOLD")]],
  ["bold __", "__bold__ x", "bold x", [S(0, 4, "BOLD")]],
  ["italic *", "*it* x", "it x", [S(0, 2, "ITALIC")]],
  ["italic _", "a _it_ b", "a it b", [S(2, 2, "ITALIC")]],
  ["strike", "~~gone~~", "gone", [S(0, 4, "STRIKETHROUGH")]],
  ["spoiler", "a ||secret|| b", "a secret b", [S(2, 6, "SPOILER")]],
  ["inline code", "run `ls -l` now", "run ls -l now", [S(4, 5, "MONOSPACE")]],
  ["code span keeps markup literal", "`**x**`", "**x**", [S(0, 5, "MONOSPACE")]],
  ["double-backtick span", "`` a`b ``", "a`b", [S(0, 3, "MONOSPACE")]],
  ["nested bold+italic", "a **b *c* d** e", "a b c d e", [S(2, 5, "BOLD"), S(4, 1, "ITALIC")]],
  ["triple ***", "***x***", "x", [S(0, 1, "BOLD"), S(0, 1, "ITALIC")]],
  ["code inside bold", "**a `b` c**", "a b c", [S(0, 5, "BOLD"), S(2, 1, "MONOSPACE")]],
  ["emoji before bold (surrogates count 2)", "😀 **b**", "😀 b", [S(3, 1, "BOLD")]],
  ["emoji inside bold", "**a😀b**", "a😀b", [S(0, 4, "BOLD")]],
  ["ZWJ family counts all code units", "👨‍👩‍👧 *x*", "👨‍👩‍👧 x", [S(9, 1, "ITALIC")]],
  ["combining char", "é *x*", "é x", [S(2, 1, "ITALIC")]],
  ["fenced code block", "```js\nconst a = 1;\n```", "const a = 1;", [S(0, 12, "MONOSPACE")]],
  ["code block between paragraphs", "x\n\n```\nco**de**\n```\ny", "x\n\nco**de**\ny", [S(3, 8, "MONOSPACE")]],
  ["unclosed fence runs to end", "```\nabc", "abc", [S(0, 3, "MONOSPACE")]],
  ["tilde fence", "~~~\nz\n~~~", "z", [S(0, 1, "MONOSPACE")]],
  ["link appends url", "[docs](https://e.example/a)", "docs (https://e.example/a)", []],
  ["link with bold label", "[**d**](https://e.example)", "d (https://e.example)", [S(0, 1, "BOLD")]],
  ["link text equals url", "[https://e.example](https://e.example)", "https://e.example", []],
  ["autolink", "<https://e.example/x>", "https://e.example/x", []],
  ["image", "![alt text](https://e.example/i.png)", "alt text (https://e.example/i.png)", []],
  ["link title dropped", '[t](https://e.example "title")', "t (https://e.example)", []],
  ["link with parens in url", "[w](https://e.example/a_(b))", "w (https://e.example/a_(b))", []],
  ["escaped stars", "\\*not\\* bold", "*not* bold", []],
  ["spaced stars are literal", "2 * 3 * 4", "2 * 3 * 4", []],
  ["intraword underscore is literal", "snake_case_word", "snake_case_word", []],
  ["unclosed bold literal", "**abc", "**abc", []],
  ["lone tilde literal", "~5 and ~6", "~5 and ~6", []],
  ["heading becomes bold", "# Title\ntext", "Title\ntext", [S(0, 5, "BOLD")]],
  ["heading with inline", "## a *b*", "a b", [S(0, 3, "BOLD"), S(2, 1, "ITALIC")]],
  ["bullets", "- a\n* b\n+ c", "• a\n• b\n• c", []],
  ["ordered list untouched", "1. a\n2. b", "1. a\n2. b", []],
  ["quote kept", "> quoted *x*", "> quoted x", [S(9, 1, "ITALIC")]],
  ["hr", "a\n\n---\n\nb", "a\n\n──────\n\nb", []],
  ["multi-line emphasis in one paragraph", "*a\nb*", "a\nb", [S(0, 3, "ITALIC")]],
  ["bold across two lines then second paragraph", "**a**\nb **c**", "a\nb c", [S(0, 1, "BOLD"), S(4, 1, "BOLD")]],
  ["mention placeholder stripped (no injection)", "hi ￼ there", "hi  there", []],
  ["control chars stripped", "a\u0000b\u0007c\td", "abc\td", []],
  ["literal @number stays literal text", "ping @+4915112345678", "ping @+4915112345678", []],
  ["html is not special", "<b>x</b>", "<b>x</b>", []],
];

for (const [name, input, text, styles] of table)
  test(`markdown: ${name}`, () => {
    const out = toSignalText(input);
    assert.equal(out.text, text);
    assert.deepEqual(out.styles, styles);
    for (const s of out.styles) {
      assert.ok(s.start >= 0 && s.length > 0 && s.start + s.length <= out.text.length, "range inside text");
    }
  });

test("markdown: alias and wire format", () => {
  assert.equal(toPlatformMarkdown, toSignalText);
  assert.deepEqual(formatTextStyles([S(3, 1, "BOLD"), S(0, 2, "MONOSPACE")]), ["3:1:BOLD", "0:2:MONOSPACE"]);
});

test("markdown: every style range lands on the marked substring (UTF-16 offsets)", () => {
  const { text, styles } = toSignalText("😀😀 **bold😀** and _it_ plus `c😀`");
  const slices = styles.map((s) => [s.style, text.slice(s.start, s.start + s.length)]);
  assert.deepEqual(slices, [
    ["BOLD", "bold😀"],
    ["ITALIC", "it"],
    ["MONOSPACE", "c😀"],
  ]);
});

test("markdown: pathological input terminates quickly and keeps ranges valid", () => {
  const nasty = "*".repeat(5000) + "a" + "_".repeat(5000) + "[".repeat(2000) + "`".repeat(3000);
  const out = toSignalText(nasty);
  for (const s of out.styles) assert.ok(s.start + s.length <= out.text.length);
});
