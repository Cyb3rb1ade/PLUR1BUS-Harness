# Hermes provider: security-audit fixes (Task 8)

**Goal.** Fix the findings M1–M3 and the listed lows of the security audit of the Hermes host-mode provider
(`hosts/hermes/plur1bus/**`). Python only; offline unit tests through
`hosts/hermes/tests/run_with_timeout.py`; never a real Hermes or `~/.hermes`.

Scope: `hosts/hermes/**` and this plan. `docs/hermes-host-mode.md` gets the behaviour change (identity table, tools).

## Design

| Finding | Fix |
|---|---|
| M1 identity | `CallerIdentity` is closed (`channel/accountId/userId`; a client can never send trust, rpc.schema.json), so "claimed" is expressed in the identity itself. A data table `PLATFORM_TRUST` (`mapping.py`) classes a platform `trusted` (the platform authenticates the sender id: telegram, discord, slack, whatsapp, signal, matrix, mattermost), `local` (cli, local: one OS user) or untrusted (everything else, incl. email, webhook, sms, unknown names). Trusted: unchanged. Untrusted: `accountId = hermes:<platform>:claimed`, `userId = claimed-<sha256(id)[:32]>`: a sender-chosen id can never equal a proved user's principal, and never aliases another platform's. No user id and no chat id on a non-local platform: `IdentityRefused`; the provider stays inert for the session with one warning (no shared `hermes:<p>/local`). |
| M2 tools | `forget`, `correct`, `share` are off by default. Binding field `memoryWriteTools` (default `false`, optional in the file) switches them on. They are not offered, not named in the system prompt block, and `handle_tool_call` refuses them with `E_DISABLED`. Hermes offers no per-call confirmation hook, so there is no "confirm" mode. |
| M3 journal | Permanent core errors (incl. `E_AGENT_UNKNOWN`) never block the queue: the entry goes to a bounded (200 entries / 1 MiB) 0600 `dead-letter.ndjson` with its code, counted as `deadLettered` (and `rejected`). |
| replay trust | Before every send the entry is validated against the current binding: `agentId` must equal it; caller, session key and messages must be well formed (roles user/assistant, at most 64, strings). Otherwise dead-letter `E_JOURNAL_ENTRY`. |
| state.json | Non-numeric counters are read as 0 (reported in a log line); the worker loop catches every exception per iteration; the in-memory capture queue is bounded (200), overflow counts `lost`. |
| torn writes | Each journal record is `P1 <len> <crc32> <json>\n`; an append first closes an unterminated tail; a record failing length/checksum is skipped and counted `damaged`. Unframed legacy lines are still read. |
| Windows `bind` | `plur1bus` is searched on the absolute entries of `PATH` only (never the current directory, never a relative entry); `PATHEXT` on Windows. |
| fallback import | The harness-checkout client source is appended to `sys.path`, not prepended. |
| dir permissions | Every locked journal operation checks the directory (0700, ours) and the files (0600), repairs loose modes, refuses a directory owned by another user. |
| error codes | Codes from the core are reduced to `[A-Za-z0-9_.-]{1,64}` before logs and `state.json`. |
| UTF-8 | A binding file with invalid UTF-8 is `BindingInvalid("not valid UTF-8")`. |

## Rulings (owner defaults, listed in the PR)

* R-M1: untrusted/unknown platforms are `claimed`; no id means refuse, not a shared fallback.
* R-M2: write tools default off; no confirm mode.
* R-M3: `E_AGENT_UNKNOWN` is permanent for the queue (dead-letter), not journal-and-wait.

## Tasks and acceptance -> test

1. M1: `test_mapping.py` (table, claimed namespace, refusal, no cross-alias) + `test_provider.py` (inert on refusal).
2. M2: `test_binding.py` (field round trip, default false) + `test_provider.py`/`test_mapping.py` (tools, prompt, refusal).
3. M3 + dead letter: `test_journal.py` (bounded, 0600, no block) + `test_provider.py` (unknown agent does not block later captures).
4. Replay validation: `test_journal.py`/`test_provider.py` (foreign agentId, system role, bad caller).
5. state.json garbage + bounded queue: `test_journal.py`, `test_provider.py`.
6. Framing: `test_journal.py` (torn tail, flipped byte, legacy line).
7. `bind` PATH search: `test_cli.py`.
8. Fallback import order: `test_provider.py::HermesImportTest` (subprocess).
9. Directory/file permission repair: `test_journal.py`.
10. Code truncation: `test_journal.py`/`test_provider.py`.
11. Invalid UTF-8 binding: `test_binding.py`.
