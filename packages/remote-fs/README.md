# @plur1bus/remote-fs

Read-only filesystem access for source discovery and private import snapshots. This package has no Core dependency and exposes no write, shell or raw-client methods.

`createLocalFs({root, limits, signal})` returns a frozen object with `stat`, `lstat`, `readdir`, `readFile(path, maxBytes)`, `realpath` and `readlink`. Paths are relative to the selected root or absolute paths within it. Escaping symlinks are refused; internal links may be read. Devices and sockets cannot be read as files.

Every run has a deadline, maximum file and cumulative read bytes, directory depth and cumulative entries. Repeated reads count again. Defaults are 60 seconds, 32 MiB per file, 512 MiB total, depth 32 and 16,384 directory entries. Callers may provide explicit finite limits. Failures use fixed `RemoteFsError.reason` values and omit backend messages and file contents.

`createSftpFs({worker, endpoint, root, leaseKey, limits, signal})` returns `{fs, close}`. `fs` has the same six methods. The trusted host supplies a worker descriptor `{path, sha256, mode}` from its verified installation and an egress-vetted numeric `{ip, port, username, hostKeySha256}` endpoint. `mode` is `harness` or `standalone`; each has fixed arguments. The transport never resolves a hostname or accepts a shell command. It checks the worker digest, plus Unix ownership and permissions, before spawning and confirms the exact host key on the same SSH connection before calling `leaseKey(signal)`.

The lease returns `{key: Buffer, release()}` containing an Ed25519 OpenSSH or unencrypted PKCS#8 private key. The key crosses only a separate private pipe frame and is erased and released after transfer or cancellation, including a provider result that arrives after a timeout. No key is put in environment variables, arguments, diagnostics or filesystem results. Closing a session terminates its worker and pending operations. `probeSftpHostKey({worker, endpoint, limits, signal})` performs key exchange without acquiring a key or authenticating and returns the actual fingerprint and algorithm.

Remote roots use absolute SFTP paths, including Win32-OpenSSH `/C:/Users/reader` paths. Both lexical and canonical parents must stay inside the selected root; final `lstat` can describe an escaping link, while reads and link targets cannot escape. Native packet, metadata and request budgets provide additional bounds; exhausting these returns `limit-exceeded`. SFTP sessions are capped at five minutes, 1 GiB per file, 8 GiB cumulative reads, depth 96 and 100,000 entries.

The SFTP tests explicitly build the locked Rust standalone worker, Harness entry point and separate in-process test server, then exercise both modes. They require Cargo and the workspace test prerequisites; a missing binary or failed build fails the tests. They do not use an installed SSH daemon. The native implementation and pipe contract are documented in [the transport crate](../../crates/plur1bus-remote-fs/README.md).

The package provides and consumes no RPC methods and owns no configuration keys or restart classes. The host authorizes the selected root and records audit metadata. Run `pnpm --filter @plur1bus/remote-fs test` or use the workspace source test runner; no supervisor is required for local tests.
