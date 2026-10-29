# plur1bus-remote-fs

Reusable read-only SSH/SFTP transport for the `@plur1bus/remote-fs` filesystem port. The crate depends on no Core,
engine, Supervisor parser, external SSH command or installed SSH service. `ReadonlySession` exposes `stat`, `lstat`,
`readdir`, bounded chunk `read`, `realpath`, `readlink` and `close`. It exposes no writes, execution channel or raw
SSH client. The Node port provides the public `readFile(path, maxBytes)` operation and source-root authorization.

The host resolves and vets an endpoint through its egress policy before passing a numeric IPv4/IPv6 address.
This transport never resolves a hostname. A connect session compares the actual server key's standard
`SHA256:<base64 without padding>` fingerprint before decoding the private key, authenticating or requesting SFTP.
`probe` performs key exchange only and takes no private key. Both return the actual host-key algorithm.

Private Ed25519 keys arrive only through a separate bounded raw stdin frame. OpenSSH and unencrypted PKCS#8
encodings are accepted by the audited decoder. No password, SSH-agent, environment, argument or key-file fallback
exists. Raw key buffers are zeroized on success, refusal, cancellation and truncation. Failures carry fixed codes
and reasons and omit server messages, paths and key material. Explicitly requested source-file bytes are a
separate data channel; higher-level import policy chooses which source files may be read.

## Process entry points

The standalone binary calls `run_worker()`. Release distributions use the same library through the Harness's
hidden fixed `__remote-fs-worker` command, so ordinary Harness packaging ships the transport. The trusted host
pins the worker path and SHA-256 and selects a fixed entry mode; there is no caller-controlled spawn argument.
Neither the public RPC surface nor the agent tool surface exposes the pipe protocol.

Frames use a four-byte big-endian unsigned length followed by exactly that many bytes. JSON frames are UTF-8.
Connect metadata is capped at 16KiB before allocation, raw keys at 64KiB and general frames at 1MiB. A read data
frame is at most 64KiB. Zero-length data frames represent EOF; input metadata and key frames must be nonempty.

The first frame is a closed object:

```json
{
  "v": 1,
  "mode": "connect",
  "ip": "192.0.2.10",
  "port": 22,
  "username": "reader",
  "hostKeySha256": "SHA256:<43 base64 characters>",
  "deadlineMs": 0,
  "limits": {
    "fileBytes": 33554432,
    "readBytes": 536870912,
    "entries": 16384,
    "depth": 32,
    "packetBytes": 262144,
    "metadataBytes": 1048576,
    "requests": 10000
  }
}
```

Set `deadlineMs` to the absolute Unix millisecond deadline, at most five minutes ahead. `limits` and each of its
fields have the displayed defaults. For `probeHostKey`, omit the username and pin; no key frame follows. For
`connect`, the worker first completes the pinned SSH handshake and emits
`{v:1,ok:true,phase:"host-key-verified",hostKeySha256,hostKeyAlgorithm}`. Only after checking that response may
the host acquire its private-key lease and send the next raw key frame. The same SSH connection then authenticates
and emits `{v:1,ok:true,hostKeySha256,hostKeyAlgorithm}` when SFTP is ready. A rejected pin never requests a key.

Each later JSON request has an unsigned `id` and one of the following closed shapes:

| `op` | Other fields | Successful response fields |
| --- | --- | --- |
| `stat`, `lstat` | `path` | `metadata: {kind,size,mtimeMs?}` |
| `readdir` | `path` | `entries: string[]` |
| `read` | `path`, `offset`, `length` | `bytes`, then one raw data frame |
| `realpath`, `readlink` | `path` | `path` |
| `close` | none | none; the process exits |

Every response also has `v:1`, `id` when parsed, and `ok`. Metadata `kind` is `file`, `directory`, `symlink` or
`other`. `mtimeMs` is milliseconds. Paths are absolute POSIX SFTP paths, including Win32-OpenSSH drive paths such
as `/C:/Users/reader`. Its upstream Windows `realpath` explicitly produces that slash-prefixed form; drive-relative
`C:...` and backslash paths are refused. The native depth cap counts all path
segments; the host additionally checks depth relative to its authorized source root. Readlink targets are
returned as metadata for the host's confinement check. A read never exposes a remote handle.

The Windows path convention is grounded in Win32-OpenSSH's
[Windows `realpath` implementation](https://github.com/PowerShell/openssh-portable/blob/0294d052e55231fdc763d424b47efcf0ec3adf1b/contrib/win32/win32compat/misc.c#L1080)
and its [SFTP REALPATH handler](https://github.com/PowerShell/openssh-portable/blob/0294d052e55231fdc763d424b47efcf0ec3adf1b/sftp-server.c#L1269).

Each session counts repeated reads and listings again. File size and requested offset range are checked before
data reads. Directory entries, listing pages, encoded metadata and request counts remain bounded. The SFTP
decoder checks packet length before allocation. The monotonic run deadline bounds network operations and stdin
and stdout waits; one fixed failure response has at most one second to flush during shutdown. EOF closes the
session. The worker process owns its runtime and I/O threads and leaves no service or subprocess behind.

Errors are `{v:1,id?,ok:false,code,reason}`. Reasons are `invalid-request`, `host-key-mismatch`, `unavailable`,
`authentication-failed`, `timeout`, `limit-exceeded`, `path-denied`, `not-found`, `permission-denied`,
`unsupported-type` and `remote-protocol`. They contain no backend diagnostic text.

## Tests and dependency provenance

Run `cargo test --locked -p plur1bus-remote-fs` and
`cargo test --locked -p plur1bus --test remote_fs_worker`. The tests use an in-process loopback SSH/SFTP server
with random in-memory host/client keys and real temporary source files. They cover the six operations, probe,
host-key mismatch before key acquisition or authentication, wrong keys, byte/entry/depth/packet/metadata/request limits, deadlines,
framing, fixed errors and private-key output checks. They require no external SSH server and skip no platform.

`cargo build --locked -p plur1bus-remote-fs --example sftp_test_server` builds the separate test utility used by
Node integration tests. Send one bounded JSON line `{root,authorizedPublicKey,readDelayMs?}` on stdin and keep
stdin open. It prints `{ip,port,hostKeySha256}` and stops on stdin EOF. It admits only that public key and rejects
all writes. A portable virtual link `/__fixture_link__` points to `/first-home/config.json`; this avoids Windows
symlink privileges while testing the real SFTP link protocol. The fixture utility is not a production mode.

Dependencies are exactly `russh=0.64.1` with only `ring`, and `russh-sftp=3.0.1` without default features. The
reviewed package inventory and narrow Owner exception are recorded in
[`m-russh-dependency-decision.md`](../../docs/ops/m-russh-dependency-decision.md) and
[`m-russh-reviewed-packages.json`](../../docs/ops/m-russh-reviewed-packages.json). The exception covers only those
audited pins and does not relax the repository's dependency policy for later updates.
