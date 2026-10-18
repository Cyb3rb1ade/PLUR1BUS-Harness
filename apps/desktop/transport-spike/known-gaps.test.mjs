import test from "node:test";

// Explicit missing evidence; no implemented test is skipped or relaxed.
test.todo("H/RSA: encrypted RSA and rsa-sha2-256/512 login with an audit-clean dependency (RUSTSEC-2023-0071)");
test.todo("H/platforms: same SSH suite on Windows x64/arm64 and Linux x64/arm64");
test.todo("H/OpenSSH: 8.9/9.6 interoperability, negotiated algorithm allowlist and real PTY");
test.todo("H/transport: real SPA proxy HTTP/SSE/WS, jump host and LAN p95 overhead");
test.todo("H/agent: Windows pipe, isolated 1Password/FIDO fixture and hashed known_hosts");
test.todo("H/size: installed desktop binary delta on five release targets");
