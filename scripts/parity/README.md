# Parity vector exporters (Phase 4, mode V)

Phase 4 moves the TypeScript core to Rust (D129, D131, ADR-019). A pure-function TypeScript test becomes a **vector set**
that the Rust crate reads. This directory holds the convention and the exporters. The five parity modes are described in
`docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §3; this is mode V.

## The rule

Vectors are **recorded by the exporter and never edited by hand**. A hand edit is a bug in the exporter or in the TypeScript
function, and the way to find out which is to change one of them and re-run. After the cut (P4-90) the vectors stay as frozen
Rust regression data.

## Layout

| Path | What |
| --- | --- |
| `scripts/parity/lib.mjs` | `exporterMain`, `writeFixture`, `fixtureText`: the one writer every exporter uses |
| `scripts/parity/export-<area>.ts` | one exporter per area; imports the real TypeScript implementation |
| `scripts/parity/parity.test.ts` | tests of the writer and of every exporter's committed output |
| `fixtures/parity/<area>/<name>.json` | the recorded vectors |

## The writer

`fixtures/parity/<area>/*.json` is written deterministically: object keys sorted at every depth (UTF-16 code unit order),
two-space indent, one trailing newline. `<area>` and `<name>` match `[a-z0-9][a-z0-9-]*`. An exporter calls

```js
process.exit(await exporterMain({ area: "dispatcher", build: async () => ({ "canonical-json": {...}, "action-hash": {...} }) }));
```

and gets `--check` for free: it writes nothing and exits 1 when a fixture is missing or differs from the exporter's output.

## Writing an exporter

1. Import the real function (`packages/core/src/...`); never re-implement it in the exporter. Where the value you need is
   private (the action hash is computed inside `ToolDispatcher`), drive the real object and capture it, then cross-check with
   an independent computation, as `export-dispatcher.ts` does.
2. Give every case a `name`. Inputs that carry numbers are stored as raw JSON text (`inputJson`), so the Rust side parses
   exactly what TypeScript parsed.
3. Put a `note` on a case that exists to catch a known divergence between JavaScript and Rust.
4. Add a test to `scripts/parity/parity.test.ts` that the committed file equals the exporter's output (the stale-vector guard).
5. A change under `packages/*/src/` needed for an exporter carries the commit trailer `Phase4: vectors <WP>`.

## Exporters

| Exporter | Area | Source | Consumer |
| --- | --- | --- | --- |
| `export-dispatcher.ts` | `dispatcher` | `canonicalJson` and the action hash of `packages/core/src/tools/dispatcher.ts` (the D120 §11.2 T1 vectors) | `crates/plur1bus-canon` (P4-03) |
| `export-formats.ts` | `formats` | ajv-formats' verdicts (configured as `packages/rpc-schema/src/index.ts` does) on edge-case `date`, `date-time`, `uri` and `uuid` strings (P4-03 review F6) | `crates/plur1bus-rpc/tests/server_dispatch.rs` (P4-10) |
| `export-auth.ts` | `auth` | module-api's verdicts of `verifyApiDelegation` (with `validApiPrincipal`, `validBinding`, `isIdentifier`), `verifyEngineDelegation` with the handshake's token rule, and `checkAdoptionNonce`; credentials are markers (`@api@`, ...) that both sides replace with fresh values; the `String()` coercion of `role`/`kind` is noted as P4D-8 (P4-10 task review L9); `request-id`: `validateRequest`'s verdict, detail and echoed id for request ids as written on the wire (P4-10 fix round 1b F8) | `crates/plur1bus-core/src/auth.rs`, `crates/plur1bus-core/src/server.rs` (P4-10) |
| `export-wire.ts` | `wire` | mode W: the exchanges of `FakeOpenAI` (`packages/core/test/fixtures/openai/server.ts`) and of `localVoiceSocket` (`packages/core/test/voice/local-socket.ts`, over a loopback WebSocket), redacted like the P4-02 transcripts | `crates/plur1bus-core/tests/support/` (P4-03) |
| `export-logs.ts` | `logs` | the D111 redactor and the log write path of `packages/core/src/logs/` (`levels`, `trace`, `output`: `sanitise`/`signalLevel`/`cap`, `files`: listing and collation, `lines`: the streaming reader over generated files, `records`: op sequences against a writer with a fixed clock and trace, recorded as TypeScript lines plus the canonical Rust line); the redactor:  `createRedactor` (rules 1 to 6, `secretsOnly`, `secretForms`, `textWindow`), `isSecretKey`, `maskSecretsInJson`, the exact-value `SecretMatcher` (spans, windows, bytes, `scanJson`), `secretFormsOf`/`secretFormsIn`, `wellFormedPrefix`, `jsonEscapeView`, `jsonSecretViews`; strings with a lone surrogate are `{units}`, credential-shaped canaries of the TypeScript tests are `{parts}` (fragments, never one piece); the divergences are cases with a `note`; task 3 (`query.json`, `methods.json`): the log query (`runQuery` scans over generated files with the records, `scanned.bytes` and cursor of each order, `fingerprint`/`mintCursor`/`decodeCursor`) and the `logs.query`/`logs.tail`/`logs.levels` handlers (bounds verdicts, tail scenarios with a fake clock and sleep, level changes with their audit events); dates are UTC-only so the files do not depend on `TZ`; the divergences (legacy `Date.parse` forms, zoneless forms read as UTC, sorted keys, serde_json number limits) are cases with a `note` | `crates/plur1bus-log-schema/tests/redact_vectors.rs`, `crates/plur1bus-core/src/logs/redact.rs`, `crates/plur1bus-core/src/logs/vectors.rs`, `crates/plur1bus-core/src/logs/query_vectors.rs` (P4-11) |
| `export-config.ts` | `config` | the core's configuration modules (`packages/core/src/{config-load,config-disclosure,engine-config}.ts`, `flattenPatch` of `config-source.ts`, `configurationWarnings`): verdict and error lists of `structureErrors`/`validateConfig` over the config-schema fixtures and hardening cases, warnings over custom schemas, the module disclosure policy over generated `modules/` directories, `buildEngineConfig`/`engineEmbedding` (the configuration as `set` edits of `defaults()`; the engine catalogue as recorded `catalog` facts) and `flattenPatch` with its refusals; replayed by `crates/plur1bus-core/src/config/vectors.rs` |
| `export-metrics.ts` | `metrics` | the metrics registry and the harness's metric set (`packages/core/src/metrics/{registry,metrics}.ts`): scripted registry operations (declarations with their refusals and messages, `inc`/`set`/`observe`/`initAll`, `gaugeFn` values and failures, escaping, `String(number)` printing, `localeCompare` series order) and `createMetrics` call sequences (RPC calls over the schema's core method list, turns, provider errors, inbox, learning, turn telemetry with its bounded quantile sample, gauges from health and memory), each step with the TypeScript result (`{ ok }`, `{ error }`, `{ text }` exposition, `{ summary }`); numbers that JSON cannot hold are strings, label specifications are `[name, values]` pairs; replayed by `crates/plur1bus-core/src/metrics/metrics.rs` (module `vectors`) |

Run: `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-<area>.ts [--check]`

### Known JavaScript/Rust divergences the dispatcher vectors pin down

- **Key order.** `canonicalJson` sorts keys by UTF-16 code unit. For keys outside the BMP this differs from UTF-8 byte order
  (`astral-vs-bmp-key-order`: U+1F600 sorts before U+FF5E in JavaScript, after it in bytes). The Rust side must sort by UTF-16.
- **Numbers.** JavaScript parses every number as a double (`integer-above-2-pow-53`) and prints it with its own rules
  (`exponent-forms`, `negative-zero`). A Rust parser that keeps `u64` or `i64` exactly produces different canonical text.
- **Lone surrogates** cannot exist in a Rust `String` and are therefore not in the vectors.
- **`undefined`** members are skipped by `canonicalJson`; they cannot appear in JSON text and are not in the vectors.
- **Error wording of the schema walk** (`config`, `validate`): `plur1bus-config` words ajv's keyword errors its own way (`must match the declared pattern` against `must match pattern "..."`). The replay requires the same verdict, the same number of errors and the same path per error, and compares the core's own rules (structure, cross-field, privacy) to the letter.
- **Key order and JSON syntax** (`config`): inputs are key-sorted before the TypeScript runs, since a `serde_json::Map` is sorted; JSON syntax error positions and the recursion-limit text are not compared.
- **Hostnames** (`config`): the endpoint parser of the Rust port does no IDNA; Unicode hosts stay as written.
- **Lone surrogates in the redactor vectors** (`logs`): a stored string is `{ "units": [...] }` when it is not well-formed; the Rust
  replay works on UTF-16 code units (`text_units`, `SecretMatcher::new(Vec<Vec<u16>>)`). A JSON *text* with a lone surrogate
  escape is refused by `serde_json`; those `maskJson` cases (`loneSurrogate`) are checked through the scan only.
- **Regex dialect** (`logs`): the patterns of `redaction.json` run in the `regex` crate. A `(?i)` pattern folds case by Unicode
  simple folding where a JavaScript `/i` regexp without `u` does not (`unicode-fold-kelvin-sign-in-a-header-name`: Rust redacts
  more), and `\s` is `White_Space` where JavaScript's is not (U+FEFF, U+0085: `js-whitespace-*-after-bearer`). The code-level
  scans (`key=value`, URLs, paths) use JavaScript's `\s` exactly (`is_js_space`).
- **Object key order** (`logs`): JavaScript numbers repeated keys in insertion order (`secrets-only-repeated-key-numbering`); a
  `serde_json::Map` iterates in key order, so the Rust replay pins its own numbering.
- **Attribute key order of a written line** (`logs`, `records`): a TypeScript object keeps insertion order, a `serde_json::Map` is
  sorted. The Rust writer therefore writes `attrs` (and the extra fields of a legacy line) with sorted keys; the top-level keys
  follow `key_order()` and the source is `kind, id, version`, as in TypeScript. A case whose TypeScript line differs only in that
  order carries a `note` and the line the Rust writer produces (`canonical`); both parse to the same value. A float with no
  fraction would print `1.0` in Rust and `1` in JavaScript; no vector holds one.
- **Collation** (`logs`, `files`): `listLogFiles` sorts components with `localeCompare`; `locale_compare` reproduces the ICU order
  for the characters a component can hold (`_`, `-`, `.`, digits, letters; case-insensitive first, lower case before upper case at
  the first difference). The vector is recorded under the default locale of the recording machine.
- **Collation and number printing** (`metrics`): series are sorted by `localeCompare` of the joined label values. The Rust `locale_compare` of `registry.rs` is ICU's root order for ASCII (white space, punctuation and symbols in the CLDR order, digits, letters with lower case before upper case, control characters ignorable, so `a\0b` and `ab` tie and keep their insertion order) and falls back to code points beyond ASCII; the vectors use ASCII label values only. Numbers are written as JavaScript's `String(number)`; `maxSeries` that is not an integer in `1..16384` is one error in TypeScript, and in Rust a bound of `u64` where a non-integer replays as 0.
