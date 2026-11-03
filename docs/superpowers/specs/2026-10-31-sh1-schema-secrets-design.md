# SH1: schema-owned configuration sensitivity

The configuration schema defines which declared configuration values contain secrets or secret references. SH1 establishes the annotations and shared metadata; SH2 will wire the consumers to them. The existing name heuristic is retained only as a frozen coverage test.

## Approved policy

- `x-sensitive` remains boolean. Mark secret strings, secret references, string items and objects containing such values. Do not mark numbers, booleans or mixed policy containers.
- Base URLs and endpoint addresses use boolean `x-url-credentials`, without whole-value sensitivity. Consumers mask userinfo and every query value while keeping the host and path visible. Log registration extracts these parts and never registers the complete endpoint URL.
- A webhook URL whose path is a credential is entirely sensitive. A normal callback endpoint with a separate authentication secret remains an endpoint URL.
- Every declared URL field has exactly one classification: URL credentials, whole-value sensitivity, or a documented exception. The schema identifier is public metadata, not an endpoint.
- TypeScript validation returns value-free warnings for URL userinfo, pointing to a sibling secret reference when available. Userinfo adds no validation error and does not change the validated configuration.
- A regression must prove that a standard endpoint does not cause its hostname to be registered or masked in logs.

## Implementation

Add a small, dependency-free schema traversal module for sensitivity lookup, URL-part extraction and validation warnings. Schema-backed maps and arrays retain their annotations. Warnings are optional on successful validation, so warning-free results retain their existing shape; no RPC response or schema changes.

Supported Engine pass-through credentials and endpoint URLs have nonvalidating `x-value-schema` metadata in the Harness schema. Preserve existing opaque validation and the Engine contract. A completeness test compares this metadata with the pinned Engine schema, including known routed-provider credential leaves. Secret-input string/reference-object unions and header string values inherit sensitivity; mixed route arrays remain public containers. The reminder webhook is entirely sensitive because it can carry a path credential.

Generate the complete key reference, including both annotations, from the schema. Keep the tier fixtures generated. The PR documents every heuristic candidate and exception, plus every URL classification.

Generate the complete browser policy separately from the existing editable-settings catalogue. Nonvalidating Engine metadata creates no new controls or palette navigation targets. The palette respects both policy flags at both index inputs: sensitive fields contribute no value; endpoint userinfo and every query value are masked, including URL arrays. SH2 removes the legacy heuristics and migrates the remaining consumers.

## Constraints

TypeScript/JavaScript, schema, scripts and English documentation only. No changes under `crates/**`, no engine contract or RPC schema change, no new dependencies, and no import implementation or `import/prompt/**` changes. Generate test secrets at runtime. Preserve all existing assertions, skips and TODOs. Use Node 24.21 and pnpm 10. Commit as Cyb3rb1ade <cyb3rblade@me.com>; no rebase, amend or force-push. Open a ready PR; the Controller merges it. PR prose is German.
