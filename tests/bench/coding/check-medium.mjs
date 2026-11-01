/** Original MIT medium cases. Inputs vary by seed; expected results never enter agent worktrees. */
import assert from "node:assert/strict";

function cli(result, output, code = 0) {
  assert.equal(result.code, code);
  assert.equal(result.stdout, output);
}
function json(result, value) {
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), value);
}
async function checkMediumRustTokenizer(t) {
  const { id, constant: n, tag } = t;

  for (const [text, expected] of [
    [`  ${tag} "two words" 'three four' a\\ b  `, [tag, "two words", "three four", "a b"]],
    [`"" '' a"b c"d`, ["", "", "ab cd"]],
    ["é\u2003ß\tlast", ["é", "ß", "last"]],
    [String.raw`"a\"b" 'x\y' \"`, ['a"b', String.raw`x\y`, '"']],
    [String.raw`'trailing\'`, ["trailing\\"]],
    ["", []],
    ["\u2003\n", []],
  ])
    assert.deepEqual(await t.repo({ text }), { value: expected });
  for (const text of [`${tag} 'unfinished`, '"unfinished', "unfinished\\", "'x\\", String.raw`'x\'y'`]) {
    assert.deepEqual(await t.repo({ text }), { error: true });
  }
}

async function checkMediumRustWordIndex(t) {
  const { id, constant: n, tag } = t;

  const input = `HELLO  Hello\nÄ\u2003ä ${tag.toUpperCase()} ${tag}\nİx i\u0307x`;
  const rows = [
    ["hello", 2, 0],
    ["ä", 2, Buffer.byteLength("HELLO  Hello\n")],
    [tag, 2, Buffer.byteLength("HELLO  Hello\nÄ\u2003ä ")],
    ["i\u0307x", 2, Buffer.byteLength(`HELLO  Hello\nÄ\u2003ä ${tag.toUpperCase()} ${tag}\n`)],
  ].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  cli(await t.terminal([], input), rows.map((row) => row.join("\t") + "\n").join(""));
  cli(await t.terminal([], ""), "");
  cli(await t.terminal([], " \u2003\n"), "");
  cli(await t.terminal([], "Hi, HI, hi!"), "hi!\t1\t8\nhi,\t2\t0\n");
}

async function checkMediumTsTopology(t) {
  const { id, constant: n, tag } = t;

  const nodes = [tag, "__proto__", "constructor", "last"];
  for (const [edges, value] of [
    [
      [
        ["constructor", tag],
        [tag, "last"],
      ],
      ["__proto__", "constructor", tag, "last"],
    ],
    [
      [
        [tag, "last"],
        [tag, "last"],
      ],
      nodes,
    ],
    [[], nodes],
  ])
    assert.deepEqual(await t.repo({ nodes, edges }), { value, unchanged: true });
  assert.deepEqual(await t.repo({ nodes: [], edges: [] }), { value: [], unchanged: true });
  for (const [badNodes, edges] of [
    [nodes, [[tag, "missing"]]],
    [nodes, [[tag, tag]]],
    [
      nodes,
      [
        [tag, "last"],
        ["last", tag],
      ],
    ],
    [[tag, tag], []],
  ])
    assert.deepEqual(await t.repo({ nodes: badNodes, edges }), { error: true, unchanged: true });
}

async function checkMediumTsMigrate(t) {
  const { id, constant: n, tag } = t;

  json(
    await t.terminal(
      [],
      JSON.stringify({
        version: 1,
        entries: [
          { key: ` ${tag} `, value: " keep spaces " },
          { key: "__proto__", value: "data" },
          { key: "constructor", value: String(n) },
        ],
      }),
    ),
    {
      version: 2,
      values: Object.fromEntries([
        [tag, " keep spaces "],
        ["__proto__", "data"],
        ["constructor", String(n)],
      ]),
    },
  );
  json(await t.terminal([], '{"version":1,"entries":[]}'), { version: 2, values: {} });
  for (const input of [
    "null",
    "[]",
    "{}",
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":[],"extra":true}',
    '{"version":1,"entries":null}',
    '{"version":1,"entries":[{"key":"x","value":1}]}',
    '{"version":1,"entries":[{"key":" ","value":"a"}]}',
    '{"version":1,"entries":[{"key":"x","value":"a","extra":0}]}',
    '{"version":1,"entries":[{"key":"x","value":"a"},{"key":" x ","value":"b"}]}',
    '{"version":1,"entries":[]} trailing',
    "{",
  ])
    cli(await t.terminal([], input), "", 2);
}

