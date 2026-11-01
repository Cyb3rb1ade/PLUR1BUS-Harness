# Sequential URL normalization

Implement the functions below. Input and output are UTF-8 strings; do not print from a function. Return exactly `error` on malformed input unless a rule says otherwise. Empty collections have the stated empty representation. Use only the language standard library.

Numeric fixture inputs and valid totals fit signed 32-bit integers unless a package states a narrower bound. Numeric text is ASCII decimal; behavior for out-of-range magnitudes is outside the fixture domain unless explicitly specified.

The package contracts are fixed. The integration checker passes each output to the next package in the order listed. There is no network, clock, random source or dependency install in the task.

This is a sequential change: the packages share the pipeline module. Preserve earlier behavior while implementing each next stage.

## split

File: `src/pipeline.__SEED__.py`. Function: `split_url`.

Parse an HTTP or HTTPS URL without userinfo. Host must use ASCII letters, digits, dots or hyphens. Emit compact JSON keys `scheme,host,port,path,query`, with lowercase scheme/host, integer or null port, nonempty path. Discard fragment.

## normalize

File: `src/pipeline.__SEED__.py`. Function: `normalize_url`.

Read split URL JSON. Remove default port 80/443. Percent-decode path, resolve dot segments (clamp above root), collapse slashes, and percent-encode UTF-8 except `/ - . _ ~`. Sort decoded query pairs by key then value and urlencode them, keeping blanks. Preserve the split JSON key order.

## assemble

File: `src/pipeline.__SEED__.py`. Function: `assemble_url`.

Read normalized URL JSON and assemble `scheme://host[:port]/path[?query]`. Validate HTTP(S), nonempty ASCII hostname, port null or integer 1..65535 and an absolute path.

The generated `instance.json` names this variant. Do not modify it. Hidden checkers and reference solutions are not part of the working tree.
