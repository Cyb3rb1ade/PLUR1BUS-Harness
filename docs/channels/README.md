# Channels

One page per channel (`telegram.md`, `discord.md`, `matrix.md`, `signal.md`, `email.md`, `slack.md`) describes its
configuration and behaviour. This page is the contract matrix: what each channel's own test package proves against the
channel contract (`packages/core/src/channels/types.ts`: `start`, `stop`, `health`, `send`, and `ChannelHost.receive`,
`fail`, `log`), and where it does not.

## Vertragsmatrix

Cells read `✓` (covered and passing), `KNOWN GAP` (a todo test that fails for the stated reason, with the test name),
or `n/a` (with the reason). A KNOWN GAP is a product deviation that the tests record and do not fix.

Points: a) start resolves and health is ok; b) stop is idempotent; c) send after stop is rejected; d) an inbound event reaches
`host.receive` exactly once; e) a final auth failure calls `host.fail`, transient failures do not; f) health is not ok after
connection loss; g) stop leaves no unhandled rejection.

| Channel | a | b | c | d | e | f | g | Schwärzung | Splitting | Rate-Limit |
|---|---|---|---|---|---|---|---|---|---|---|
| Telegram | ✓ | ✓ | ✓ | ✓ | ✓ | KNOWN GAP: "f) health is not ok after the connection is lost" (`contract-harness.test.ts`) | ✓ | KNOWN GAP ×5: part of a token echoed by the platform reaches `err.message` (`redaction-catalogue.test.ts`, `TelegramApi.#call`); low severity | KNOWN GAP: "property 3b: every part boundary falls on a grapheme boundary" (`split-property.test.ts`) | KNOWN GAP ×3: 500 and 503 on sends are not retried; 400 on `getUpdates` is retried (`rate-backoff.test.ts`) |
| Discord | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (health reports `reconnecting`) | KNOWN GAP: "g) stop while start waits for the first READY settles promptly instead of waiting out READY_WAIT_MS" (`contract-catalogue.test.ts`) | KNOWN GAP ×2: an intent or unknown option named by the token is echoed in a `RangeError` (first 40 characters; low) (`redaction-catalogue.test.ts`) | KNOWN GAP: "property 3b: every cut falls on an extended grapheme cluster boundary" (`split-property.test.ts`) | ✓ (`rate-backoff.test.ts`) |
| Matrix | ✓ | ✓ | ✓ | ✓ | ✓ | KNOWN GAP: "f) health is not ok after the connection is lost" (`contract-catalogue.test.ts`) | ✓ | ✓ (`redaction-catalogue.test.ts`) | KNOWN GAP ×5: "property 1" (a part overshoots by its closing fence), "property 3b", "property 4b" (reopened fence glued to code), "property 4c" (CRLF fences), "property 4d" (overflowing closing fence) (`split-property.test.ts`) | ✓ (`rate-backoff.test.ts`) |
| Signal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`redaction-catalogue.test.ts`; account digits, daemon socket path and TCP host) | KNOWN GAP: "property 3b: no extended grapheme cluster is split" (`split-property.test.ts`) | ✓ (`rate-backoff.test.ts`) |
| Email | ✓ | ✓ | ✓ | KNOWN GAP: "d) the same UID twice in one batch is delivered once even when the mail has no Message-ID" (`contract-catalogue.test.ts`) | ✓ | ✓ (health is `imap:down`) | KNOWN GAP: "g) stop issued right after start() was called leaves no IMAP socket open" (`contract-catalogue.test.ts`) | ✓ (`redaction-catalogue.test.ts`) | KNOWN GAP: "property 3b: every cut falls on an extended grapheme cluster boundary" (`split-property.test.ts`) | KNOWN GAP: "SMTP: stop() during a parked retry wait ends the send" (`rate-backoff.test.ts`) |
| Slack | n/a: Slack is the reference harness (`test/contract-harness.test.ts`, one smoke test). Its a–g were not extended in this pass, which covered Discord, Matrix, Signal and Email. | n/a | n/a | n/a | n/a | n/a | n/a | KNOWN GAP (SECURITY): "a webSocket factory that throws while reconnecting keeps its error text out of the process" (`redaction-catalogue.test.ts`); the error escapes as an unhandled rejection with the bot token and the Socket Mode URL with its ticket | KNOWN GAP: "P3b: no extended grapheme cluster is split at a part boundary" (`split-property.test.ts`) | KNOWN GAP ×3: a file download is not retried on 503, and ignores `Retry-After` on 429; `ok: false` server errors on HTTP 200 are not retried (a judgement call; `rate-backoff.test.ts`) |

Notes:
- Splitting on a grapheme boundary is not documented for any channel. The docs promise surrogate-pair safety and, for some channels,
  code-fence handling. A cut inside a ZWJ sequence, a flag or a CRLF pair is therefore a gap in the code, not in the contract.
- The Telegram and Discord secret gaps need an upstream that echoes credentials. Real platforms do not do that, so they are
  hardening gaps, not live leaks.
- Core: the channel registry restarts a failing channel with growing gaps up to a 60 s cap, gives up after `maxRestarts`, and
  `stop()` ends the loop (`packages/core/test/channels/backoff-registry.test.ts`, 14 tests, all passing).