async function checkMediumPythonLog(t) {
  const { id, constant: n, tag } = t;

  const valid = [
    { service: tag, latency: n },
    { service: "Ä", latency: 0 },
    { service: tag, latency: 0.5 },
  ];
  const invalid = [
    "not JSON",
    "null",
    "[]",
    '{"service":"x","latency":true}',
    '{"service":"","latency":2}',
    '{"service":"x","latency":-1}',
    '{"service":"x","latency":1,"unknown":0}',
    '{"service":"x","latency":NaN}',
  ];
  const input = [
    JSON.stringify(valid[0]),
    "  ",
    invalid[0],
    JSON.stringify(valid[1]),
    ...invalid.slice(1),
    JSON.stringify(valid[2]),
    "",
  ].join("\n");
  json(await t.terminal([], input), {
    invalid: invalid.length,
    services: [
      { service: tag, count: 2, total: n + 0.5, max: n },
      { service: "Ä", count: 1, total: 0, max: 0 },
    ],
  });
  json(await t.terminal([], "\n\t\n"), { invalid: 0, services: [] });
  json(await t.terminal([], "bad\n{}"), { invalid: 2, services: [] });
}

async function checkMediumGoTruncate(t) {
  const { id, constant: n, tag } = t;

  for (const [limit, expected] of [
    [0, ""],
    [1, "A"],
    [2, "A"],
    [3, "Aä"],
    [4, "Aä"],
    [6, "Aä"],
    [7, "Aä🧪"],
    [8, "Aä🧪Z"],
    [999, "Aä🧪Z"],
    ["0003", "Aä"],
    ["999999999999999999999999999999", "Aä🧪Z"],
  ])
    cli(await t.terminal([String(limit)], "Aä🧪Z"), expected);
  for (const args of [[], ["-1"], ["+1"], ["1.5"], [" 2"], [""], ["1", "extra"], ["१"]]) {
    cli(await t.terminal(args, tag), "", 2);
  }
  cli(await t.terminal(["0"], Buffer.from([0xff])), "", 2);
}

async function checkMediumGoConfig(t) {
  const { id, constant: n, tag } = t;

  json(await t.terminal([], "{}"), { port: n, flags: [] });
  json(await t.terminal([], JSON.stringify({ port: 65535, flags: [` ${tag} `, "", tag, " x ", "x", "\t"] })), {
    port: 65535,
    flags: [tag, "x"],
  });
  for (const input of [
    "null",
    "[]",
    "{} {}",
    '{"port":0}',
    '{"port":65536}',
    '{"port":true}',
    '{"port":1.5}',
    '{"port":"2"}',
    '{"port":null}',
    '{"flags":null}',
    '{"flags":[1]}',
    '{"flags":[null]}',
    '{"flags":["ok",null]}',
    '{"flags":"x"}',
    '{"port":2,"port":3}',
    '{"unknown":0}',
    '{"flags":[],"flags":[]}',
  ]) {
    cli(await t.terminal([], input), "", 2);
  }
}

async function checkMediumShellRetain(t) {
  const { id, constant: n, tag } = t;

  const directory = await t.directory(`snapshots ${tag}`);
  for (const name of [
    "snap-1.dat",
    "snap-10.dat",
    "snap-0010.dat",
    "snap-100.dat",
    "snap-300.dat",
    "keep.txt",
    "snap-x.dat",
  ]) {
    await t.write(directory, name, tag);
  }
  await t.directory("snap-999.dat", directory);
  await t.symlink("keep.txt", "snap-888.dat", directory);
  cli(await t.terminal([directory, "3"], ""), "");
  assert.deepEqual(await t.names(directory), [
    "keep.txt",
    "snap-0010.dat",
    "snap-100.dat",
    "snap-300.dat",
    "snap-888.dat",
    "snap-999.dat",
    "snap-x.dat",
  ]);
  const before = await t.names(directory);
  for (const count of ["-1", "2x", ""]) {
    cli(await t.terminal([directory, count], ""), "", 2);
    assert.deepEqual(await t.names(directory), before);
  }
  cli(await t.terminal([directory, "0"], ""), "");
  assert.deepEqual(await t.names(directory), ["keep.txt", "snap-888.dat", "snap-999.dat", "snap-x.dat"]);
}

const CHECKS = new Map([
  ["medium-rust-tokenizer", checkMediumRustTokenizer],
  ["medium-rust-word-index", checkMediumRustWordIndex],
  ["medium-ts-topology", checkMediumTsTopology],
  ["medium-ts-migrate", checkMediumTsMigrate],
  ["medium-python-log", checkMediumPythonLog],
  ["medium-go-truncate", checkMediumGoTruncate],
  ["medium-go-config", checkMediumGoConfig],
  ["medium-shell-retain", checkMediumShellRetain],
]);

/** Check one original medium task; expected values remain outside the candidate. */
export async function checkMedium(t) {
  const check = CHECKS.get(t.id);
  if (!check) throw new Error("unrecognized medium task");
  await check(t);
}
