# Quoted CSV import and deduplication

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## parse

File: `src/parse.__SEED__.py`. Function: `solve`.

Read CSV rows with exactly two fields: an ASCII alphanumeric/underscore name and an integer score (possibly negative). Support standard CSV quoting; skip empty rows. Emit `name:score` rows separated by semicolons.

## deduplicate

File: `src/deduplicate.__SEED__.py`. Function: `solve`.

Read `name:integer` rows; retain the greatest score per name and emit names in lexical order. Empty input gives empty output.

## summary

File: `src/summary.__SEED__.py`. Function: `solve`.

Read `name:integer` rows and emit `count=<n>;mean=<floor of arithmetic mean>`. Empty input gives `count=0;mean=0`. Negative means round toward negative infinity.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
