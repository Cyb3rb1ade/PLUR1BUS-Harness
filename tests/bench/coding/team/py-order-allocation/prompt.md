# Order normalization and receipt

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## normalize

File: `src/normalize.__SEED__.py`. Function: `solve`.

Read `sku/quantity/unitCents` rows separated by semicolons. Values are nonnegative decimal integers, ids ASCII alphanumeric/underscore. Sum quantities for each sku, reject conflicting unit prices, emit sorted rows.

## price

File: `src/price.__SEED__.py`. Function: `solve`.

Read normalized `sku/quantity/unitCents` rows and emit `sku:lineCents`, preserving order. Empty input gives empty output.

## receipt

File: `src/receipt.__SEED__.py`. Function: `solve`.

Read `sku:lineCents` rows. Emit `lines=<count>;total=<sum>`. Empty input gives `lines=0;total=0`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
