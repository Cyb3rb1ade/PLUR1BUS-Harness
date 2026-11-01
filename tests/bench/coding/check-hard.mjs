/** Original MIT hard cases. The coordinator owns expectations and inspects committed file effects. */
import assert from "node:assert/strict";

function cli(result, output, code = 0) {
  assert.equal(result.code, code);
  assert.equal(result.stdout, output);
}

function orderedJson(result, expected) {
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^[^\r\n]*\n$/u);
  const value = JSON.parse(result.stdout);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(Object.values(value).every((item) => typeof item === "string"));
  const fields = [...result.stdout.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*")/gu)].map((match) => [
    JSON.parse(match[1]),
    JSON.parse(match[2]),
  ]);
  assert.deepEqual(fields, expected);
}
async function checkHardRustIntervals(t) {
  const { id, constant: n, tag } = t;

  for (const [input, value] of [
    [
      [
        [n + 5, n],
        [n + 7, n + 6],
        [-3, -1],
        [-2, 0],
      ],
      [
        [-3, 0],
        [n, n + 7],
      ],
    ],
    [[], []],
    [
      [
        [4, 4],
        [4, 4],
        [6, 7],
      ],
      [
        [4, 4],
        [6, 7],
      ],
    ],
    [
      [
        ["9223372036854775807", "9223372036854775807"],
        ["9223372036854775806", "9223372036854775806"],
      ],
      [["9223372036854775806", "9223372036854775807"]],
    ],
    [
      [
        ["-9223372036854775808", "-9223372036854775808"],
        ["-9223372036854775807", "-9223372036854775807"],
      ],
      [["-9223372036854775808", "-9223372036854775807"]],
    ],
  ])
    assert.deepEqual(await t.repo({ intervals: input.map((row) => row.map(String)) }), {
      value: value.map((row) => row.map(String)),
    });
}

async function checkHardTsWorkers(t) {
  const { id, constant: n, tag } = t;

  const success = await t.repo({ items: [n, n + 1, n + 2, n + 3], limit: 2, delays: [20, 2, 3, 1], mode: "success" });
  assert.deepEqual(success.value, [n, n + 2, n + 4, n + 6]);
  assert.equal(success.state, "resolved");
  assert.equal(success.unchanged, true);
  assert.equal(success.calls, 4);
  assert.equal(success.peak, 2);
  assert.equal(success.finished, 4);
  assert.equal(success.unhandled, 0);
  const occupancy = await t.repo({ items: [n, n + 1, n + 2, n + 3], limit: 2, mode: "occupancy", releaseIndex: 1 });
  assert.equal(occupancy.state, "resolved");
  assert.deepEqual(occupancy.value, [n, n + 2, n + 4, n + 6]);
  assert.deepEqual(occupancy.afterRelease, { started: [0, 1, 2], finished: [1] });
  for (const mode of ["failure", "abort"]) {
    const result = await t.repo({ items: [n, n + 1, n + 2, n + 3], limit: 2, delays: [2, 25, 1, 1], mode });
    assert.deepEqual(result, {
      state: "rejected",
      sameReason: true,
      calls: 2,
      peak: 2,
      finished: 2,
      unchanged: true,
      unhandled: 0,
    });
  }
  const aborted = await t.repo({ items: [n], limit: 1, delays: [1], mode: "pre-aborted" });
  assert.deepEqual(aborted, {
    state: "rejected",
    sameReason: true,
    calls: 0,
    peak: 0,
    finished: 0,
    unchanged: true,
    unhandled: 0,
  });
  for (const limit of [0, -1, 1.5]) {
    const bad = await t.repo({ items: [n], limit, delays: [1], mode: "success" });
    assert.equal(bad.state, "rejected");
    assert.equal(bad.calls, 0);
    assert.equal(bad.unhandled, 0);
  }
  const empty = await t.repo({ items: [], limit: 1, delays: [], mode: "success" });
  assert.equal(empty.state, "resolved");
  assert.deepEqual(empty.value, []);
  assert.equal(empty.calls, 0);
}

async function checkHardTsEvents(t) {
  const { id, constant: n, tag } = t;

  const events = [
    { id: tag + "-last", seq: 9, key: "gone", op: "delete" },
    { id: tag + "-first", seq: 1, key: "gone", op: "put", value: "old" },
    { id: tag + "-data", seq: 3, key: "__proto__", op: "put", value: "safe" },
    { id: tag + "-ten", seq: 4, key: "10", op: "put", value: "ten" },
    { id: tag + "-two", seq: 2, key: "2", op: "put", value: String(n) },
    { id: tag + "-bmp", seq: 5, key: "\ue000", op: "put", value: "bmp" },
    { id: tag + "-astral", seq: 6, key: "🧪", op: "put", value: "astral" },
  ];
  orderedJson(await t.terminal([], JSON.stringify(events)), [
    ["10", "ten"],
    ["2", String(n)],
    ["__proto__", "safe"],
    ["\ue000", "bmp"],
    ["🧪", "astral"],
  ]);
  cli(await t.terminal([], "[]"), "{}\n");
  for (const value of [
    null,
    {},
    [events[0], events[0]],
    [events[0], { ...events[1], seq: events[0].seq }],
    [{ ...events[0], seq: -1 }],
    [{ ...events[0], seq: 1.5 }],
    [{ ...events[0], seq: 9007199254740992 }],
    [{ ...events[0], id: "" }],
    [{ ...events[0], key: "" }],
    [{ ...events[0], value: "forbidden" }],
    [{ id: "x", seq: 1, key: "a", op: "put" }],
    [{ ...events[1], extra: 0 }],
  ])
    cli(await t.terminal([], JSON.stringify(value)), "", 2);
  cli(await t.terminal([], JSON.stringify(events) + " trailing"), "", 2);
}

