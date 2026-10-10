# Confirmation by the operating system

Some actions of an agent need your approval. For the riskier ones, the harness also requires a confirmation by the
operating system itself: Touch ID, Windows Hello, the UAC prompt or, on Linux, polkit. This page explains when that
happens, what a single confirmation does, and what it means when it is "not available". Every command here exists in
this build (`docs/cli.md` is the full reference). The German version is
[../de/bestaetigung-betriebssystem.md](../de/bestaetigung-betriebssystem.md).

**Important first:** the helper program for the confirmation is not yet included in the release builds that are shipped
today. There, every approval that needs a confirmation shows "not available". The dialogs of Touch ID, Windows Hello and
polkit can only be seen in a build that includes the helper, for example a source build (see below).

## Approvals and risk levels

When an agent wants to do something it has no permission for, it files an approval request. The request contains what
would happen, which targets are affected and how risky it is. The risk level decides who may decide:

- **low** (for example reading files, writing inside the allowed folders, reading the clipboard): you decide directly,
  without an operating-system dialog.
- **medium** and **high** (for example shell commands, package changes, deleting files outside the allowed folders): a
  decision from a local connection needs a confirmation by the operating system.
- **critical** (for example spending money, system privileges, remote control): you cannot grant these through the
  command line yet. The harness refuses them without a dialog.

The option "once" applies to exactly one action. Standing approvals (for a session or for an agent) cannot be created from
a local connection without a confirmation. With a confirmation, the approval is a level-2 approval like any other.

## Deciding on the command line

Show the open requests:

```sh
plur1bus approval pending
```

Confirm a request by its id, which starts with `apr_`:

```sh
plur1bus approval approve <id>
```

The command first shows the request: the command or change, the targets and the risk. In a terminal it asks `[y/N]`.
Without a terminal, or with `--json`, it stops unless you pass `--yes`. With `--scope` you choose the duration. Without it,
the narrowest option that the request offers is used.

Decline a request like this:

```sh
plur1bus approval deny <id>
```

## What happens when a confirmation is needed

If a request needs a confirmation by the operating system, this happens:

1. The harness first says which confirmation it requires: Touch ID, Windows Hello, UAC or polkit. Nothing has happened yet.
2. You confirm. The operating system's dialog then appears on this machine. It names the agent, the capability and the
   scope of the approval. On macOS you can use your account password instead of Touch ID.
3. The harness decides exactly this one request. The audit log records that the confirmation came from the operating
   system and which method was used.

A confirmation is tightly bound:

- It applies only to this request, with its action, scope, duration and agent.
- It is single-use. Every approval opens a new dialog. Nothing is cached, unlike `sudo`.
- It expires after at most 60 seconds. If you wait longer, confirm again.
- If the dialog is cancelled, times out or fails, the request stays open, and you can try again.

While a dialog is open, the harness does not accept a second decision for the same request.

## "Not available"

The message is `attestation-unavailable`. The command then ends with exit code 2, the request stays open, and other parts
of the harness keep running. The message appears in these cases:

- The helper program `plur1bus-attest` is not installed next to `plur1bus`. With today's release builds, this is the
  normal case.
- The installation runs in a container. There is no dialog there that you could operate.
- There is no graphical session, for example with a plain SSH connection.
- On Linux, no polkit agent is running.

What you can do then:

- **Low-risk requests** you can still decide directly. They need no confirmation.
- **Decline the request** with `plur1bus approval deny <id>`. The agent then continues without the action.
- **Wait.** An open request stays for 24 hours. After that it expires, and an expired request counts as declined. Nothing
  is approved by the passing of time.
- **Use a source build.** There the harness finds the helper if it sits next to `plur1bus`. You then need a graphical
  session, and on Linux a polkit agent.

In that case `plur1bus approval approve` ends with exit code 2 and the reason `attestation-unavailable`.

## Approvals through a chat channel

An approval that comes in through a chat channel (for example Telegram) never opens a dialog on the host. For the levels
that need a confirmation, it is therefore not accepted. Decisions made through a channel are meant for low risks. More
about channels is in [channels.md](channels.md).

## Audit log

Every confirmation leaves two entries in the audit log: one before the dialog (`attestation.requested`) and one with the
result (`attestation.result`). The result is one of `confirmed`, `cancelled`, `timeout`, `unavailable`, `failed`,
`replay` or `mismatch`. The entries name the request and a hash of the action, never the secret of the confirmation.

## Next

- [quickstart.md](quickstart.md): first steps and signing in to providers.
- [channels.md](channels.md): approvals through chat channels.
- [containers.md](containers.md): the harness in a container. No dialog-based confirmation is possible there.
- [operations.md](operations.md): troubleshooting and exit codes.
