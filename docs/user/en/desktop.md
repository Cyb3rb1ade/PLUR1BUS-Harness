# Desktop bundles and migration

Direct installers offer online and offline variants. Offline release bundles include the architecture-matched harness image and default models; CI preview placeholders cannot run the harness or offline inference. Store and Flatpak are online-only. The app asks before installing runtime software and shows its licence notice first. The German version of this page is [../de/desktop.md](../de/desktop.md).

The current real harness image does not yet provide every desktop pairing/session and cold-snapshot contract. A running daemon is not proof that desktop login or store migration works. Do not replace a native or stub installation's data manually. Keep the original installation and a verified M8 backup; production import and real-image rollback remain unavailable until their full gate and interrupted-migration tests pass.

Native backups use `plur1bus backup create`, `plur1bus backup verify <archive>` and stopped-core `plur1bus backup restore <archive> --dry-run`. Backup creation requires the running source core. Archives contain data, not secret-store credentials or model weights. Never copy a live database directory or assume a native update snapshot includes memory. Review the CLI help and restore plan before an eventual restore; this page does not authorize deleting the original installation.

App only uninstall keeps your data. Everything requires typing `plur1bus-state`. Store startup is managed in Windows Settings → Apps → Startup; Flatpak cannot install the host CLI or edit the host shell PATH.
