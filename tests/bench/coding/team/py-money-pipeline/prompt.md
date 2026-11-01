# tax and currency formatting

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Read `<signed euros with exactly two decimal places>@<VAT basis points>`. Rate is integer 0..10000. Emit `<signed integer cents>@<rate>`. Canonicalize negative zero.

### Tax behavior

Read `<signed cents>@<basis points>`, rate 0..10000. Compute the gross amount `netCents * (10000 + rate) / 10000` (including VAT), then round it to the nearest cent, with halves away from zero. Emit signed integer cents.

### Format behavior

Read signed integer cents. Emit euros with exactly two decimal places and suffix ` EUR`, using a minus sign only for negative nonzero values.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.

Intermediate state is a typed Packet: each consumer validates the producer stage and integrity of its actual payload.
