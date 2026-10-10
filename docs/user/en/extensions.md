# Skills and plugins

Skills and plugins extend what agents and the harness can do. A skill equips an agent with specific tools and
instructions, a plugin adds modules or platform integrations, and a core module provides system-level capabilities.
Every command here exists in this build (`docs/cli.md` is the full reference). The German version of this page is
[../de/extensions.md](../de/extensions.md).

In the web interface, skills and plugins are managed under **Skills** (`#/skills`) and **Plugins** (`#/plugins`). Both
routes open the unified extensions manager with the filter preset accordingly.

## Listing extensions

View installed skills:

```sh
plur1bus skill list
```

View installed plugins:

```sh
plur1bus plugin list
```

In the web interface, the list displays the extension name, kind (skill, plugin, or module), version, source, active
state, and health or compatibility status.

## Inspecting details

Show details and declared permissions for a skill:

```sh
plur1bus skill show <name>
```

Show details for a plugin:

```sh
plur1bus plugin show <name>
```

Selecting an extension in the web interface opens the detail panel, showing origin metadata, compatibility notes, and
permission requirements.

## Enabling and disabling

Enable or disable a skill for all agents or for a specific agent:

```sh
plur1bus skill enable <name>
plur1bus skill disable <name>
```

Enable or disable a plugin:

```sh
plur1bus plugin enable <name>
plur1bus plugin disable <name>
```

In the web UI, toggling an extension activates or deactivates it immediately. Changes update in real time when event
streaming is active.

## Installing extensions

You can install extensions from a local file archive (`.p1x` or tarball):

```sh
plur1bus skill install <path>
plur1bus plugin install <path>
```

You can also inspect a package before installation to review its manifest and required permissions:

```sh
plur1bus ext inspect <path>
```

In the web interface, click **Install from file** to upload a package file. The installer inspects the archive and
displays its permissions and compatibility before you confirm installation.

Installing directly from the remote catalog (`plur1bus.app`) is not yet available in this version. The web interface
displays an informational notice rather than an inactive action.

## Uninstalling and restoring

Uninstall an extension:

```sh
plur1bus skill uninstall <name>
plur1bus plugin uninstall <name>
```

Uninstalling moves the extension to trash so that it can be recovered if needed. In the web interface, the uninstall
dialog lets you choose whether to purge remaining data or cascade removal to dependent items.

Restore a previously removed extension using its trash identifier:

```sh
plur1bus skill restore <trash_id>
plur1bus plugin restore <trash_id>
```
