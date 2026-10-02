# Origin cases

`origin-cases.json` is the same input/expected-normalization table read by Rust
and TypeScript tests. Hosts are synthetic; there are no credentials, private keys
or generated certificates in fixtures. Tests create TLS material in memory.