async function checkHardPythonSqlite(t) {
  const { id, constant: n, tag } = t;

  const rows = [
    [8, "K"],
    [3, "Ada-2"],
    [1, "Ada"],
    [5, ""],
    [2, "ADA"],
    [10, `Z${n}++`],
  ];
  const prepared = await t.sqlite("base", rows);
  const migrated = await t.repo({ database: prepared.path, repeat: true });
  assert.equal(migrated.state, "resolved");
  assert.equal(migrated.secondState, "resolved");
  assert.equal(migrated.inTransaction, false);
  const stored = await t.inspectSqlite(prepared.path);
  assert.deepEqual(stored.columns, ["id", "name", "slug"]);
  assert.equal(stored.uniqueSlug, true);
  assert.equal(stored.slugNotNull, true);
  assert.deepEqual(stored.rows, [
    [1, "Ada", "ada"],
    [2, "ADA", "ada-2"],
    [3, "Ada-2", "ada-2-2"],
    [5, "", "person"],
    [8, "K", "person-2"],
    [10, `Z${n}++`, `z${n}`],
  ]);
  for (const schema of ["partial", "incompatible"]) {
    const original = await t.sqlite(schema, [[n, tag]]);
    const result = await t.repo({ database: original.path, repeat: false });
    assert.equal(result.state, "rejected");
    assert.equal(result.inTransaction, false);
    assert.deepEqual(await t.inspectSqlite(original.path), original.snapshot);
  }
  const rollback = await t.sqlite("base", [[n, tag]]);
  const refused = await t.repo({ database: rollback.path, denyCommit: true, repeat: false });
  assert.equal(refused.state, "rejected");
  assert.equal(refused.inTransaction, false);
  assert.deepEqual(await t.inspectSqlite(rollback.path), rollback.snapshot);
}

async function checkHardPythonCache(t) {
  const { id, constant: n, tag } = t;

  const directory = await t.directory(`cache ${tag}`),
    path = await t.filePath(directory, "value.json");
  const now = 1000 + n,
    fresh = JSON.stringify({ savedAt: now - 1, value: { kept: tag } });
  await t.write(directory, "value.json", fresh, 0o640);
  assert.deepEqual(await t.repo({ path, now, ttl: 10, compute: { kind: "raise" } }), {
    state: "resolved",
    value: { kept: tag },
    calls: 0,
  });
  assert.equal(await t.read(directory, "value.json"), fresh);
  const stale = JSON.stringify({ savedAt: now - 20, value: "old" });
  for (const raw of [
    stale,
    "bad JSON",
    JSON.stringify({ savedAt: now + 5, value: "future" }),
    `{"savedAt":${now},"value":NaN}`,
  ]) {
    await t.write(directory, "value.json", raw, 0o640);
    const result = await t.repo({ path, now, ttl: 10, compute: { kind: "value", value: { refreshed: n } } });
    assert.deepEqual(result, { state: "resolved", value: { refreshed: n }, calls: 1 });
    assert.deepEqual(JSON.parse(await t.read(directory, "value.json")), { savedAt: now, value: { refreshed: n } });
    assert.equal(await t.mode(directory, "value.json"), 0o640);
    assert.deepEqual(await t.names(directory), ["value.json"]);
  }
  for (const compute of [{ kind: "raise" }, { kind: "invalid" }, { kind: "value", value: n, replaceFailure: true }]) {
    await t.write(directory, "value.json", stale, 0o640);
    assert.deepEqual(await t.repo({ path, now, ttl: 10, compute }), { state: "rejected", calls: 1 });
    assert.equal(await t.read(directory, "value.json"), stale);
    assert.equal(await t.mode(directory, "value.json"), 0o640);
    assert.deepEqual(await t.names(directory), ["value.json"]);
  }
  await t.remove(directory, "value.json");
  assert.deepEqual(await t.repo({ path, now, ttl: 0, compute: { kind: "value", value: n } }), {
    state: "resolved",
    value: n,
    calls: 1,
  });
  assert.equal(await t.mode(directory, "value.json"), 0o600);
  await t.write(directory, "target.json", fresh);
  await t.remove(directory, "value.json");
  await t.symlink("target.json", "value.json", directory);
  assert.deepEqual(await t.repo({ path, now, ttl: 10, compute: { kind: "value", value: n } }), {
    state: "rejected",
    calls: 0,
  });
  assert.equal(await t.read(directory, "target.json"), fresh);
}

