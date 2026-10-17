# Inviting people

People are invited under **Settings → Users & roles**. An invitation creates a person with a role and gives you a link they can use to join. The German version of this page is [../de/einladungen.md](../de/einladungen.md).

## Create an invitation

1. Open **Settings → Users & roles** and choose **Invite person**.
2. Enter a **name** of 1 to 128 characters. It is shown in lists.
3. Choose a **role**: Admin, Operator, Member or Viewer. Owner cannot be granted by invitation; ownership is handed over separately.
4. Choose **Valid for**: 1 hour, 24 hours, 7 days, 30 days, or **Custom** with a whole number of hours from 1 up to 720 (30 days).
5. Choose **Send invitation**.

## Copy the link now

The link is shown once, right after you create the invitation. Copy it and send it to the person. It works once and is not shown again. If you lose it, revoke the invitation and create a new one.

## Open invitations

The list under **Open invitations** shows each open invitation with its expiry time. Use **Revoke** to stop one at once. Revoking asks for confirmation, and it cannot be undone. After that the link no longer works, even before it expires.

## Next

- Break-glass access to a person's data: [breakglass.md](breakglass.md)

## Create a web account

Open the invitation link (or `#/join`) and enter a username, a password of at least 12 characters, and the repeated password. The link grants only the invited person's access. After account creation, sign in separately with **Use username and password**. If TOTP is enabled through the existing API enrollment flow, sign-in asks for a TOTP or backup code.

In **Settings → Users & roles**, Owner can disable or enable a person; Admin can do this for Members and Viewers. Disabled people show a badge. Disabling ends web sessions and streams and permanently revokes their old tokens. Enabling preserves role and rights but requires a new login. The last active Owner cannot be disabled.
