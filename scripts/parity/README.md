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
| `export-wire.ts` | `wire` | mode W: the exchanges of `FakeOpenAI` (`packages/core/test/fixtures/openai/server.ts`) and of `localVoiceSocket` (`packages/core/test/voice/local-socket.ts`, over a loopback WebSocket), redacted like the P4-02 transcripts | `crates/plur1bus-core/tests/support/` (P4-03) |

Run: `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-<area>.ts [--check]`

### Known JavaScript/Rust divergences the dispatcher vectors pin down

- **Key order.** `canonicalJson` sorts keys by UTF-16 code unit. For keys outside the BMP this differs from UTF-8 byte order
  (`astral-vs-bmp-key-order`: U+1F600 sorts before U+FF5E in JavaScript, after it in bytes). The Rust side must sort by UTF-16.
- **Numbers.** JavaScript parses every number as a double (`integer-above-2-pow-53`) and prints it with its own rules
  (`exponent-forms`, `negative-zero`). A Rust parser that keeps `u64` or `i64` exactly produces different canonical text.
- **Lone surrogates** cannot exist in a Rust `String` and are therefore not in the vectors.
- **`undefined`** members are skipped by `canonicalJson`; they cannot appear in JSON text and are not in the vectors.
