# Sequential Unicode frame rewrite

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## decode

File: `src/pipeline.__SEED__.rs`. Function: `decode`.

Decode `<UTF-8 byte count>:payload`, count <= 65536 with no leading zeros. Preserve payload whitespace; reject malformed size and NUL.

## normalize

File: `src/pipeline.__SEED__.rs`. Function: `normalize`.

Trim leading and trailing Unicode whitespace from a payload and lowercase Unicode characters. Reject NUL. Empty payload remains empty.

## encode

File: `src/pipeline.__SEED__.rs`. Function: `encode`.

Encode payload using its UTF-8 byte count, a colon, then payload. Reject NUL and payloads longer than 65536 bytes.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
