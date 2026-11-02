# UTF-8 route canonicalization

Implement the behavior below using the public source interfaces. Input and final output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The public endpoints and state types are in the source tree. There is no network, clock, random source or dependency install.

### Decode behavior

Percent-decode a UTF-8 path. Accept upper/lower hex; reject malformed escapes, invalid UTF-8 and NUL bytes. A plus is a literal plus.

### Normalize behavior

Read an absolute decoded path. Collapse repeated slashes and dot segments. Reject traversal above root; remove trailing slash except root. Reject NUL.

### Encode behavior

Read an absolute decoded path and percent-encode UTF-8 bytes except ASCII alphanumerics, `-._~` and slash. Use uppercase hex; reject NUL.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.

Read a canonical encoded absolute path; reject non-ASCII, malformed or lowercase percent escapes and empty interior segments. Emit path=<path>;segments=<number of nonempty components>.

Read path=<path>;segments=<count>. Revalidate the count and canonical path using the shared RouteRecord parser. Append ;etag=<sum of encoded path UTF-8 bytes modulo 256, two lowercase hex digits>.

The string error is a reserved failure value; downstream endpoints propagate it unchanged.

Inputs may also use the instance text frame documented in the public contract module. Invalid frames return error.
