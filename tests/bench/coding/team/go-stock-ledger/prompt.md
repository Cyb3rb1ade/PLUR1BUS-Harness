# Sequential stock reservation ledger

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Read semicolon-separated `ADD sku positiveQuantity` or `RESERVE sku positiveQuantity`, with ASCII alphanumeric/underscore sku. Normalize to `A,sku,n` / `R,sku,n` rows. Empty input gives empty output.

### Apply behavior

Read normalized operations, starting with no stock. Apply additions; ignore a reserve if stock is insufficient, without creating a new sku. Keep zero balances. Emit sorted `sku:remaining` rows.

### Render behavior

Read distinct `sku:nonnegativeStock` rows. Emit `skus=<count>;available=<sum>`. Empty input gives zeros; reject malformed or duplicate rows.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.

Intermediate state is a typed Packet: each consumer validates the producer stage and integrity of its actual payload.
