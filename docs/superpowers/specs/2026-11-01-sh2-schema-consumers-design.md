# SH2: schema-owned configuration consumers

The Owner approved SH2 after SH1, including the necessary Rust implementation. The schema is the authority for
configuration sensitivity. `x-sensitive` hides literal secret values; `x-url-credentials` hides userinfo
and every query value while retaining the endpoint host and path. Register only those extracted URL parts in logs.

Public `config.get` keeps its existing result keys, JSON types, revision and unknown members. Mask the configuration
before selecting a key or tier. Internal consumers that need runtime values or write configurations use the existing
authenticated `config.watch` snapshot and `config.changed`, which remain private to local runtime clients. Never
write a masked public snapshot back to disk or use it for provisioning compensation.

Reference subschemas carry `x-secret-reference`. Matching, safe reference names remain readable in all views,
provisioning metadata, audit and logs, and never enter the global text registry. Literal values and unsafe reference
values are masked and registered. Schema-owned source-specific name rules reject pasted-key prefixes, excessive
length and high entropy; validation warns without echoing the value. Store values remain protected independently.

Web settings use generated policy metadata. Literal sensitive values are replacement inputs, never initial drafts or review
text. An untouched replacement input sends no change. Endpoint replacement controls retain a masked view of the
current host/path. Keep URL-array members separate until palette rendering so repeated masking cannot hide later
public endpoints. Remove configuration-name heuristics; keep unrelated free-text/file security rules.

The Core registers declared configuration values before flushing early logs, and replaces that registration group
before accepted-change listeners run. Share the registry with the store and existing output redactors. Removed
configuration values become retired values under the existing bound. Store preload and the SH3 encoding, clipping,
cache and load work remain SH3.

Rust public output, audit, validation diagnostics and support bundles share the same annotation semantics, including
known Engine metadata and installed module configuration schemas. Validation errors retain paths and constraints,
without printing instance values. Support bundles retain their existing pattern backstop and refusal on rescan.
Register declared values before configuration-bearing supervisor logs and accepted configuration updates. Check
captured process output separately, with a reproduction before changing it.

The old Rust marker test already contains a hard assertion. Extend its metadata coverage without claiming that a
TODO was activated. Turn the Web marker TODO into a real regression test. Generate all canary values at runtime.

Owner ruling 2026-11-01: regular backups preserve schema-declared reference forms without reading the store, mask
literal sensitive values and URL userinfo/query values, list replaced key names in the manifest and report required
re-entry after restore. Keep existing webhook regeneration and portable encrypted-backup behavior unchanged.

No new dependencies, RPC schema/result-shape changes, Engine-contract changes, import implementation changes or
unrelated A2A/MCP/OAuth/API feature work. Follow `docs/coding-standard.md`. Run checks sequentially, including full
Core and Web tests, Rust formatting, clippy with warnings denied, and `cargo test -p plur1bus`. Obtain a fresh
read-only review and an actual Claude review before publishing one ready PR. The Controller merges it.
