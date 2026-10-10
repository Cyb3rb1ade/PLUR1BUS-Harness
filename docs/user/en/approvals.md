# Approvals and grants

When an agent needs to perform an action outside its standard permissions, it creates an approval request. You can
review, grant, or deny requests, and manage active standing permissions (grants). Every command here exists in this
build (`docs/cli.md` is the full reference). The German version of this page is [../de/freigaben.md](../de/freigaben.md).

For requests requiring operating system authentication (Touch ID, Windows Hello, polkit), see
[os-confirmation.md](os-confirmation.md).

In the web interface, approval requests and active grants are managed under **Approvals** (`#/approvals`).

## Reviewing pending requests

View open approval requests:

```sh
plur1bus approval pending
```

Or list all approval requests:

```sh
plur1bus approval list
```

In the web interface, each pending request is presented as a card following the D109 layout. To keep decisions safe
and objective, the card displays the requested capability, concrete action impact, exact target resources, risk tier,
reversibility, and action hash shortcut strictly **before** the agent's self-reported rationale (which is explicitly
marked as unverified).

## Deciding on a request

Approve a request:

```sh
plur1bus approval approve <id>
```

Deny a request:

```sh
plur1bus approval deny <id>
```

In the web interface, choosing **Approve** lets you select the grant scope and duration (up to a maximum of 90 days).
If the server requires local operating system attestation, an explanatory note guides you through completing the
system confirmation prompt.

## Active grants and revocation

List active standing grants:

```sh
plur1bus grant list
```

Revoke an active grant before it expires:

```sh
plur1bus grant revoke <id>
```

In the web interface, the **Active Grants** tab lists all currently valid grants with their scope, target, expiration
time, and a revocation button.
