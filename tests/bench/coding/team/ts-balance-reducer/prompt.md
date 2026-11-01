# Sequential balance event reducer

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## decode

File: `src/pipeline.__SEED__.ts`. Function: `decode`.

Read `add=amount;sub=amount` events, amount a positive safe integer. Emit compact JSON array of `[kind,amount]` in input order. Empty input gives `[]`.

## reduce

File: `src/pipeline.__SEED__.ts`. Function: `reduce`.

Read the event array. Begin at zero. Adds increase balance; a sub exceeding balance is rejected without changing balance. Emit compact JSON with keys `balance,accepted,rejected` in that order. Reject malformed events and unsafe sums.

## report

File: `src/pipeline.__SEED__.ts`. Function: `report`.

Read nonnegative safe integer JSON fields `balance,accepted,rejected` and emit `balance=<b>;accepted=<a>;rejected=<r>`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
