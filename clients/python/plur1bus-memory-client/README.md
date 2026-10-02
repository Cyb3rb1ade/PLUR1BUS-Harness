# plur1bus-memory-client

A small Python client for the PLUR1BUS core RPC, used by host adapters such as the Hermes
directory provider (`hosts/hermes/plur1bus/`, D88). Python 3.11 or later. At runtime it uses the
standard library only.

- **Transport:** NDJSON JSON-RPC 2.0 (`docs/rpc.md`), one line per message, at most 4 MiB per line.
  It connects to `<home>/run/core.sock` on POSIX and to `\\.\pipe\plur1bus-<hash>-core` on Windows.
  On Windows every read and write is overlapped I/O with a deadline: an operation that runs out of
  time is cancelled (`CancelIoEx`) and awaited, so a stuck core never hangs the caller (HM2-R11).
- **Address rules:** the same as `crates/plur1bus/src/paths.rs` and `packages/module-api/src/paths.ts`.
  The pipe name hashes the exact home string you pass. Pass the absolute home the core runs with.
  The shared vectors in `tests/fixtures/address-vectors.json` and `home-vectors.json` are checked by
  the Python, Rust and TypeScript tests.
- **Server identity (ruling S11, HM2-R7):** every connect re-reads `run/core.token` and `run/core.pid`.
  The token is sent only after the OS confirms that the server pid (`SO_PEERCRED`, `LOCAL_PEERPID` or
  `GetNamedPipeServerProcessId`) equals `run/core.pid`. On POSIX, `run/` must also be a directory
  owned by the current user with no group or other write bit. The token never appears in errors or logs.
- **Deadlines:** each call has one monotonic deadline (`deadline_s`, default `call_timeout`). It covers
  connecting, sending, receiving and at most one reconnect. Only reads (`core.status`,
  `memory.recall`, `memory.list`, `memory.show`, `agent.*`) are re-sent after a broken connection.
  Writes are never re-sent; the caller decides what to do with them.
- **Versions:** the client accepts rpc major 1, minor 3 or later, and refuses anything else with
  `E_RPC_VERSION`. `_schema.py` is generated from `packages/rpc-schema/schema/rpc.schema.json`
  by `scripts/gen-python-client.mjs`, which runs as part of `pnpm gen`.

```python
from plur1bus_memory_client import Caller, MemoryClient, RpcError

client = MemoryClient("/home/me/.plur1bus")
caller = Caller(account_id="hermes:cli", user_id="local")
try:
    text = client.recall(caller, "hermes-default", "what did we decide?", hard_ms=600)["joined"]["text"]
except RpcError as e:
    text = ""  # e.code: E_CORE_UNAVAILABLE, E_TIMEOUT, E_AGENT_UNKNOWN, ...
```

Tests, run from the repository root (use `requirements-dev.txt` in a venv to run the conformance
suite as well):

```bash
python3 -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client
```
