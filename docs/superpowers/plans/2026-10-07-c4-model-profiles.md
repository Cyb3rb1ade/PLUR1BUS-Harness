# C4 — Model profiles (MoA / fallback) in the config schema

**Scope:** `packages/config-schema` only (plus one Rust test and the generated `docs/config.md` row). No router logic (C1).

## Design
- New top-level key `modelProfiles`: map of profile name (`^[a-z0-9][a-z0-9_-]{0,63}$`) → profile. `x-restart: live`, `x-tier: advanced`, default `{}`.
- Profile: `strategy` (`fallback` default | `moa`), `candidates[]` (1..16, list order = priority, `weight` > 0 ≤ 100, default 1), `aggregator` (moa only), `params` (`temperature` 0..2, `topP` (0,1], `maxTokens` 1..2 000 000), `cache` (`hint` auto|none|prefer, `ttlSeconds` 0..86400). All objects closed.
- Cross-field rules are JSON-Schema `if/then` so the Rust validator (same schema) agrees: `moa` needs ≥ 2 candidates; `aggregator` requires explicit `strategy: "moa"`.
- Migration: additive, no `schemaVersion` bump (RULING); `migrate()` adds `modelProfiles: {}` to a v1 config lacking it; idempotent.
- `config.get/set` unchanged: they are schema-driven (`modelProfiles.<name>` settable by dotted key).

## Tests
Schema valid/invalid/unknown-field cases, migration idempotence, restart plan (TS); Rust `config.set` + validation parity.