async function checkHardGoNdjson(t) {
  const { id, constant: n, tag } = t;

  const one = JSON.stringify({ name: tag, value: n }),
    two = '{"name":"second","value":-9223372036854775808}';
  const text = Buffer.from(one + "\r\n\n" + two);
  assert.deepEqual(
    await t.repo({ chunks: [...text].map((byte) => Buffer.from([byte]).toString("base64")), limit: 128 }),
    {
      value: [
        { name: tag, value: String(n) },
        { name: "second", value: "-9223372036854775808" },
      ],
      nonNil: true,
    },
  );
  assert.deepEqual(await t.repo({ chunks: [], limit: 1 }), { value: [], nonNil: true });
  assert.deepEqual(await t.repo({ chunks: [Buffer.from(one).toString("base64")], limit: Buffer.byteLength(one) }), {
    value: [{ name: tag, value: String(n) }],
    nonNil: true,
  });
  for (const bad of [
    '{"name":"x"}',
    '{"name":"","value":1}',
    '{"name":"x","value":null}',
    '{"name":"x","value":1,"extra":0}',
    '{"name":"x","name":"y","value":1}',
    '{"name":"x","value":9223372036854775808}',
    '{"name":"x","value":1} {}',
  ]) {
    const chunks = [Buffer.from(one + "\n" + bad).toString("base64")];
    assert.deepEqual(await t.repo({ chunks, limit: 128 }), { error: true, nil: true });
  }
  for (const input of [
    { chunks: [Buffer.from(one).toString("base64")], limit: 1 },
    { chunks: [], limit: 0 },
    { chunks: [Buffer.from([0xff, 10]).toString("base64")], limit: 128 },
  ]) {
    assert.deepEqual(await t.repo(input), { error: true, nil: true });
  }
}

async function checkHardShellExport(t) {
  const { id, constant: n, tag } = t;

  const directory = await t.directory(`export ${tag}`),
    source = await t.filePath(directory, "-input.txt");
  const output = await t.filePath(directory, "-output.tsv");
  await t.write(directory, "-output.tsv", "old bytes\n", 0o640);
  await t.write(directory, "-input.txt", "0008\n\n0\n999999999");
  cli(await t.terminal([source, output], ""), "");
  assert.equal(await t.read(directory, "-output.tsv"), `0008\t${8 + n}\n0\t${n}\n999999999\t${999999999 + n}\n`);
  assert.equal(await t.mode(directory, "-output.tsv"), 0o640);
  for (const invalid of ["1\nwrong\n2\n", "1\n-2\n", "1\n1000000000\n"]) {
    const previous = await t.read(directory, "-output.tsv");
    await t.write(directory, "-input.txt", invalid);
    cli(await t.terminal([source, output], ""), "", 2);
    assert.equal(await t.read(directory, "-output.tsv"), previous);
    assert.equal(await t.mode(directory, "-output.tsv"), 0o640);
    assert.deepEqual(await t.names(directory), ["-input.txt", "-output.tsv"]);
  }
  await t.remove(directory, "-output.tsv");
  await t.write(directory, "-input.txt", "");
  cli(await t.terminal([source, output], ""), "");
  assert.equal(await t.mode(directory, "-output.tsv"), 0o600);
  assert.equal(await t.read(directory, "-output.tsv"), "");
}

async function checkHardShellPaths(t) {
  const { id, constant: n, tag } = t;

  cli(await t.terminal([], `./${tag}/./file\nα/β\nplain\n`), `${tag}/file\nα/β\nplain\n`);
  cli(await t.terminal([], ""), "");
  for (const path of [
    "",
    "/absolute",
    "../up",
    "a/../up",
    "a//b",
    "a/",
    ".",
    "././",
    "C:relative",
    "D:/absolute",
    "a\\b",
  ]) {
    cli(await t.terminal([], `${tag}/valid\n${path}\n`), "", 2);
  }
}

const CHECKS = new Map([
  ["hard-rust-intervals", checkHardRustIntervals],
  ["hard-ts-workers", checkHardTsWorkers],
  ["hard-ts-events", checkHardTsEvents],
  ["hard-python-sqlite", checkHardPythonSqlite],
  ["hard-python-cache", checkHardPythonCache],
  ["hard-go-ndjson", checkHardGoNdjson],
  ["hard-shell-export", checkHardShellExport],
  ["hard-shell-paths", checkHardShellPaths],
]);

/** Check one original hard task; expected values remain outside the candidate. */
export async function checkHard(t) {
  const check = CHECKS.get(t.id);
  if (!check) throw new Error("unrecognized hard task");
  await check(t);
}
