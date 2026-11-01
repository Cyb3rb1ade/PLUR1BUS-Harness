# Quoted CSV import and deduplication

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Parse behavior

Read CSV rows with exactly two fields: an ASCII alphanumeric/underscore name and an integer score (possibly negative). Support standard CSV quoting; skip empty rows. Emit `name:score` rows separated by semicolons.

### Deduplicate behavior

Read `name:integer` rows; retain the greatest score per name and emit names in lexical order. Empty input gives empty output.

### Summary behavior

Read `name:integer` rows and emit `count=<n>;mean=<floor of arithmetic mean>`. Empty input gives `count=0;mean=0`. Negative means round toward negative infinity.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
