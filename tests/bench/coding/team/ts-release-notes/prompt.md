# Semantic release notes

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## versions

File: `src/versions.__SEED__.ts`. Function: `solve`.

Read comma-separated stable versions `major.minor.patch`, optional leading `v`. Reject leading zeros except zero itself. Deduplicate and sort by numeric components. Empty input gives empty output.

## latest

File: `src/latest.__SEED__.ts`. Function: `solve`.

Read normalized comma-separated stable versions and return the numerically greatest one, independent of input order. Empty input gives `none`.

## notes

File: `src/notes.__SEED__.ts`. Function: `solve`.

Render a stable version as a Markdown heading `## Release <version>` followed by a newline. Render `none` as `No releases` with a newline.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
