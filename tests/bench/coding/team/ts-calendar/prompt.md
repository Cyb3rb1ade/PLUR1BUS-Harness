# Half-open calendar availability

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Merge behavior

Read comma-separated half-open integer intervals `start..end` with 0 <= start < end <= 100. Merge overlaps and touching intervals, sort by start. Empty input gives empty output.

### Gaps behavior

Read sorted nonoverlapping intervals in [0,100], emit their complement in [0,100]. Reject overlaps, unsorted intervals and empty intervals. Empty input gives `0..100`.

### Choose behavior

Choose the longest half-open interval from a comma-separated list. Break equal-length ties by smallest start; empty input gives `none`.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

Read the selected interval or none. Emit JSON with start/end (null for none) and minutes, validating all bounds.

Validate that JSON slot: minutes equals end minus start and bounds are 0..100. Emit AVAILABLE a..b (n minutes), or FULL for the null slot.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
