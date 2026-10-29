# Import an existing installation

Owner and Admin can open **Import** at `#/import` or use the optional Import step in setup. Both use the same
source inspection, preview and preflight flow. The German version is [../de/import.md](../de/import.md).

**Current validation limit:** actual HTTP apply has passed through the native supervisor, Core shutdown and restart.
Cancellation and mid-import automatic restoration passed with an exact comparison of all mutable data.
The MFA-approved native import cookie also passed stopped-Core progress and isolation checks. Fresh manual rollback also passed with exact restoration of all mutable data, removal of the imported skill and
another Core restart. Changes made after a completed import still prevent unsafe rollback.
Both supported source families also passed the actual HTTP → read-only SSH/SFTP → sealed snapshot → native maintenance flow, including imported memory recall and disabled skill/MCP state.
Required browser interaction and accessibility checks are blocked by the unavailable pinned browser resource.
Skills-only import keeps the Core running.

## Select and inspect a source

Choose a supported source format from the list supplied by your harness, then its location:

- **Detected on this computer:** inspect the known source location on the harness host.
- **Folder on the harness host:** enter a source path. Owner may do this remotely; Admin needs a local connection.
- **WSL installation:** choose a distribution. Listing does not start a stopped distribution; probing one requires
  its separate explicit confirmation.
- **SSH connection:** use a configured connection with a trusted host key and permitted source root. The Owner can
  choose **Configure SSH access** in an ordinary account session, generate a key and follow the returned read-only
  SFTP setup instructions. Saving a connection requires explicit approval of its exact host and port in the central
  egress policy; the screen shows the existing lists and explains their combined effect. Verify the host-key
  fingerprint independently before trusting it. Admin can select configured connections but cannot set them up.
  In container deployments, the authenticated catalog can propose `host.docker.internal` as the Docker host;
  verify that destination and any Linux host-gateway mapping. The proposal does not approve egress, a private address or a host key.
  See the [SSH import reference](../../import.md) for operating-system instructions.
- **Uploaded snapshot:** select a `.tar.gz` snapshot. In the Desktop app, **Choose a source on this computer** uses the
  native picker and snapshot producer. JavaScript receives an opaque handle, never the selected local path.

Snapshot uploads belong to the signed-in person, expire after ten minutes and are separate from extension package
uploads. Compressed input is limited to 1 GiB. Safe extraction also limits expanded bytes, file count and nesting;
archives that violate those checks are refused.

### Set up read-only SSH on the source

Use a dedicated source account that can read only the intended import files. The Harness generates its Ed25519 key
in the Secret Store; install only the public, restricted line returned by **Configure SSH access** or the CLI key
status command. The source needs an OpenSSH server with SFTP. The Harness neither installs that server nor changes
the source's SSH configuration.

The returned line has this form; replace both placeholders if constructing it manually:

```text
restrict,command="<SFTP_SERVER> -R" <PUBLIC_KEY> plur1bus-import
```

