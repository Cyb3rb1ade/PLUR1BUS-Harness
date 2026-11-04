# Order normalization and receipt

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Normalize behavior

Read `sku/quantity/unitCents` rows separated by semicolons. Values are nonnegative decimal integers, ids ASCII alphanumeric/underscore. Sum quantities for each sku, reject conflicting unit prices, emit sorted rows.

### Price behavior

Read normalized `sku/quantity/unitCents` rows and emit `sku:lineCents`, preserving order. Empty input gives empty output.

### Receipt behavior

Read `sku:lineCents` rows. Emit `lines=<count>;total=<sum>`. Empty input gives `lines=0;total=0`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
