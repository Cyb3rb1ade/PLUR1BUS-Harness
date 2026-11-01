# Sequential stock reservation ledger

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## decode

File: `src/pipeline__SEED__/solution__SEED__.go`. Function: `Decode`.

Read semicolon-separated `ADD sku positiveQuantity` or `RESERVE sku positiveQuantity`, with ASCII alphanumeric/underscore sku. Normalize to `A,sku,n` / `R,sku,n` rows. Empty input gives empty output.

## apply

File: `src/pipeline__SEED__/solution__SEED__.go`. Function: `Apply`.

Read normalized operations, starting with no stock. Apply additions; ignore a reserve if stock is insufficient, without creating a new sku. Keep zero balances. Emit sorted `sku:remaining` rows.

## render

File: `src/pipeline__SEED__/solution__SEED__.go`. Function: `Render`.

Read distinct `sku:nonnegativeStock` rows. Emit `skus=<count>;available=<sum>`. Empty input gives zeros; reject malformed or duplicate rows.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
