# UTF-8 route canonicalization

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## decode

File: `src/decode.__SEED__.rs`. Function: `solve`.

Percent-decode a UTF-8 path. Accept upper/lower hex; reject malformed escapes, invalid UTF-8 and NUL bytes. A plus is a literal plus.

## normalize

File: `src/normalize.__SEED__.rs`. Function: `solve`.

Read an absolute decoded path. Collapse repeated slashes and dot segments. Reject traversal above root; remove trailing slash except root. Reject NUL.

## encode

File: `src/encode.__SEED__.rs`. Function: `solve`.

Read an absolute decoded path and percent-encode UTF-8 bytes except ASCII alphanumerics, `-._~` and slash. Use uppercase hex; reject NUL.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
