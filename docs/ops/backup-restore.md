# Backup und Wiederherstellung

`plur1bus backup` ist [experimentell](../cli.md#plur1bus-backup-create). Dieser Ablauf verwendet ausschließlich die
vorhandenen Befehle `create`, `verify` und `restore`.

## Speicherorte

Das Home-Verzeichnis ist standardmäßig:

| Betriebssystem | Home |
|---|---|
| Linux | `~/.plur1bus` |
| macOS | `~/.plur1bus` |
| Windows | `%LOCALAPPDATA%\PLUR1BUS` |

`--home <PATH>` oder `PLUR1BUS_HOME` wählt stattdessen ein anderes Home. Verwende bei allen Schritten dasselbe Home.
Ohne `--out` schreibt `backup create` das Archiv nach
`<home>/backups/plur1bus-backup-<UTC>.tar.gz`. Ein vorhandenes Ziel wird nie überschrieben. Mit `--out <FILE>` lässt
sich ein anderer, noch nicht vorhandener Zielpfad wählen.

Das Archiv enthält den Memory-Store und SQLite-Datenbanken (durch den Core konsistent kopiert) sowie Konfiguration,
Agents, Skills, Module, Extensions, Katalog, Capture-Journal und Systemjob-Ledger. Der Secret-Store wird nie gelesen:
Laufzeittokens (`run/`), API-Schlüssel im Schlüsselbund und die verschlüsselte Fallback-Datei sind nicht enthalten.
Ein Webhook-Secret, das in `config.json` selbst steht (`channels.telegram.webhook.secret`), wird im Archiv durch einen
Platzhalter ersetzt; die Live-Datei bleibt unverändert. Beim Restore erzeugt `backup restore` dafür einen neuen
Zufallswert, der Telegram-Kanal meldet ihn beim nächsten Start per `setWebhook` an; der alte Wert wird nicht wiederhergestellt
(die Konfiguration bleibt gültig). **Nicht** geschützt ist die API-Kontendatenbank `state/api/accounts.db`: Sie wird
mitgesichert, damit Konten nach einem Restore wieder da sind, und enthält Passwort-Hashes (Argon2id), TOTP-Seeds, deren
Backup-Code-Hashes und Hashes persönlicher Tokens. Wer das Archiv besitzt, kann Hashes offline angreifen und den zweiten
Faktor nachbilden. Das Archiv ist weder signiert noch verschlüsselt; bewahre es entsprechend geschützt auf (für eine
verschlüsselte Variante siehe [portables Backup](../portable-backup.md)). Ein externes Obsidian-Vault ist nicht Teil des
Backups. Ist `config.json` kein gültiges JSON, bricht `create` mit `config-unreadable` ab, statt die Datei ungeprüft zu
archivieren; `plur1bus 1staid repair` stellt sie wieder her.

Dateirechte: Das Manifest hält die Rechte der Quelldateien fest (ein ausführbares Skill-Skript bleibt für den Besitzer
ausführbar). Beim Restore bleiben nur die Rechte des Besitzers erhalten, nichts wird breiter; `<home>/backups/` und
`pre-restore-<id>/` sind `0700`.

## Backup erstellen und prüfen

`create` benötigt einen laufenden Core. Das gilt unter Linux, macOS und Windows gleichermaßen; bei einer installierten
Systemdienst-Registrierung steuert `daemon` den Supervisor.

1. Optional zuerst prüfen, was archiviert würde. Dieser Probelauf schreibt nichts:

   ```sh
   plur1bus backup create --dry-run
   ```

2. Backup erstellen:

   ```sh
   plur1bus backup create
   ```

   Für einen bestimmten Zielpfad:

   ```sh
   plur1bus backup create --out "/pfad/zum/ziel/backup.tar.gz"
   ```

   Unter PowerShell beispielsweise:

   ```powershell
   plur1bus backup create --out "D:\Backups\backup.tar.gz"
   ```

3. Den vom Befehl ausgegebenen Archivpfad notieren und das Archiv prüfen:

   ```sh
   plur1bus backup verify "/pfad/zum/backup.tar.gz"
   ```

   `verify` prüft Manifest, Einträge und SHA-256-Prüfsummen. Nur bei erfolgreicher Prüfung das Archiv für eine
   Wiederherstellung verwenden. Kopiere es anschließend zur Aufbewahrung auf ein separates Backup-Medium.

## Wiederherstellen

Restore ersetzt oder entfernt die im Plan aufgeführten Einheiten. Der Core und der Supervisor für dieses Home müssen
gestoppt sein. `restore` prüft das Archiv vor dem Anwenden und bewahrt ersetzte Daten unter
`<home>/backups/pre-restore-<id>/` auf. Bei einem Fehler wird der vorherige Zustand zurückgesetzt.

1. Supervisor und Core stoppen:

   ```sh
   plur1bus daemon stop
   ```

   Das gilt auf Linux, macOS und Windows. Bei einem eigenen Home dieselbe `--home <PATH>`-Angabe wie bei den
   übrigen Befehlen verwenden. Vor dem Fortfahren den Status prüfen:

   ```sh
   plur1bus daemon status
   ```

2. Mit dem Archivpfad aus Schritt 3 den Plan ansehen. `--dry-run` ändert nichts:

   ```sh
   plur1bus backup restore --dry-run "/pfad/zum/backup.tar.gz"
   ```

3. Den Plan prüfen und Restore ausführen:

   ```sh
   plur1bus backup restore "/pfad/zum/backup.tar.gz"
   ```

   Auf einem Terminal fragt der Befehl vor dem Anwenden nach Bestätigung. Für Skripte oder mit `--json` ist die
   Bestätigung explizit erforderlich:

   ```sh
   plur1bus backup restore "/pfad/zum/backup.tar.gz" --yes
   ```

   PowerShell-Beispiel:

   ```powershell
   plur1bus backup restore "D:\Backups\backup.tar.gz" --yes
   ```

4. Nach erfolgreichem Restore den Dienst wieder starten und den Zustand kontrollieren:

   ```sh
   plur1bus daemon start
   plur1bus daemon status
   plur1bus 1staid check
   ```

   Falls eine Store-Migration erforderlich ist, beachte die [CLI-Anleitung zu `admin migrate`](../cli.md#plur1bus-admin-migrate):
   der Befehl benötigt die aktuelle und die Ziel-Schema-Version als `--from` und `--to`. Die ersetzten Dateien
   bleiben im genannten `pre-restore`-Verzeichnis.

## Typische Fehler

| Meldung oder Grund | Bedeutung und nächster Schritt |
|---|---|
| `create` erreicht den Core nicht (`E_CORE_UNAVAILABLE`) | `create` benötigt den laufenden Core. `plur1bus daemon status` prüfen und den Supervisor bei Bedarf mit `plur1bus daemon start` starten. |
| `create` meldet `config-unreadable` | `config.json` ist kein gültiges JSON und kann nicht auf Secret-Werte geprüft werden; das Archiv wird nicht geschrieben. Datei korrigieren oder `plur1bus 1staid repair` ausführen und `create` wiederholen. |
| Ziel existiert bereits (`exists`) | Das Ziel wird nicht überschrieben. Einen anderen Pfad mit `--out <FILE>` wählen. |
| Restore meldet `E_LOCKED` / `core-running` | Ein Supervisor oder Core antwortet noch oder der Core-Lock ist belegt. `plur1bus daemon stop` ausführen und sicherstellen, dass kein Prozess für dieses Home mehr läuft. |
| `verify` meldet `archive-corrupt`, `truncated`, `manifest-invalid`, `unsupported-format`, `unexpected-entry`, `checksum-mismatch` oder `missing-entry` | Das Archiv ist beschädigt, unvollständig oder wird nicht unterstützt. Nicht wiederherstellen; eine intakte Kopie verwenden. |
| Snapshot meldet `source-busy` | Der Store änderte sich während der Snapshot-Erstellung. Erneut versuchen, wenn weniger Schreibaktivität stattfindet. |
| Snapshot meldet `insufficient-disk` | Für den Snapshot ist nicht genug Speicherplatz verfügbar. Speicher freigeben und erneut versuchen. |
| Snapshot meldet `store-outside-home` | Der konfigurierte Store liegt außerhalb des Home-Verzeichnisses; dieser Backup-Befehl verweigert ihn, statt den Pfad zu erraten. |

Weitere Angaben zu Verzeichnissen und Dienststeuerung enthält das [Operations-Handbuch](../user/en/operations.md);
die vollständigen Optionen stehen in der [CLI-Referenz](../cli.md).
