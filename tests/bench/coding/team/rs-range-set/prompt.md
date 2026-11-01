# Inclusive integer range union

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## union

File: `src/union.__SEED__.rs`. Function: `solve`.

Read inclusive integer ranges `a..b` separated by commas, endpoints in [-1000000,1000000]. Sort and merge overlapping or adjacent ranges. Empty input gives empty output.

## cardinality

File: `src/cardinality.__SEED__.rs`. Function: `solve`.

Read sorted nonoverlapping inclusive ranges in [-1000000,1000000]. Return the number of integer points. Reject overlaps or wrong ordering; empty input gives `0`.

## describe

File: `src/describe.__SEED__.rs`. Function: `solve`.

Read a nonnegative integer count and emit `points=<count>` in canonical decimal form.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
