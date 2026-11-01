# Unicode document index

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Tokens behavior

Extract maximal runs of Unicode letters or digits, lowercase them, and join with one ASCII space. Underscores and punctuation separate tokens.

### Index behavior

Count space-separated tokens, emitting lexically sorted `token:count` entries separated by semicolons. Ignore repeated spaces. Empty input gives empty output.

### Rank behavior

Read `token:positiveCount` entries. Return the most frequent token, breaking ties lexically. Empty input gives `none`; reject malformed/duplicate entries.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

Read the winning word, or none. Emit a JSON search record {term,bytes}; none gives {term:null,bytes:0}. Reject punctuation and uppercase; Unicode lowercase alphanumerics are allowed.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
