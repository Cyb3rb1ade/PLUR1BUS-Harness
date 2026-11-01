# Unicode document index

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## tokens

File: `src/tokens.__SEED__.py`. Function: `solve`.

Extract maximal runs of Unicode letters or digits, lowercase them, and join with one ASCII space. Underscores and punctuation separate tokens.

## index

File: `src/index.__SEED__.py`. Function: `solve`.

Count space-separated tokens, emitting lexically sorted `token:count` entries separated by semicolons. Ignore repeated spaces. Empty input gives empty output.

## rank

File: `src/rank.__SEED__.py`. Function: `solve`.

Read `token:positiveCount` entries. Return the most frequent token, breaking ties lexically. Empty input gives `none`; reject malformed/duplicate entries.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
