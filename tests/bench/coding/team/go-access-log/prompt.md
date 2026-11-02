# HTTP log normalization and error report

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Parse behavior

Read log lines `METHOD /path status latencyMs`. Methods are GET, POST, PUT, DELETE; status 100..599; latency is a nonnegative integer. Ignore blank lines. Emit `status:latency` rows separated by semicolons.

### Families behavior

Read `status:latency` rows. Count status families 1xx through 5xx and emit only present families, sorted, as `2xx:count;...`. Reject malformed rows.

### Report behavior

Read distinct status-family counts `Nxx:count` with N in 1..5 and positive count. Emit `requests=<total>;errors=<4xx plus 5xx>`; empty input gives zeros.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

Read requests=<total>;errors=<errors>, with 0 <= errors <= total. Append ;errorPercent=<floor(100*errors/total)>; zero total gives zero percent.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
