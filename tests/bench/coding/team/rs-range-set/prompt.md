# Inclusive integer range union

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Union behavior

Read inclusive integer ranges `a..b` separated by commas, endpoints in [-1000000,1000000]. Sort and merge overlapping or adjacent ranges. Empty input gives empty output.

### Cardinality behavior

Read sorted nonoverlapping inclusive ranges in [-1000000,1000000]. Return the number of integer points. Reject overlaps or wrong ordering; empty input gives `0`.

### Describe behavior

Read a nonnegative integer count and emit `points=<count>` in canonical decimal form.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
