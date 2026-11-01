# Bounded retry timing plan

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## backoff

File: `src/backoff__SEED__/solution__SEED__.go`. Function: `Solve`.

Read `base,max,attempts`: base in 1..1000000, max in base..1000000000, attempts in 0..100. Emit exponentially doubled delays capped at max, as comma-separated integers. Zero attempts gives empty output.

## deadline

File: `src/deadline__SEED__/solution__SEED__.go`. Function: `Solve`.

Read positive integer delays. Retain the longest prefix whose cumulative elapsed time is at most 150. Empty input gives empty output. Validate all delays even after the first excluded one.

## summary

File: `src/summary__SEED__/solution__SEED__.go`. Function: `Solve`.

Read positive integer delays and emit `attempts=<count>;elapsed=<sum>`. Empty input gives zeros.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
