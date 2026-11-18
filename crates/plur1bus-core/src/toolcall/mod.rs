//! The tool-call runtime (plan P4-42, `packages/core/src/toolcall/`): where model output becomes a tool call.
//!
//! - [`json`]: `JSON.parse` and `JSON.stringify` as JavaScript does them, over UTF-16 strings and ordered objects;
//! - [`quirks`]: what each model family accepts and gets wrong;
//! - [`validation`]: the schema vocabulary, the validator, the three repairs and the one model repair round;
//! - [`dialects`]: the wire schema of each provider family, strict mode and its way back;
//! - [`results`]: the byte budget of a result, error envelopes, idempotency keys and batches;
//! - [`tool_use`]: whether a turn needs a tool, and the tool choice of one provider attempt;
//! - [`capabilities`]: the capability index, its ranking and routing, the usage prior and its calibration;
//! - [`registry`]: `state/capabilities.sqlite`, the persistent registry with its full-text index, counters and vectors;
//! - [`math`]: the two functions of the JavaScript math library a ranking stands on;
//! - [`skill_tools`]: `skill.load` and `skill.read`, an admitted skill's instructions and resource files, read-only;
//! - [`tables`]: the stable tool offer, the category taxonomy, the discovery metadata of the shipped tools.
//!
//! A library: nothing here is wired into the front door, and nothing here calls a provider. What the runtime needs from
//! the rest (the model for a repair round, the secret matcher, a store for full results, the clock, the embedding service,
//! the extension feed, the file system of the skill store) is a port.
//!
//! Not ported, on purpose: `coding-bench-*`, `turn-eval*`, `host-eval*` and `eval.ts` (benchmark and evaluation tooling
//! over the runtime, no core behaviour; they stay TypeScript).
pub mod capabilities;
pub mod dialects;
mod first_party_table;
pub mod json;
pub mod math;
pub mod quirks;
pub mod registry;
pub mod results;
pub mod skill_tools;
pub mod tables;
pub mod tool_use;
pub mod validation;

#[cfg(test)]
mod capability_vectors;
#[cfg(test)]
mod skill_vectors;
#[cfg(test)]
mod vectors;
