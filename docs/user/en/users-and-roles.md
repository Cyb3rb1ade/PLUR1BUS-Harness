# Users and roles

Who may use this installation, and what each person may do, is set under **Settings → Users & roles** (`#/settings/users`). Every person has exactly one role. On top of the role, a Member can hold rights on single agents. The German version of this page is [../de/benutzer-rollen.md](../de/benutzer-rollen.md).

The tab **People** is for Owner and Admin only. Everyone else sees a note with their own role. The tab **Identities** is open to everyone who can open the page.

## The five roles

| Role | What the role is for |
|---|---|
| **Owner** | Full control. Only the Owner reveals or writes secrets, confirms model licences, hands over ownership and deletes users. |
| **Admin** | Runs the installation day to day: users, settings, models, providers, channels and plugins; creates and manages every agent; queries logs and reads the audit trail; decides on approvals; requests break-glass access. An Admin sees the names of secrets but cannot reveal or change them. |
| **Operator** | Watches and runs the system: reads every agent, pauses and resumes agents, runs jobs, dreams and schedules, sees sessions, models and providers, runs the doctor and reads approvals. An Operator chats with an agent only with the right **Use** and cannot change settings. |
| **Member** | Works with the agents that are shared with them through the right **Use**, and keeps their own private memory. With **Manage** on an agent a Member can also change it. |
| **Viewer** | Read only: the agent list, the status of agents shared with them, sessions, models and jobs. A Viewer does not chat and does not write anything, whatever rights are set. |

The exact table of what each role may do is in [../../rbac.md](../../rbac.md). Two things apply to every role. Nobody reads another person's private memory except through break-glass, see [breakglass.md](breakglass.md). And the server decides in the end: a page that hides or disables a button for your role is a convenience, not the check.

## People

The list shows each person with name, ID, role and badges: **Signed in**, the number of linked identities or **No linked identity**, and **Pairing pending**. You are marked **you**.

- **Change role:** pick another role in the select of the row. The change applies at once and the page says so. You cannot change your own role, and the last Owner cannot be demoted.
- **Disable person** and **Enable person** change a person's access after a confirmation. Disabling ends their sessions and revokes their tokens; enabling needs a new login. The last active Owner cannot be disabled. More in [invitations.md](invitations.md).
- **Read as … (break-glass)** opens the request for emergency access to that person's private data, see [breakglass.md](breakglass.md). Active windows are listed below the people with their remaining time and can be revoked there.
- **Invite person** creates a new person with a role and a link. This is described in [invitations.md](invitations.md). Open invitations are listed below the people and can be revoked.

Under **Role presets** you can click through the five roles and read what each can and cannot do. That box only explains; roles are changed in the list above it.

## Rights per agent

Switch off **Simple mode** to set rights per agent. Pick the **person**, then tick **Use** or **Manage** for each agent and choose **Save rights**. Only what you changed is saved.

- A Member sees only the agents shared with them. Sharing an agent means giving the Member the right **Use**. **Manage** includes **Use** and lets them change the agent.
- An Operator can read and run every agent but chats only with **Use**. An Operator cannot hold **Manage**.
- Owner and Admin hold **Manage** on every agent through their role, so they are not listed. A Viewer only reads, whatever rights are set.

The same rights are shown on each agent's detail page, see [agents.md](agents.md).

## Identities

The tab **Identities** is about your own accounts on channels such as Telegram. It lists the linked accounts as channel, account and user, and the pairings that are waiting.

1. Enter the **Channel** and choose **Issue pairing code**. The page shows a **One-time code** and when it expires.
2. Send the bot `/link <code>` in a direct chat. The exact form for each channel is in [channels.md](channels.md). The code is valid for 10 minutes and works once.
3. When the pairing is waiting here, choose **Approve link**, or **Decline link** if it was not you.

A link is made only by this proof, never because two names look alike. **Remove** takes a link away after a confirmation; the old channel memories then leave your union, and your own memories remain. A Viewer can read the list but not change it. How to set up channels is in [channels.md](channels.md).

## On the command line

```sh
plur1bus user list
plur1bus user role <user> operator
plur1bus user add "Sam"
plur1bus user ls --all
plur1bus user invite create "Sam" --role member --channel telegram --minutes 120
plur1bus user invite list
plur1bus user invite revoke <invite-id>
plur1bus user pair start --channel telegram <user>
plur1bus user pair confirm <pairing-id>
plur1bus user link --channel telegram --account <account> --user-id <id> <user>
plur1bus user unlink <link-id>
```

- `user list` shows the people and the role presets, `user role` assigns one of `owner`, `admin`, `operator`, `member` or `viewer`. The last Owner is protected.
- `user add` creates a person and prints their ID. `user ls` lists people with their linked identities and the pairings that are waiting; `--all` includes revoked links.
- `user invite create` makes a one-time invitation with a fixed role (`admin`, `operator`, `member` or `viewer`) for a channel. The code is shown once. `--minutes` sets how long it is valid, 60 by default.
- `user pair start` mints a one-time code for a person on a channel, valid for 10 minutes. The channel adapter presents it; it links nothing until you confirm it with `user pair confirm`, or reject it with `--reject`.
- `user link` links a channel identity by hand, without a code. It is audited and never inferred. `user unlink` revokes a link at once; the record stays for the audit trail.
- Your own identities have their own commands, see [channels.md](channels.md). Agent rights on the command line are in [agents.md](agents.md).

The user commands are marked experimental in the command reference.

## Next

- Invite people: [invitations.md](invitations.md)
- Emergency access to private data: [breakglass.md](breakglass.md)
- Managing agents and their rights: [agents.md](agents.md)
- Your own account and passkeys: [passkeys.md](passkeys.md)
