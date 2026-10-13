# Break-glass access

Break-glass (`#/breakglass`) is emergency access to another person's private data: their cards and transcripts. It is for cases where the normal route is not enough. Every request is audited, time-limited and cannot be undone. The affected person is notified at once. The German version of this page is [../de/breakglass.md](../de/breakglass.md).

## Who can use it

Only Owner and Admin see the page. Everyone else gets a "no permission" state.

## Request access

1. Choose **Request break-glass**.
2. Enter the **target user**, the user ID (for example `usr_admin`).
3. Write a **reason** of 10 to 500 characters. It is delivered in the notice to the affected person and written to the audit log.
4. Choose the **access window** in minutes.
5. Tick the confirmation box. Without it the request is not sent.
6. Choose **Request access**.

The window grants read-only access to the target's private cards and transcripts for the chosen time.

## While a window is active

- A banner at the top shows the target, the remaining time and a **Revoke now** button.
- **Revoke now** asks you to confirm. Choose **Revoke window** to end access at once, or **Keep active** to cancel.

## The three tabs

- **Active windows:** windows that are running now.
- **Past windows:** expired and revoked windows, with the reason.
- **Received notices:** what the affected person sees, if you are a target. Those notices also appear in the [Inbox](inbox.md).

## Good to know

- Access is logged. Expect the affected person to see the reason.
- The window is fixed when you request it. If you still need access after it ends, request a new one.

## Next

- Audit trail and log viewer: [operations.md](operations.md)
