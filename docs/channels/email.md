# Email channel

The email channel reads one mailbox over IMAP and answers over SMTP. Each email thread is one chat: replies from the same conversation share a session. Only allowlisted sender addresses are heard. The package is a library consumed by a host factory; see [packages/channels-email/README.md](../../packages/channels-email/README.md) for the ports and the design rationale.

## 1. Prepare a mailbox

Use a dedicated mailbox for the bot. Anything the bot can read, every sender who reaches it can attempt to talk to, so keep it separate from personal or work mail.

1. Create the mailbox, for example `assistant@your-domain.example`.
2. Enable IMAP and SMTP for it. Most providers need this switched on explicitly.
3. Create an app password (or the provider's equivalent) for IMAP and SMTP access, and store it in the host secret store under a name such as `EMAIL_BOT_PASSWORD`. Never paste it into config, source, tests, shell history or logs.
4. The package does not implement OAuth2. Providers that only accept OAuth2 for IMAP and SMTP cannot be used.

Ports:

| Protocol | Implicit TLS (`security: "tls"`) | STARTTLS (`security: "starttls"`) |
| --- | --- | --- |
| IMAP | 993 | 143 |
| SMTP | 465 | 587 |

Use `tls` where the provider offers it. With `starttls`, the server must advertise STARTTLS; otherwise the channel refuses to send credentials and fails to start.

## 2. Configure the channel

```json
{
  "enabled": true,
  "address": "assistant@your-domain.example",
  "displayName": "Assistant",
  "imap": {
    "host": "imap.your-provider.example",
    "port": 993,
    "security": "tls",
    "user": "assistant@your-domain.example",
    "passwordSecret": "EMAIL_BOT_PASSWORD",
    "folder": "INBOX",
    "idle": true,
    "pollIntervalSec": 60
  },
  "smtp": {
    "host": "smtp.your-provider.example",
    "port": 465,
    "security": "tls",
    "user": "assistant@your-domain.example",
    "passwordSecret": "EMAIL_BOT_PASSWORD"
  },
  "dmAllowlist": ["alice@example.org", "*@partner.example"],
  "authServId": "mx.your-provider.example",
  "requireAuthPass": true,
  "maxAttachmentBytes": 10485760,
  "locale": "en"
}
```

| Key | Default / meaning |
| --- | --- |
| `enabled` | `false`; read by the registry |
| `address` | Required. The bot's own address; also its stable accountId for `/link` |
| `displayName` | Optional sender display name |
| `imap.host`, `imap.port`, `imap.security`, `imap.user` | Required. `security` is `tls` or `starttls` |
| `imap.passwordSecret` | Required secret name |
| `imap.folder` | `INBOX` |
| `imap.idle` | `true`. Uses IDLE when the server advertises it; falls back to polling otherwise |
| `imap.pollIntervalSec` | `60` (10 to 3600). Poll interval, and the wait used when IDLE is unavailable |
| `smtp.*` | Same shape as IMAP without `folder`, `idle` and `pollIntervalSec` |
| `dmAllowlist` | Required (may be empty, which admits nobody). Exact addresses or `*@domain`, case-insensitive. Subdomains are not included in `*@domain` |
| `authServId` | The authserv-id of the MTA that delivers into the bot's mailbox. Unset means no authentication result is trusted |
| `requireAuthPass` | `false`. When `true`, mail is dropped unless the trusted Authentication-Results shows `dmarc=pass`. Without `authServId`, all mail is dropped |
| `maxAttachmentBytes` | 10 MiB; hard maximum 25 MiB |
| `locale` | `en` or `de`, for the bot's own messages |
| `allowlist`, `replyPolicy` | Unused by email. Accepted so the common schema shape validates |

Configuration takes effect on channel restart. The password secret names are the only credential references.

### Choosing `authServId`

Open a message from the mailbox in the provider's web interface and look at the raw headers. The first `Authentication-Results:` line names the receiving server, for example `mx.google.com` or `mx.your-provider.example`. That first token is the authserv-id. The channel reads only headers carrying that identifier, and only the topmost such header. Mail whose headers do not match is treated as having no authentication result at all, which is the safe default.

The channel does not verify DKIM or SPF itself. It trusts the receiving server's verdicts, and therefore trusts that server to add headers honestly. That trust is the reason the authserv-id must be pinned.

## 3. Sender authentication

- SPF, DKIM and DMARC are evaluated by the receiving server, not by this package. DMARC `pass` is the signal to trust, because it requires the signing or envelope domain to align with the From domain.
- `requireAuthPass: true` is recommended for any mailbox that may receive mail from unknown mailboxes. It is also what approval by email relies on (section 5).
- Spoofed From headers are rejected when they are ambiguous: duplicate From, multiple mailboxes, group syntax, or a Sender that disagrees with From.

## 4. Reply rules

- Inbound messages from addresses outside `dmAllowlist` are dropped silently and logged without content.
- Automatic and bulk mail is never answered: `Auto-Submitted` other than `no`, `Precedence: bulk|junk|list`, `List-Id`, `X-Auto-Response-Suppress`, null return paths, mailer-daemon, postmaster, no-reply and bounce reports, and the bot's own address.
- Replies carry `In-Reply-To` and `References` built from the thread, so mail clients keep the conversation together. The subject gets a single `Re: ` prefix.
- Quoted history (`>` lines and "wrote:" attribution blocks) and a trailing signature (`-- `) are removed from inbound text before it reaches the session.
- Outbound text is Markdown-converted to HTML with a safe subset (paragraphs, emphasis, code, lists, quotes, links with http, https or mailto only). The plain-text part is sent unchanged.
- Each recipient address is limited to 30 outbound messages per hour, and each thread to three refusal or notice replies per hour.
- Outbound messages go only into a known thread, to the address that opened it, and only while that address is still on `dmAllowlist`.

## 5. Approvals by email

Approvals use a reply code, not buttons. The channel sends a prompt with a single-use code in the subject and body:

```
Subject: [approval 7K2Q-9M4X] Approval needed
...
To answer, reply to this email with one line:
  7K2Q-9M4X 1   = once
  7K2Q-9M4X 2   = deny
The code works once and expires in about 5 minutes.
```

A reply is accepted only when all of these hold: the sender is one of the prompt's approvers, the code matches an unexpired and unused prompt, the reply is in the prompt's thread, and the choice number is valid. Otherwise the reply is refused politely (rate-limited) and is never emitted as a decision.

Caveats:

- Email is not an authenticated channel by default. A From address can be forged on a mailbox that does not enforce DMARC. Enable `authServId` and `requireAuthPass`, and make sure the receiving server enforces DMARC for your domain, before relying on approvals.
- Anyone who can read the approver's mailbox can read the code. Treat approval prompts as sensitive, and do not approve from shared mailboxes.
- Codes are single-use and expire after `ttlMs` (default five minutes, at most 24 hours).
- Approvals grant nothing by themselves. The host decides what a decision means.

## 6. `/link`

In a reply or new mail, put `link <code>` or `/link <code>` on the first line of the body, or in the subject. The channel calls `pairing.claim` with the bot's address as the account and the sender address as the user. Replies are uniform: one message on success, another on any failure. The code is never logged or echoed. Without a `pairing` port, the line is ordinary text.

## 7. Health and failures

- `health()` reports the IMAP session (`imap:up` or `imap:down`) and the last SMTP check. SMTP is checked with NOOP at most once per ten minutes, not on every health call.
- Transient IMAP failures reconnect with exponential backoff and jitter. A rejected password is fatal: the channel reports failure to the host once and stops, without retrying the same bad password.
- A UIDVALIDITY change (the provider rebuilt the mailbox) resets the cursor to the current top of the mailbox. Old mail is not processed again.
- Corrupt state files fail closed: the channel refuses to start rather than guessing a cursor.

## 8. Limits

- No OAuth2, no S/MIME or PGP, no DSN generation, no IMAP extensions beyond IDLE.
- No outbound messages to unknown addresses; the first contact must come from the sender.
- Mail that arrives before the first start is baselined, not processed.
- At-least-once delivery across a crash between hand-off and cursor save; duplicates are suppressed only within a process.
- Mail larger than 25 MiB is skipped and logged without a reply.
- Outbound retries are in process (three attempts). A send that the server accepted before a connection drop cannot be detected, so a duplicate is possible.
- Attachments: at most ten per message, MIME allowlist only, and no virus scanning.
- Editing sent messages, typing indicators and buttons are not supported.

## 9. Troubleshooting

- `start` rejects with "email password secret is not set": create the secret named in `passwordSecret`.
- "server does not offer STARTTLS": use `security: "tls"` on the port that implicit TLS uses, or check the provider's documentation for STARTTLS.
- "IMAP authentication failed" or "SMTP authentication failed": check the app password and that IMAP or SMTP access is enabled for the mailbox. Restart after changing the secret.
- Mail is never processed: check `dmAllowlist`, that the mail is not automated (`Auto-Submitted` or bulk headers), that `authServId` matches the receiving server, and that `requireAuthPass` is not dropping it. The logs name the reason without content.
- Replies never arrive: check outbound limits and `dmAllowlist` for the thread's sender, and the SMTP host and port.

## 10. Interface wishes

See the package README. In short: a core event model for attachments and authentication results, a core decision port for approvals, a shared persistent store port for threads and UID cursors, and the `authServId` schema entry.