`<PUBLIC_KEY>` is the complete generated `ssh-ed25519 …` public key. Keep `restrict`, the forced command and `-R`:
the forced command replaces a shell session, `-R` denies SFTP writes and filesystem changes, and `restrict` disables
forwarding, PTY allocation and user SSH startup scripts ([1](#ssh-sources)). Do not install an unrestricted bare key.
Verify the executable path on the source before using one of these templates:

| Source OS | `<SFTP_SERVER>` template | Verification and setup |
| --- | --- | --- |
| Debian | `/usr/lib/openssh/sftp-server` | Confirmed in the installed Debian 13 `openssh-sftp-server` package `1:10.0p1-7+deb13u4` on 2026-10-29. Check your source package's file list. |
| Ubuntu | `/usr/lib/openssh/sftp-server` | **Unverified for the current Ubuntu package** in this review; confirm its installed file list before use. |
| Fedora / RHEL | `/usr/libexec/openssh/sftp-server` | Template from OpenSSH's Red Hat packaging; confirm the installed path ([2](#ssh-sources)). |
| Arch | `/usr/lib/ssh/sftp-server` | Template from the official archived Arch package recipe; the current installed package was not checked ([2](#ssh-sources)). |
| macOS | `/usr/libexec/sftp-server` | Path supported by Apple's OpenSSH build settings. Enable Remote Login for the dedicated account. **Unverified:** the current settings location, commonly System Settings → General → Sharing → Remote Login ([3](#ssh-sources)). |
| Windows OpenSSH | `C:/Windows/System32/OpenSSH/sftp-server.exe` | Standard Windows installation template; replace it if OpenSSH is installed elsewhere ([4](#ssh-sources)). |

On Unix, append the complete restricted line to the source account's `~/.ssh/authorized_keys`; that account must own
the directory and file, with permissions `700` for `.ssh` and `600` for `authorized_keys`. Restrict that account's
filesystem access separately: read-only SFTP does not by itself confine which readable directories it can see.

On Windows, a standard account uses `%USERPROFILE%\.ssh\authorized_keys`. An administrator account instead uses
`%ProgramData%\ssh\administrators_authorized_keys`; disable inherited ACLs on that file and allow only Administrators
and SYSTEM, as described by Microsoft ([4](#ssh-sources)). Add the same complete restricted line, not just its public key.

Back in the Harness, approve only the exact host and TCP port you intend to use. Private-address consent is separate
from the central egress allowlist. Probe the host key, compare the displayed SHA256 fingerprint with a trusted
source-host administrator or console, then explicitly trust that probe. A changed host key stops access. These are
setup templates and source checks, not a claim of tested server operation on every listed OS. Without suitable SSH
access, use the Desktop local snapshot flow described above.

Choose **Inspect source** for a specific installation. For a broad host, WSL or SSH folder, **Find installations**
performs bounded discovery in known locations. Select a detected installation to inspect; discovery alone does not create
an import plan. Standalone discovered stores are listed separately and need a source/agent and original-path
assignment. In the import options, map the original external path declared by that source to the returned store
selection. The displayed discovery path is metadata; the server keeps its original local, WSL or SSH read authority
and seals the selected store into the preview. A mapping replaces a source read location, not an import destination.
Review agent counts, skills, stores, plugins, MCP servers, unsupported items and warnings.
Plugin classifications are compatibility information, not permission to run source code. Imported MCP configuration
remains disabled and may need secret setup. Source credentials never appear in the preview.

## Choose and preview

Select the agents to import. The options include conflict choices, profile and path mappings, source-store adoption or
re-embedding. Store choices use the actual inspected store metadata and show the reported agent/shared association
and row count when available. Original external paths reported by the source can be selected for read-location mappings. Only the Owner can request source credential migration; existing target secrets are preserved.

For a selected store, review the reported **Source model candidate**, dimensions, revision and licence. This is metadata;
preflight must still verify the copied vectors against the actual pinned source model. Re-embedding also displays
the host's current target model when no target was entered. A custom or unsupported current target needs an explicit supported local target.

Every non-commercial source or target model requires the real persisted licence acceptance for that person, model
and pinned revision, with an allowed use class. The interface records each supported model's acceptance separately.
The host-wide non-commercial acknowledgement remains a separate Settings decision; the review links to it without
changing it. If that change restarts the Core, inspect the source and create a fresh preview afterward. Import-only
device sessions must use the same person's ordinary Owner/Admin account session for model/settings consent; their
permissions are never widened. An invented acceptance identifier or an unchecked box is not a preflight proof.

Choose **Create preview**. Resolve any remaining conflicts and update the preview. A change produces a new immutable
plan; apply does not accept extra conflict answers or a force override.

## Preflight and maintenance

Choose **Run preflight**. A failed check leaves the Core running. A passing check shows expected downtime and disk
requirements. Review and explicitly accept stopping the Core before choosing **Apply import**.

Progress shows the reported native state and checkpoint. **Cancel and restore snapshot** requests cancellation;
keep watching until restoration and restart are reported. Closing the browser does not cancel the job. History
reopens recorded runs. Resume or rollback requires another preflight against the current target state; changes made
after the run can prevent rollback.

During a stopped-Core operation, the initiating browser cookie can retain narrowly scoped progress and cancellation
access. An enrolled native import session additionally needs the private provenance of a same-person, imports-purpose
MFA approval; an ordinary device cookie is insufficient. Another session of the same person cannot inherit access.
The context expires with the session or its fixed maintenance deadline and is not renewed by reload. Personal API
tokens cannot substitute for this human approval. The same-person MFA-approved cookie has passed the actual stopped-Core flow; browser and embedded UI interaction
checks still await the required browser resource.

## Skills only and CLI

**Preview skills only** shows skill actions without stopping the Core. Review the preview, explicitly accept it and
choose **Import skills only**. Activating imported skills for all agents is a separate choice.

The CLI remains available for source inspection and maintenance:

```sh
plur1bus import --help
```

For the existing CLI rollback workflow and its memory-card limits, see [Import rollback](import-rollback.md).

### SSH sources

[1] OpenSSH's [`sshd(8)` authorized-key options](https://github.com/openssh/openssh-portable/blob/master/sshd.8)
    and [`sftp-server(8)` read-only mode](https://github.com/openssh/openssh-portable/blob/master/sftp-server.8).

[2] OpenSSH's [Red Hat package recipe](https://github.com/openssh/openssh-portable/blob/master/contrib/redhat/openssh.spec)
    and the [official archived Arch recipe](https://github.com/archlinux/svntogit-packages/blob/packages/openssh/trunk/PKGBUILD).

[3] Apple's [OpenSSH build settings](https://github.com/apple-oss-distributions/OpenSSH/blob/main/xcconfigs/openssh.xcconfig)
    and [installation paths](https://github.com/apple-oss-distributions/OpenSSH/blob/main/xcconfigs/base.xcconfig).
    Current Remote Login settings navigation could not be independently verified here.

[4] Microsoft's [OpenSSH key management](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/administration/OpenSSH/OpenSSH_KeyManagement.md)
    and [server configuration](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/administration/OpenSSH/openssh-server-configuration.md).
