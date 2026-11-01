# Sequential tax and currency formatting

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## decode

File: `src/pipeline.__SEED__.py`. Function: `decode`.

Read `<signed euros with exactly two decimal places>@<VAT basis points>`. Rate is integer 0..10000. Emit `<signed integer cents>@<rate>`. Canonicalize negative zero.

## tax

File: `src/pipeline.__SEED__.py`. Function: `tax`.

Read `<signed cents>@<basis points>`, rate 0..10000. Apply VAT and round the result to the nearest cent, with halves away from zero. Emit signed integer cents.

## format

File: `src/pipeline.__SEED__.py`. Function: `format_money`.

Read signed integer cents. Emit euros with exactly two decimal places and suffix ` EUR`, using a minus sign only for negative nonzero values.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
