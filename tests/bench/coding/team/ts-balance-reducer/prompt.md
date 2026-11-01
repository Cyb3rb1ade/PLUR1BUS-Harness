# Sequential balance event reducer

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Read `add=amount;sub=amount` events, amount a positive safe integer. Emit compact JSON array of `[kind,amount]` in input order. Empty input gives `[]`.

### Reduce behavior

Read the event array. Begin at zero. Adds increase balance; a sub exceeding balance is rejected without changing balance. Emit compact JSON with keys `balance,accepted,rejected` in that order. Reject malformed events and unsafe sums.

### Report behavior

Read nonnegative safe integer JSON fields `balance,accepted,rejected` and emit `balance=<b>;accepted=<a>;rejected=<r>`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.

Intermediate state is a typed Packet: each consumer validates the producer stage and integrity of its actual payload.
