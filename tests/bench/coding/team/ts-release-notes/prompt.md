# Semantic release notes

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Versions behavior

Read comma-separated stable versions `major.minor.patch`, optional leading `v`. Reject leading zeros except zero itself. Deduplicate and sort by numeric components. Empty input gives empty output.

### Latest behavior

Read normalized comma-separated stable versions and return the numerically greatest one, independent of input order. Empty input gives `none`.

### Notes behavior

Render a stable version as a Markdown heading `## Release <version>` followed by a newline. Render `none` as `No releases` with a newline.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
