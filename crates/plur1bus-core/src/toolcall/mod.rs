//! The tool-call runtime (plan P4-42, `packages/core/src/toolcall/`): where model output becomes a tool call.
//!
//! - [`json`]: `JSON.parse` and `JSON.stringify` as JavaScript does them, over UTF-16 strings and ordered objects;
//! - [`quirks`]: what each model family accepts and gets wrong;
//! - [`validation`]: the schema vocabulary, the validator, the three repairs and the one model repair round;
//! - [`dialects`]: the wire schema of each provider family, strict mode and its way back.
//!
//! A library: nothing here is wired into the front door, and nothing here calls a provider. What the runtime needs from
//! the rest (the model for a repair round, the secret matcher, a store for full results, the clock, the embedding service,
//! the extension feed, the file system of the skill store) is a port.
//!
//! Not ported, on purpose: `coding-bench-*`, `turn-eval*`, `host-eval*` and `eval.ts` (benchmark and evaluation tooling
//! over the runtime, no core behaviour; they stay TypeScript).
pub mod dialects;
pub mod json;
pub mod quirks;
pub mod validation;

#[cfg(test)]
mod vectors;
