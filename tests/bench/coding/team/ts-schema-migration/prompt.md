# Sequential account schema migration

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## decode

File: `src/pipeline.__SEED__.ts`. Function: `decode`.

Read semicolon-separated `id:signedInteger` rows (ASCII alphanumeric/underscore ids). Emit compact JSON `{"version":1,"rows":[[id,amount],...]}` in input order. Empty input has no rows.

## migrate

File: `src/pipeline.__SEED__.ts`. Function: `migrate`.

Read the version-1 JSON. Lowercase ids and sum duplicates, then emit compact JSON `{"version":2,"accounts":[{"id":id,"balance":integer},...]}` sorted by id. Reject wrong schema or unsafe integer sums.

## project

File: `src/pipeline.__SEED__.ts`. Function: `project`.

Read version-2 accounts with unique ids and integer balances. Emit `accounts=<count>;balance=<sum>`. Reject wrong versions and duplicate ids.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
