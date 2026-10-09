# @plur1bus/channels-email

Email channel: IMAP in, SMTP out, one email thread per chat. Zero runtime dependencies. The operator guide is in [docs/channels/email.md](../../docs/channels/email.md).

- Manifest: `channel.json`, `email`, version `0.1.0`, API `1`, `direct` chat kind only. A library consumed by a host factory.
- Configuration: `EmailConfig` (see `src/config.ts`). Secret NAMES only; passwords come from `SecretReader`. `createEmailChannel(cfg, deps)` builds the channel.
- Framework path: `start(host)`, `stop()`, `health()`, `send({ chatId, text, replyTo? })`. Rich adapter ports: `onMessage` (inbound with attachments, auth results and thread root), `sendTurn` (text, attachments, subject), `sendOutput` (images from the output store), `prompt`/`onDecision` (approvals by reply code), `edit` (throws `unsupported`), `typing` (no-op).
- Inbound text-only turns are also handed to the host through `ChannelHost.receive`. Turns with attachments are rich-only and log `channel.email.framework-rich-turn-gap`.

## Why no dependencies

The repo's licence audit and `--packages=external` bundling require every package to resolve its dependencies at runtime. Off-the-shelf IMAP, SMTP and MIME libraries would each add a transitive tree. This package implements a deliberately narrow subset on `node:net`, `node:tls`, `node:crypto` and `TextDecoder`:

- IMAP: LOGIN or AUTHENTICATE PLAIN after TLS, SELECT, UID SEARCH / FETCH / STORE, IDLE with polling fallback, literals.
- SMTP: EHLO, STARTTLS, AUTH PLAIN or LOGIN, MAIL / RCPT / DATA with dot-stuffing, NOOP.
- MIME parser (multipart, quoted-printable, base64, RFC 2047, RFC 2231, charsets via `TextDecoder`) and builder (multipart/alternative and mixed, base64 bodies).
- HTML to text and a Markdown subset converter, both escape-first.

The scope is intentionally small. Everything outside it is listed under limits below and in the operator guide.

## Security boundaries

- Transport: `security: "tls"` is implicit TLS with certificate verification. `security: "starttls"` requires STARTTLS in the server's capabilities before any credential is sent; otherwise the client fails closed. Plaintext connections exist only through the `connect` test seam, never through configuration.
- Sender identity: the From header is parsed strictly. Ambiguous headers (several mailboxes, group syntax, several From or Sender conflicts, unbalanced quotes or comments) are dropped. The allowlist compares the final lowercased addr-spec only.
- Authentication results: only an `Authentication-Results` header whose authserv-id equals the configured `authServId` is read, the topmost one only, with comments and quoted strings removed. Without `authServId`, every result is `none`. `requireAuthPass` uses DMARC `pass` only, because DMARC encodes alignment. Signatures are not verified here.
- Loop prevention: no replies to auto-submitted, bulk, list, null-sender, report, system-sender or own mail. Outbound replies carry `Auto-Submitted: auto-replied` (RFC 3834) and no `Precedence` header.
- Injection: CR, LF and NUL are refused in every header value and SMTP argument. Bodies are dot-stuffed. Attachment filenames are reduced to safe basenames.
- Secrets: passwords never enter logs, error messages or snapshots. The log scanner in the contract harness checks this.

## Isolated tests

```sh
cd packages/channels-email && node ../../scripts/test-package.mjs
```

The fake IMAP and SMTP servers run in-process on `127.0.0.1:0` (`test/helpers/fake-imap.ts`, `fake-smtp.ts`). The TLS upgrade is an identity seam that records ordering. The clock and sleeps are harness-driven, so no test depends on wall-clock time. `test/helpers/contract.ts` provides the shared contract harness; `makeEmailFixture()` exposes the fake servers for the channel's own tests.

## Limits

- No OAuth2 (XOAUTH2). Providers that still accept password login are supported; others are not.
- No IMAP extensions beyond IDLE (no CONDSTORE, QRESYNC, MOVE, SASL-IR). Only one folder, read through SELECT.
- No S/MIME, PGP, DSN generation, or message encryption.
- No outbound messages to unknown addresses. Outbound mail only goes into an existing thread created by an allowlisted inbound message.
- At-least-once across a crash between hand-off and cursor save. Duplicate Message-IDs are suppressed only within one process.
- Mail that arrives before the first start is baselined and not processed (documented behaviour for a dedicated mailbox). Oversized mail (over `maxMessageBytes`, default 25 MiB, and attachment limits apply separately) is skipped and logged, without a reply.
- Outbound retries: three attempts per send, in process. A send that fails after the server accepted the data cannot be detected reliably, so a duplicate is possible.
- Bodies are capped at 200 000 characters with a notice. At most ten attachments per message, with the MIME allowlist (images, audio, PDF, zip, JSON, octet-stream, text/plain). No virus scanning.
- Approvals by reply code are only as strong as the mailbox and sender authentication behind them; see the operator guide.

## Interface wishes (for the lead, not worked around in core)

1. Rich inbound and outbound turns need a core event model (attachments, subjects, auth results). Today they are adapter-only.
2. An approval decision port in core, so `onDecision` has a place to go besides the adapter.
3. A thread-aware session key for `chatId`; email threads are opaque keys derived from the root Message-ID.
4. Persistent thread store and UID store as shared ports (both are file-backed here, with memory variants).
5. Config keys: `authServId` is a new channel-specific key (`channels.email.authServId`); the lead owns the schema entry.
