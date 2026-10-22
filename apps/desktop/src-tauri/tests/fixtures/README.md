# Origin cases

`origin-cases.json` is the same input/expected-normalization table read by Rust
and TypeScript tests. Hosts are synthetic; there are no credentials, private keys
or generated certificates in fixtures. Tests create TLS material in memory.

# Tailscale status documents

`tailscale/*.json` are synthetic `tailscale status --json` documents for the transport check (package T3): names
under `example.ts.net` and `example.com`, addresses from the Tailscale ranges and made-up private ranges,
peer map keys that are not node keys, and no key material of any kind. Never copy a real `tailscale status` here.
