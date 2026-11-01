# HTTP log normalization and error report

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

The package files have separate ownership and can be implemented independently against these contracts.

## parse

File: `src/parse__SEED__/solution__SEED__.go`. Function: `Solve`.

Read log lines `METHOD /path status latencyMs`. Methods are GET, POST, PUT, DELETE; status 100..599; latency is a nonnegative integer. Ignore blank lines. Emit `status:latency` rows separated by semicolons.

## families

File: `src/families__SEED__/solution__SEED__.go`. Function: `Solve`.

Read `status:latency` rows. Count status families 1xx through 5xx and emit only present families, sorted, as `2xx:count;...`. Reject malformed rows.

## report

File: `src/report__SEED__/solution__SEED__.go`. Function: `Solve`.

Read distinct status-family counts `Nxx:count` with N in 1..5 and positive count. Emit `requests=<total>;errors=<4xx plus 5xx>`; empty input gives zeros.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
