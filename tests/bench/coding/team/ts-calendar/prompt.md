# Half-open calendar availability

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## merge

File: `src/merge.__SEED__.ts`. Function: `solve`.

Read comma-separated half-open integer intervals `start..end` with 0 <= start < end <= 100. Merge overlaps and touching intervals, sort by start. Empty input gives empty output.

## gaps

File: `src/gaps.__SEED__.ts`. Function: `solve`.

Read sorted nonoverlapping intervals in [0,100], emit their complement in [0,100]. Reject overlaps, unsorted intervals and empty intervals. Empty input gives `0..100`.

## choose

File: `src/choose.__SEED__.ts`. Function: `solve`.

Choose the longest half-open interval from a comma-separated list. Break equal-length ties by smallest start; empty input gives `none`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
