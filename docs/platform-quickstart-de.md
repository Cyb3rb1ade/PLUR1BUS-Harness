# Schnellstart je nativer Plattform

Diese Einstiege ergänzen den [vollständigen Schnellstart](user/de/quickstart.md) und das
[Betriebshandbuch](user/de/operations.md). [English](platform-quickstart-en.md).
Binary und Core-Payload müssen zur **nativen** Architektur im Release-Manifest passen.
Ein lokaler Build oder eine andere Architektur belegt keine verpackte Release-Abnahme.

| Target | Release-ID | Standard-Home | Benutzerdienst |
|---|---|---|---|
| macOS Apple Silicon | `darwin-arm64` | `~/.plur1bus` | launchd User Agent, beim Login |
| Windows x64 | `win-x64` | `%LOCALAPPDATA%\PLUR1BUS` | Task Scheduler, konfigurierter Login-Trigger |
| Windows ARM | `win-arm64` | `%LOCALAPPDATA%\PLUR1BUS` | Task Scheduler auf nativem ARM |
| Linux x64 | `linux-x64` | `~/.plur1bus` | `systemd --user` |
| Linux ARM | `linux-arm64` | `~/.plur1bus` | `systemd --user` auf nativem ARM |

Binary in einem benutzerschreibbaren Ordner ablegen, auf PATH legen und `plur1bus --version` prüfen.
In PowerShell heißt es `plur1bus.exe`; ohne PATH beispielsweise `& 'C:\Pfad mit Leerzeichen\plur1bus.exe'`.
Für den Release-Kandidaten ein Wegwerf-Home verwenden:

```sh
plur1bus --home /absolutes/wegwerf-home setup --non-interactive --no-service --agent main
plur1bus --home /absolutes/wegwerf-home daemon status --json
plur1bus --home /absolutes/wegwerf-home 1staid check --json
```

Unter Windows stattdessen einen nativen absoluten Home-Pfad wie `C:\Users\du\PLUR1BUS-test` einsetzen.
`--no-service` lässt die OS-Registrierung für den ersten Funktionstest aus. Anschließend einen Provider
nach dem [Provider-Guide](user/de/providers.md) konfigurieren und Chat/Memory im vollständigen
Schnellstart prüfen. Provider-Schlüssel nicht als Argument übergeben; `secret set` liest stdin.

Für die Dienstabnahme `service install` und `service status --json` mit demselben Home verwenden.
Linux ohne aktive Anmeldung braucht einen Benutzermanager mit Lingering; siehe Betriebshandbuch und
[Neustartprotokoll](reboot-survival.md). Die OS-Berechtigung für Lingering ist eine separate Entscheidung.
Ein erfolgreicher Installer beweist noch keinen echten Neustart.

[Portable verschlüsselte Backups](portable-backup.md) enthalten die Vault; gewöhnliche `backup create`-
Archive schließen sie aus. [Update/Rollback](updates.md), [Deinstallation](uninstall.md),
[Release-Lücken](release-known-issues-v0.1.0.md) und [Nachweis-Checkliste](release-checklist-v0.1.0.md)
gelten für alle fünf Targets. Native Windows-Rollback-Ergebnisse und Windows-ACL-Parität bleiben offen.
macOS Intel bleibt gemäß [Plattformmatrix](platform-matrix.md) best effort.
