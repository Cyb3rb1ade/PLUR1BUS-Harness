# General settings

Open **Settings → General** (`#/settings/general`). `#/settings` also opens this section. The German version is [einstellungen-allgemein.md](../de/einstellungen-allgemein.md).

## Access and fields

Owner and Admin may read and change configuration in the browser. The configuration interface denies Operator, Member and Viewer access. If a view supplies readable values, its controls are disabled for those roles; this grants no additional permissions.

The page shows the current value, configuration key, any defaults and bounds, and the effect on the running system. Field names are derived from the key; the full key below each label identifies the setting.

Groups include:

| Group | Settings |
|---|---|
| Core | `core.logLevel`, recall time budgets and text limit, capture waiting time, shutdown budget |
| Supervisor | shutdown grace period (`supervisor.graceMs`), health-check interval (`supervisor.healthIntervalMs`), CPU cores PLUR1BUS may use (`supervisor.maxCores`) |
| Logs | maximum file size (`logs.maxBytes`), number of retained files (`logs.keep`) |
| Metrics | enable metrics (`metrics.enabled`), port (`metrics.port`) |
| Other | `modules` as read-only JSON |

Expand a group using its heading. Structured values appear as JSON and cannot be edited here. Fields whose keys indicate secrets are omitted; use [Secrets](secrets.md).

**CPU cores.** `supervisor.maxCores` is a slider from 1 to the number of cores the supervisor detected on the host. The right end uses every core; that is the default and is stored as `0`. The limit applies at once to every PLUR1BUS process and the programs they start; it does not limit threads. When the supervisor reports no core count, the field is a number input where `0` means every core. When the operating system cannot bind processes to cores (macOS) or the binding fails, a note at the field says so. The CLI does the same with `plur1bus config set supervisor.maxCores`; see [operations.md](operations.md).

## Review and save changes

1. Change a value. Nothing is saved yet. **Discard changes** resets the draft to the loaded values.
2. Choose **Review changes**. Invalid inputs receive a message at the field. The preview shows the old and new values for each key and the required restart class.
3. Check the preview and choose **Save**. **Back to editing** returns to the draft. If server preview is unavailable, the page labels the preview as computed in your browser; this does not yet confirm a valid save.
4. After a successful save, the notice lists changed keys and any units reported as restarted.

**Live** applies without a core restart; **Core restart** or a module restart label indicates the corresponding interruption. An unknown class is shown as unknown. Follow the label at the field and in the preview.

If someone changed the configuration after you loaded it, saving is refused. Reload the current values and make your edits again. Leaving a section with unsaved changes prompts for confirmation; closing or reloading the tab also triggers a browser warning.

## Next

- Outgoing connections: [Network](network-settings.md)
- Operations, services and CLI configuration: [operations.md](operations.md)
- Find a field directly: [Command palette](command-palette.md)
