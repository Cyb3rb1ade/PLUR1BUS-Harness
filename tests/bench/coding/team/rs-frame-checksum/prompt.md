# Length-framed payload checksum

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Read `<decimal UTF-8 byte length>:<payload>`, length <= 65536 with no leading zeros. Return payload; reject incorrect length and NUL.

### Hex behavior

Encode every UTF-8 byte as two lowercase hexadecimal digits. Empty input gives empty output.

### Checksum behavior

Read an even-length ASCII hex string, accepting either case. Sum its decoded bytes modulo 256; emit two lowercase hex digits. Empty input gives `00`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
