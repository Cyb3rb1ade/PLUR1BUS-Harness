# plur1bus-canon

Canonical JSON and the tool-call action hash, byte-identical to the TypeScript dispatcher
(`packages/core/src/tools/dispatcher.ts`, `canonicalJson` and `ToolDispatcher.#buildCall`). Phase 4, task P4-03.

| Function | What |
|---|---|
| `canonical_json(&Value)` | keys sorted by UTF-16 code unit at every depth, numbers as JavaScript doubles, `JSON.stringify` string escapes |
| `action_hash_input(capability, tool, args, targets, hash_extra)` | the canonical text the dispatcher hashes; an empty `hash_extra` is left out |
| `action_hash(...)` | SHA-256 of that text, lower-case hex |
| `js_number`, `format_double` | `Number.prototype.toString` for a JSON number or a double |

Two processes need the same bytes: the dispatcher in `plur1bus-core` mints the hash (P4-43) and `plur1bus-tools`
recomputes it to check a dispatcher ticket (D120 §11.2) without linking the core. That is why this is a crate.

**`serde_json` with `float_roundtrip`.** `JSON.parse` rounds every decimal to the nearest double; serde_json's default
parser can be one ULP off for a long mantissa (`123456789012345680000` read as `…670000`, vector `exponent-forms`). The
crate enables `float_roundtrip`, and Cargo's feature unification turns it on for every crate built together with this one.
That only makes float parsing exact, and the Rust core's RPC frame parser needs the same for parity (controller ruling,
P4-03).

Parity (mode V): `tests/vectors.rs` reads `fixtures/parity/dispatcher/`, recorded by `scripts/parity/export-dispatcher.ts`
and never edited by hand. Test with `cargo test -p plur1bus-canon --locked`.
