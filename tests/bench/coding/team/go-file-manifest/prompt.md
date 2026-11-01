# Portable file manifest

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## paths

File: `src/paths__SEED__/solution__SEED__.go`. Function: `Solve`.

Read `relative/path:size` records separated by semicolons, with nonnegative integer sizes. Normalize forward-slash dot segments; reject absolute/escaping paths, backslashes, root and colon in a path. Sort by normalized path then numeric size. Empty input gives empty output.

## deduplicate

File: `src/deduplicate__SEED__/solution__SEED__.go`. Function: `Solve`.

Read normalized relative `path:size` records; keep the greatest size per path and emit paths sorted lexically. Reject unnormalized/escaping paths, negatives and malformed rows.

## summary

File: `src/summary__SEED__/solution__SEED__.go`. Function: `Solve`.

Read distinct `path:size` rows and emit `files=<count>;bytes=<sum>`. Reject duplicate paths, negative or malformed sizes. Empty input gives zeros.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
