# Event ledger and deterministic report

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## group

File: `src/group.__SEED__.ts`. Function: `solve`.

Parse `id:integer` events separated by semicolons. Sum repeated ids, keep signed amounts, and emit ids in lexical order as `id:total`. Empty input gives empty output. Ids contain ASCII letters, digits and underscore.

## aggregate

File: `src/aggregate.__SEED__.ts`. Function: `solve`.

Read grouped `id:integer` rows. Emit `<row count>,<signed sum>`. Empty input gives `0,0`; reject invalid rows.

## render

File: `src/render.__SEED__.ts`. Function: `solve`.

Read `<nonnegative count>,<signed sum>` and emit `events=<count>;total=<sum>`. Reject malformed values.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
