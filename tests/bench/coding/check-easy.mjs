/** Original MIT hidden cases. Expected values remain in the coordinator, outside candidate sandboxes. */
import assert from "node:assert/strict";

function cli(result, output, code = 0) {
  assert.equal(result.code, code);
  assert.equal(result.stdout, output);
}
async function checkEasyRustWindow(t) {
  const { id, constant: n, tag } = t;

  for (const [values, width, expected] of [
    [[n, -2, 7, n + 1], 2, [n - 2, 5, n + 8].map(String)],
    [[], 1, []],
    [[n], 0, []],
    [[n], 2, []],
    [[-n, n], 1, [-n, n].map(String)],
    [["9223372036854775807", "9223372036854775807"], 2, ["18446744073709551614"]],
    [["-9223372036854775808", "-9223372036854775808"], 2, ["-18446744073709551616"]],
  ])
    assert.deepEqual(await t.repo({ values: values.map(String), width }), { value: expected });
}

async function checkEasyRustDuration(t) {
  const { id, constant: n, tag } = t;

  for (const [args, expected] of [
    [["1h2m3s"], "3723\n"],
    [[`${n}m2s`], `${n * 60 + 2}\n`],
    [["0s"], "0\n"],
    [["0001h"], "3600\n"],
    [["18446744073709551615s"], "18446744073709551615\n"],
  ])
    cli(await t.terminal(args, ""), expected);
  for (const args of [
    [],
    [""],
    ["-1s"],
    ["1m1h"],
    ["1s2s"],
    ["4"],
    ["2s", "extra"],
    ["18446744073709551616s"],
    ["18446744073709551615h"],
    ["1h+2s"],
    ["é1s"],
    ["1.2s"],
  ]) {
    cli(await t.terminal(args, ""), "", 2);
  }
}

async function checkEasyTsTags(t) {
  const { id, constant: n, tag } = t;

  assert.deepEqual(await t.repo({ values: [`  ${tag.toUpperCase()} `, "", "  ", tag, "Ä", "ä", "two words"] }), {
    value: [tag, "ä", "two words"],
    unchanged: true,
  });
  assert.deepEqual(await t.repo({ values: [] }), { value: [], unchanged: true });
  assert.deepEqual(await t.repo({ values: ["constructor", "__proto__", "CONSTRUCTOR", "__PROTO__"] }), {
    value: ["constructor", "__proto__"],
    unchanged: true,
  });
}

async function checkEasyPythonNormalize(t) {
  const { id, constant: n, tag } = t;

  for (const [input, expected] of [
    ["  Straße\tSTRASSE\n\u2003" + tag + "  ", "strasse strasse " + tag + "\n"],
    ["", "\n"],
    ["  \n\t", "\n"],
    ["ΑΒΓ  Σς", "αβγ σσ\n"],
    ["İ\r\nA", "i\u0307 a\n"],
  ])
    cli(await t.terminal([], input), expected);
}

async function checkEasyPythonMerge(t) {
  const { id, constant: n, tag } = t;

  const records = [
    { id: tag, value: { nested: [n] }, keep: true },
    { id: "other", value: [1, 2] },
    { id: tag, extra: { list: [3] }, value: { nested: [n + 1] } },
  ];
  assert.deepEqual(await t.repo({ records }), {
    value: [
      { id: tag, value: { nested: [n + 1] }, keep: true, extra: { list: [3] } },
      { id: "other", value: [1, 2] },
    ],
    unchanged: true,
    detached: true,
  });
  assert.deepEqual(await t.repo({ records: [] }), { value: [], unchanged: true, detached: true });
  assert.deepEqual(
    await t.repo({
      records: [
        { id: 0, value: 1 },
        { id: "0", value: 2 },
        { id: 0, value: 3 },
      ],
    }),
    {
      value: [
        { id: 0, value: 3 },
        { id: "0", value: 2 },
      ],
      unchanged: true,
      detached: true,
    },
  );
}

async function checkEasyGoUnique(t) {
  const { id, constant: n, tag } = t;

  for (const [values, expected] of [
    [null, []],
    [[], []],
    [
      [tag, "", tag, "", "z"],
      [tag, "", "z"],
    ],
    [
      ["Ä", "ä", "Ä"],
      ["Ä", "ä"],
    ],
  ]) {
    assert.deepEqual(await t.repo({ values }), { value: expected, nonNil: true, unchanged: true });
  }
}

async function checkEasyGoLookup(t) {
  const { id, constant: n, tag } = t;

  const root = { [tag]: { deep: null, number: n, leaf: "x" }, constructor: { __data: true }, empty: {} };
  for (const [path, value, exists] of [
    [`${tag}.deep`, null, true],
    [`${tag}.number`, n, true],
    [`${tag}.missing`, null, false],
    [`${tag}.leaf.more`, null, false],
    ["", null, false],
    [`.${tag}`, null, false],
    [`${tag}..deep`, null, false],
    ["constructor.__data", true, true],
    ["empty.any", null, false],
  ])
    assert.deepEqual(await t.repo({ root, path }), { value, exists, unchanged: true });
}

async function checkEasyShellLines(t) {
  const { id, constant: n, tag } = t;

  const directory = await t.directory(`line cases ${tag}`);
  await t.write(directory, "z-last.txt", "one\ntwo");
  await t.write(directory, "a first.txt", `${tag}\n\nlast\n`);
  await t.write(directory, "empty.txt", "");
  await t.write(directory, "unrelated.md", "ignored\n");
  await t.directory("nested.txt", directory);
  await t.symlink("a first.txt", "linked.txt", directory);
  cli(await t.terminal([directory], ""), "a first.txt\t3\nempty.txt\t0\nz-last.txt\t2\n");
  cli(await t.terminal([], ""), "", 2);
  cli(await t.terminal([directory, "extra"], ""), "", 2);
  const empty = await t.directory(`empty ${tag}`);
  cli(await t.terminal([empty], ""), "");
}

const CHECKS = new Map([
  ["easy-rust-window", checkEasyRustWindow],
  ["easy-rust-duration", checkEasyRustDuration],
  ["easy-ts-tags", checkEasyTsTags],
  ["easy-python-normalize", checkEasyPythonNormalize],
  ["easy-python-merge", checkEasyPythonMerge],
  ["easy-go-unique", checkEasyGoUnique],
  ["easy-go-lookup", checkEasyGoLookup],
  ["easy-shell-lines", checkEasyShellLines],
]);

/** Check one original easy task; expected values remain outside the candidate. */
export async function checkEasy(t) {
  const check = CHECKS.get(t.id);
  if (!check) throw new Error("unrecognized easy task");
  await check(t);
}
