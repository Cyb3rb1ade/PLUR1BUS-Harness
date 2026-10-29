# Skills and extensions

Owner and Admin manage extensions under **Skills** (`#/skills`) and **Plugins** (`#/plugins`). Other roles cannot
read the extension inventory or change it. The filters cover skills, modules, channels, MCP servers and bundles.
Settings → **Modules & Updates** also shows installed non-skill extensions with their kind, trust and status.
The German version is [../de/extensions.md](../de/extensions.md).

## Install from a file or folder

1. Choose **Install from file**. Select a package (`.p1x`, `.zip`, `.skill`, `.mcpb` or `.dxt`), or switch to **Folder**.
   The browser sends file bytes. A folder is packaged in the browser; its local path is not sent to the harness.
2. Review the confirmation page. It shows the trust tier, signer and signing-key ID, publisher, licence, executable
   scripts and shebangs, capabilities and runtime requirements. An unverified publisher is labelled explicitly.
3. Accept the requested capabilities. Unsigned and unknown-signer packages have their own acknowledgement;
   replacing an installed version needs a separate confirmation.
4. Choose **Install** to leave a third-party package inactive, or **Install and activate** and select its agents.
   First-party packages show a notice that installation activates them for all agents and offer only **Install**.

The upload and inspection belong to your signed-in person and expire after ten minutes. Reloading the confirmation
page reloads that owned inspection. If it has expired, upload the package again. The interface checks the inspection
again immediately before installation; changed disclosures must be reviewed and accepted again.

For a bundle, review every child's own signer, trust, capabilities and scripts. Required children stay selected;
optional children start unselected. Only the selected children are installed and contribute to the confirmations.
The bundle's signature does not change a child's trust tier. A first-party bundle still requires acknowledgement
of selected unsigned or unknown-signer children before activation.

The package byte limit comes from the harness configuration (256 MiB by default). An oversized or interrupted upload
fails without leaving a usable package. Direct installation from the `plur1bus.app` catalogue is not available yet.
**From an existing installation** opens the [import flow](import.md).

## Activate for agents

An extension's detail page shows its declared capabilities. Enabling it first opens a confirmation of those rights;
if the rights change while the dialog is open, nothing is enabled until you review them again. Skills, MCP servers
and bundles have per-agent switches. Modules and channels use the installation-wide action.

Bundle details list each installed child and its effective agents. **Partially active** means that only some selected
children are active. Group activation shows the installed children's capabilities again; missing or changed child
disclosures block activation until they can be reviewed.

The list and detail reload after authorized extension change events. Failed actions leave the displayed state
unchanged and provide a retry or error state.

## MCP setup and sign-in

A package that needs configuration shows its setup state. Required secret slots show only their name and whether a
value is configured. Only the Owner can enter or replace a secret; Admin can read availability. A submitted value is
cleared from the input and is never returned by the setup API or shown as an existing value.

OAuth starts only after you choose **Start sign-in**. Supply the client ID and loopback redirect registered for this
host, or use its existing configured registration. Follow the authorization link or device-code instructions. When
asked, paste the complete callback URL into the protected callback field. You can cancel the attempt. An attempt is
bound to the person who started it and to that MCP server; browsing the tool list never starts sign-in.

Native device credentials require explicit extension enrollment. For an account that requires TOTP or a passkey,
the native continuation uses a short-lived approval code: open its approval page in a browser account session of the
same person, complete the required factor and approve the displayed extension purpose. The native app obtains
one-use operation proofs privately; no device credential is pasted into the page. Personal API tokens cannot replace
this approval. The real API MFA flow is tested; full native UI and browser acceptance are still pending.

## Remove or restore

Uninstall moves the package to trash. Review the separate purge and dependent-module options before confirming.
A retained trash version can be restored from the detail page; restoration leaves it inactive.

The CLI remains available for local administration:

```sh
plur1bus skill list
plur1bus plugin list
plur1bus ext inspect <path>
plur1bus skill enable <name>
plur1bus skill disable <name>
plur1bus plugin uninstall <name>
```

For credential storage, see [Secrets](secrets.md). For source migration and its recovery limits, see
[Import](import.md) and [Import rollback](import-rollback.md).
