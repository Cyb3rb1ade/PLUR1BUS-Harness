# Sequential URL normalization

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Split behavior

Parse an HTTP or HTTPS URL without userinfo. Host must use ASCII letters, digits, dots or hyphens. Emit compact JSON keys `scheme,host,port,path,query`, with lowercase scheme/host, integer or null port, nonempty path. Discard fragment.

### Normalize behavior

Read split URL JSON. Remove default port 80/443. Percent-decode path, resolve dot segments (clamp above root), collapse slashes, and percent-encode UTF-8 except `/ - . _ ~`. Sort decoded query pairs by key then value and urlencode them, keeping blanks. Preserve the split JSON key order.

### Assemble behavior

Read normalized URL JSON and assemble `scheme://host[:port]/path[?query]`. Validate HTTP(S), nonempty ASCII hostname, port null or integer 1..65535 and an absolute path.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.

Intermediate state is a typed Packet: each consumer validates the producer stage and integrity of its actual payload.
