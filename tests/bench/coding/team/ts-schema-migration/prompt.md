# account schema migration

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Read semicolon-separated `id:signedInteger` rows (ASCII alphanumeric/underscore ids). Emit compact JSON `{"version":1,"rows":[[id,amount],...]}` in input order. Empty input has no rows.

### Migrate behavior

Read the version-1 JSON. Lowercase ids and sum duplicates, then emit compact JSON `{"version":2,"accounts":[{"id":id,"balance":integer},...]}` sorted by id. Reject wrong schema or unsafe integer sums.

### Project behavior

Read version-2 accounts with unique ids and integer balances. Emit `accounts=<count>;balance=<sum>`. Reject wrong versions and duplicate ids.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.

Intermediate state is a typed Packet: each consumer validates the producer stage and integrity of its actual payload.
