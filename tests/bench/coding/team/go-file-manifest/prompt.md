# Portable file manifest

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Paths behavior

Read `relative/path:size` records separated by semicolons, with nonnegative integer sizes. Normalize forward-slash dot segments; reject absolute/escaping paths, backslashes, root and colon in a path. Sort by normalized path then numeric size. Empty input gives empty output.

### Deduplicate behavior

Read normalized relative `path:size` records; keep the greatest size per path and emit paths sorted lexically. Reject unnormalized/escaping paths, negatives and malformed rows.

### Summary behavior

Read distinct `path:size` rows and emit `files=<count>;bytes=<sum>`. Reject duplicate paths, negative or malformed sizes. Empty input gives zeros.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
