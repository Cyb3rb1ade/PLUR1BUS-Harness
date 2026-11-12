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
Secret-Referenzen in `config.json` bleiben unverändert: Namen im Secret-Store, Umgebungs- oder Dateireferenzen und die
vom gepinnten Engine-Vertrag unterstützten strukturierten Referenzen sind keine Secret-Werte. Sie werden beim Restore
bytegleich erhalten; ihr Ziel wird weder gelesen noch mitgesichert. Ein gewöhnlicher String in einem Engine-`apiKey`-Feld
ist dagegen ein Literal; nur die vom gepinnten Resolver ausdrücklich unterstützten `${ENV_NAME}`-Formen sind Referenzen.
Die deklarierte Referenzform und die kanonische Namensrichtlinie entscheiden gemeinsam: Ein eingefügter Schlüssel
(bekannter Token-Präfix, überlanger oder hochentropischer Name) bleibt kein lesbarer Referenzname, sondern wird wie ein
Literal ersetzt. Eindeutige Dateipfade behalten ihre normale Syntax und Länge; ein bloßer schlüsselartiger String im
Datei- oder Exec-Feld bleibt geschützt. Diese Prüfung liest kein Referenzziel.
Anhand der Schema-Metadaten `x-sensitive` ersetzt `create` dort abgelegte Literalwerte durch Platzhalter. Für
konfigurierte, installierte Module gilt zusätzlich deren validiertes `configSchema` aus `module.json`, auch bei
`enabled: false`. Unbekannte String-Werte werden auch ohne installiertes Modul oder ohne Schema ersetzt; öffentliche typisierte Werte bleiben erhalten. Beschädigte oder nicht interpretierbare Metadaten eines installierten, konfigurierten Moduls verweigern das Backup. Bei `x-url-credentials` werden Userinfo sowie alle Query- und Fragment-Werte durch den URI-gültigen Platzhalter `REDACTED` ersetzt; Host, Pfad und Parameternamen bleiben erhalten. Die Live-Datei bleibt unverändert. Das Manifest nennt die ersetzten Konfigurationsschlüssel, niemals
deren Werte, im bestehenden Feld `secrets.note` als versionierte Zeile
`plur1bus.backup.config-redactions/1: ["konfigurations.schlüssel"]`.

`backup restore` meldet diese Schlüssel ausdrücklich als **„Secret neu eintragen“** (in der englischen CLI:
`Re-enter secret`), auch beim Probelauf und mit `--json` auf stderr; die JSON-Ergebnisstruktur bleibt unverändert.
Trage fehlende Literalwerte und URL-Zugangsdaten vor der Nutzung der betroffenen Verbindung erneut ein. Referenzen
benötigen weiterhin ihre Secret-Store-Werte oder sonstigen Ziele auf dem Zielsystem. Für den ersetzten Wert
`channels.telegram.webhook.secret` erzeugt Restore wie bisher einen neuen Zufallswert: Der Telegram-Kanal meldet ihn
beim nächsten Start per `setWebhook` an; der alte Wert wird nicht wiederhergestellt.

Die API-Kontendatenbank `state/api/accounts.db` ist standardmäßig **nicht im Archiv**. Mit
`backup create --include-api-accounts` nimmst du sie ausdrücklich auf, sofern sie vorhanden ist. Sie enthält
Passwort-Hashes (Argon2id), TOTP-Seeds, Backup-Code-Hashes und Hashes persönlicher Tokens. Wer ein solches Archiv
besitzt, kann Hashes offline angreifen und den zweiten Faktor nachbilden. Auch mit Opt-in ist das gewöhnliche Archiv
weder signiert noch verschlüsselt; bewahre es entsprechend geschützt auf. Das
[portable verschlüsselte Backup](../portable-backup.md) wählt die Kontendatenbank für Sicherung und Rückrollen
jeweils ausdrücklich aus.

Der Core kopiert SQLite-Datenbanken weiterhin konsistent in einen privaten Snapshot-Bereich, einschließlich der
Kontendatenbank. Die Auswahl entscheidet erst, welche dieser Kopien ins Archiv gelangen; der Snapshot-Bereich wird
danach entfernt. Ein Restore ohne Konteneinheit lässt die vorhandene Kontendatenbank des Ziels samt
`-wal`-, `-shm`- und `-journal`-Dateien unverändert. Fehlt die Kontendatenbank in der Quelle, gilt das auch bei gewähltem
Opt-in. Lege den Engine-Store getrennt von diesem Kontenpfad ab: `create` verweigert überlappende Pfade,
auch über Symlinks oder Junctions.

Ein externes Obsidian-Vault ist nicht Teil des
Backups. Ist `config.json` kein gültiges JSON oder enthält es wiederholte Objektschlüssel, bricht `create` mit
`config-unreadable` ab, statt die Datei ungeprüft zu archivieren; `plur1bus 1staid repair` stellt sie wieder her.

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

   Wenn API-Konten mitgesichert werden sollen, verwende das Opt-in:

   ```sh
   plur1bus backup create --include-api-accounts --out "/pfad/zum/ziel/backup-mit-konten.tar.gz"
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

Während Entpacken, Austausch und einem möglichen Rollback hält Restore die vorhandenen Writer-Sperren:
`state/core.lock` für Core und Import sowie `run/supervisor.lock` und `run/engine.process.lock` für die Rust-Prozesse.
Dadurch kann auch nach der ersten Prüfung kein solcher Writer dazwischen starten. Eine belegte Sperre führt zu
`E_LOCKED` mit `reason=core-running`; Holder-Zeilen, Engine-Nonces und PID-Dateien bleiben unverändert.
In einem frischen Home entstehen drei leere Lock-Dateien. Sie bleiben nach dem Vorgang bestehen, damit jeder
spätere Prozess dieselbe Datei sperrt. Ein Prozessabbruch gibt die gehaltenen Betriebssystem-Sperren frei.

Der abgeleitete LLM-Ergebnis-Cache unter `store/llm-result-cache-v1` ist kein Bestandteil neuer Archive.
Bei älteren Archiven werden seine Dateien weiterhin auf Größe und Prüfsumme geprüft, aber nicht wiederhergestellt.
Gleichnamige Dateien in Agenten-Workspaces sind davon nicht betroffen. Ein Dry-run oder abgelehnter Restore leert
den aktuellen Cache nicht; nach erfolgreichem Austausch liegt der bisherige Cache nur noch im Pre-Restore-Verzeichnis.

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
   plur1bus backup restore "/pfad/zum/backup.tar.gz" --confirm
   ```

   Ohne `--confirm` zeigt der Befehl nur den Plan und ändert nichts, auch auf einem Terminal. `--yes` bleibt als
   Alias für die ausdrückliche Bestätigung erhalten:

   ```sh
   plur1bus backup restore "/pfad/zum/backup.tar.gz" --yes
   ```

   PowerShell-Beispiel:

   ```powershell
   plur1bus backup restore "D:\Backups\backup.tar.gz" --yes
   ```

   `--force` ersetzt keine Bestätigung. Mit `--confirm --force` werden unter einer ausdrücklichen Warnung lediglich
   die Endpoint-Prüfungen übersprungen; belegte Writer-Sperren führen weiterhin zur Ablehnung. `--dry-run` hat auch
   zusammen mit `--confirm` Vorrang und wendet nichts an.

4. Nach erfolgreichem Restore den Dienst wieder starten und den Zustand kontrollieren:

   ```sh
   plur1bus daemon start
   plur1bus daemon status
   plur1bus 1staid check
   ```

   Falls eine Store-Migration erforderlich ist, beachte die [CLI-Anleitung zu `admin migrate`](../cli.md#plur1bus-admin-migrate):
   der Befehl benötigt die aktuelle und die Ziel-Schema-Version als `--from` und `--to`. Die ersetzten Dateien
   bleiben im genannten `pre-restore`-Verzeichnis.

### Vergessene Erinnerungen nach einem Restore

Die Tombstone-Registry (`<home>/state/_tombstones`, Geschwister des Stores) ist bewusst nicht Teil eines Backups und wird
von `restore` weder ersetzt noch verschoben: Was nach dem Backup vergessen wurde, bleibt dort als committed Tombstone
vermerkt. Die wiederhergestellten Store-Zeilen sind aber der Stand des Backups, eine danach vergessene Erinnerung ist in
ihnen wieder aktiv. Deshalb legt `restore` vor dem Austausch die Marker-Datei `<home>/state/.restore-reapply-tombstones`
an (ein fehlgeschlagener, zurückgerollter Restore entfernt sie wieder). Beim nächsten Start des Cores, vor dem Öffnen des
Sockets und damit vor dem ersten Recall, spielt der Core die committed Tombstones über die Engine neu ein
(`reapplyCommittedTombstones`) und löscht den Marker erst, wenn das vollständig und verifiziert gelungen ist. Das Log nennt
dabei nur Anzahlen, nie Inhalte.

**KNOWN GAP:** Die gepinnte Engine liefert `lib/tombstone-reapply.js` noch nicht (Engine-PR #259). Solange sie fehlt, bleibt
der Marker liegen, der Core startet trotzdem und warnt bei jedem Start, dass nach dem Backup vergessene Erinnerungen
wieder recallbar sein können. Einen harness-seitigen Recall-Filter über die Registry gibt es nicht. Nach dem Anheben des
Engine-Pins erledigt der nächste Start das Einspielen von selbst; der Test `KNOWN GAP: the pinned engine does not ship
lib/tombstone-reapply.js yet` (`packages/core/test/restore-reapply.test.ts`) wird dann rot und erinnert daran, diesen
Absatz und den Test zu entfernen. Bis dahin lässt sich das Einspielen bei gestopptem Core von Hand ausführen:
`node scripts/reapply-tombstones.mjs --apply --base-db-path <home>/state/lancedb` aus dem Engine-Paket
(`@cyb3rb1ade/plur1bus-memory`); endet es ohne Fehler, kann der Marker gelöscht werden.

### Pre-Restore-Kopien begrenzen (`--keep N`)

Ohne Zusatz bleibt jede Pre-Restore-Kopie `<home>/backups/pre-restore-<UTC>-<8 Hex>/` dauerhaft liegen. Mit
`plur1bus backup restore <FILE> --confirm --keep N` (N ≥ 1, sonst Aufruffehler vor jeder Änderung) bleiben nach einem
vollständig gelungenen Austausch nur die N neuesten Kopien; die eben erzeugte zählt mit und wird nie entfernt.
Sortiert wird nach dem Zeitstempel im Namen, dann nach dem Namen. Kandidaten sind ausschließlich echte Verzeichnisse
direkt unter `backups/` mit genau diesem Namensmuster; Symlinks, Dateien, Archive (`plur1bus-backup-*.tar.gz`) und alle
anderen Namen werden nie angefasst. Ist `<home>/backups` selbst ein Symlink (zum Beispiel auf eine andere Platte, die
sich mehrere Homes teilen), löscht `--keep` dort nichts und warnt auf stderr. Ersetzt ein Restore nichts (leeres Home),
entsteht keine eigene Kopie; dann bleiben die N neuesten vorhandenen.

* Nichts wird gelöscht bei `--dry-run`, nach einem Fehler oder Rollback und **solange ein früherer Restore noch nicht
  durch den Core-Start abgeschlossen ist**: Existierte `state/.restore-reapply-tombstones` schon vor diesem Restore, bleiben
  alle älteren Kopien liegen und auf stderr steht eine Warnung.
* Ein Fehler beim Löschen ist eine Warnung auf stderr. Exit-Code und Erfolg des Restores bleiben.
* Die JSON-Ausgabe `backup.restore/1` ist mit und ohne `--keep` identisch; Meldungen erscheinen nur auf stderr.

### Abgebrochener Restore (ohne Journal)

Die Rust-CLI führt **kein Restore-Journal**. Wird der Restore-Prozess hart beendet (SIGKILL; getestet), gilt unten
Folgendes. Für einen Stromausfall oder Absturz des Rechners ist das **nicht getestet und nicht zugesagt**: Dateiinhalte
werden synchronisiert, Verzeichnis-Renames und das Anlegen des Markers aber nicht per `fsync` auf das Verzeichnis;
Reihenfolge und Dauerhaftigkeit hängen vom Dateisystem ab.

* **Kein Datenverlust:** Jede Einheit liegt vollständig am Live-Ort (alt oder neu) oder vollständig unter
  `backups/pre-restore-<id>/<Ziel>`; noch nicht platzierte Einheiten liegen vollständig im Staging `<home>/.restore-<id>`.
* **Marker:** `state/.restore-reapply-tombstones` wird nach dem Entpacken und vor dem ersten Austausch angelegt. Ein Kill
  beim Entpacken lässt keinen Marker zurück (und noch nichts Ersetztes); jeder spätere Schnitt hinterlässt ihn.
* **Sperren:** Betriebssystem-Sperren gehen mit dem Prozess unter; ein neuer Lauf wird nicht blockiert.
* **Konvergenz:** Dasselbe `backup restore --confirm` mit demselben Archiv wiederholen. Es endet im selben Dateizustand
  wie ein ungestörter Lauf; der Marker bleibt bestehen. Ein `--keep` im Wiederholungslauf löscht dann nichts (der Marker
  existierte schon) und warnt.

**KNOWN GAP:** Ein unterbrochener Restore wird beim nächsten Start nicht erkannt und nicht automatisch zurückgeführt;
das Staging `.restore-<id>` des getöteten Laufs bleibt liegen. Abhilfe ist die Wiederholung des Restores (danach kann das
alte Staging von Hand entfernt werden). Die Tests `crash::a_sigkill_at_every_cut_…` in `crates/plur1bus/tests/backup.rs`
schreiben das für zwölf Schnitte fest.

### Abdeckung der zehn gp5-Restore-Fälle

Quelle: Analysefälle `gp5-restore-gates` (Commit `e396469baa`). Die Fälle beschreiben teils das Node-CLI; die Rust-CLI
hat ein anderes Modell (kein Journal, `--force` umgeht nur Endpoint-Prüfungen, nie die Kernel-Writer-Sperren).
Test-Pfade beziehen sich auf `crates/plur1bus/`.

| # | Fall (Kurzfassung) | Abdeckung | Status |
|---|---|---|---|
| 1 | aktiver Writer verweigert Restore vor jeder Datei-/Staging-Änderung | `tests/backup.rs`: `restore_refuses_while_a_supervisor_answers_for_the_home`, `refused_admission_leaves_no_staging_no_pre_restore_and_the_current_cache` (kein `.restore-*`, kein `pre-restore-*`, kein Byte geändert); `src/backup/writer_guard_tests.rs` | abgedeckt |
| 2 | Writer-Start zwischen Prüfung und Austausch umgeht die Sperre nicht | `writer_guard_tests.rs`: `held_restore_fence_excludes_later_core_supervisor_and_engine_start` | abgedeckt |
| 3 | Standard ist ein Dry-run; Änderung nur mit ausdrücklicher Bestätigung | `tests/backup.rs`: `restore_defaults_to_a_read_only_plan_and_force_never_confirms_it`, `a_dry_run_reports_the_plan_and_changes_nothing` | abgedeckt (Rust-CLI) |
| 4 | `--force` warnt und ersetzt nie die Bestätigung | `tests/backup.rs`: `restore_refuses_while_a_supervisor_answers_for_the_home` (Warnung), `restore_defaults_to_a_read_only_plan_and_force_never_confirms_it` | abgedeckt |
| 5 | neue Snapshots enthalten keine LLM-Cache-Datenbank samt WAL/SHM | Archiv-Seite: `src/backup/manifest.rs` `is_derived_cache`, `derived_cache_tests.rs`; Engine-Create: T7a | verwiesen (Engine-Fassade, T7a) |
| 6 | Legacy-Snapshot mit Cache ist verifizierbar, stellt aber einen leeren Cache her | `derived_cache_tests.rs`: `legacy_archive_is_verified_but_restored_store_has_no_derived_cache`, `discarded_legacy_cache_payload_still_must_pass_its_digest` | abgedeckt |
| 7 | verweigerte/fehlgeschlagene Admission leert den Cache nicht und ändert keine Lease-Metadaten | `derived_cache_tests.rs`: `dry_run_and_failed_restore_preserve_current_cache`; `tests/backup.rs`: `refused_admission_leaves_no_staging_no_pre_restore_and_the_current_cache` (Cache und Lock-Bytes unverändert); `writer_guard_tests.rs` | abgedeckt |
| 8 | jeder Crash-Schnitt erhält Journal-Recovery und Tombstone-Reapply | `tests/backup.rs`: `crash::a_sigkill_at_every_cut_loses_no_data_keeps_the_marker_and_a_repeat_converges` (extract, marker, swap:0–3, swap-after:0–3, absent:0, done). **Ohne Journal:** kein Datenverlust, Marker, Konvergenz bei Wiederholung | abgedeckt in der Form ohne Journal (siehe KNOWN GAP) |
| 9 | Workspace-Quellen und Opt-in-Retention kompatibel; ausstehendes Journal verhindert Purge | Retention: `tests/backup.rs` `keep_*`, `a_marker_from_an_unfinished_restore_blocks_the_purge_and_warns`, `src/backup/retention.rs`; „pending" entspricht hier dem vorhandenen Marker. Workspace-Quellen: Engine-Fassade (T7a) | Retention abgedeckt, Workspace-Quellen verwiesen (T7a) |
| 10 | erfolgreicher Restore startet einen frischen Cache, ohne alte Ausgaben oder weitere Rechte | `derived_cache_tests.rs`, `tests/backup.rs` `restored_files_and_directories_are_private`; „frischer Cache beim Start" liegt außerhalb der CLI | teilweise, Rest verwiesen (Core/Engine) |

## Audit-Beweise gesondert aufbewahren

Das Installationsbackup schließt den gesamten Bereich `<home>/logs/` aus. Es ist daher keine Sicherung von `audit.log`, Audit-Kette, Anker, Pending-Journal oder beiseitegelegten alten Ären und Schreibfragmenten. `backup verify` bestätigt das Archiv gegen sein Manifest; es ersetzt weder `audit verify` noch einen getrennt vom Host aufbewahrten Hash-Pin.

Wenn du Audit-Beweise brauchst, bewahre eine geschützte, konsistente Kopie dieses Bereichs und die zugehörigen Prüfberichte separat auf. Koordiniere dabei laufende Writer, damit Kette und Anker zur selben Aufnahme gehören. Lösche keine `.torn-*`- oder `.pre-reanchor-*`-Dateien, um einen Restore oder eine Prüfung erfolgreich erscheinen zu lassen.

Nach einer Wiederherstellung sind Dienstbereitschaft, Archivprüfung und Audit-Integrität getrennt zu beurteilen. Ein früherer erfolgreicher Prüfzeitpunkt oder ein späteres `state: "ok"` ist kein Nachweis einer unveränderten Historie. Bei Verweigerungen folge dem [Audit-Betriebsablauf](audit-recovery.md); ein Reanchor macht eine neue Ära sichtbar und repariert nicht die Beweislage der alten.

## Typische Fehler

| Meldung oder Grund | Bedeutung und nächster Schritt |
|---|---|
| `create` erreicht den Core nicht (`E_CORE_UNAVAILABLE`) | `create` benötigt den laufenden Core. `plur1bus daemon status` prüfen und den Supervisor bei Bedarf mit `plur1bus daemon start` starten. |
| `create` meldet `config-unreadable` | `config.json` ist kein gültiges JSON mit eindeutigen Objektschlüsseln und kann nicht auf Secret-Werte geprüft werden; das Archiv wird nicht geschrieben. Datei korrigieren oder `plur1bus 1staid repair` ausführen und `create` wiederholen. |
| `create` meldet `config-policy-invalid` | Die eingebetteten oder installierten Modul-Metadaten für die Offenlegung sind ungültig, nicht verfügbar oder nicht unterstützt. Das betroffene `module.json` reparieren beziehungsweise eine intakte Version installieren und `create` wiederholen. |
| Ziel existiert bereits (`exists`) | Das Ziel wird nicht überschrieben. Einen anderen Pfad mit `--out <FILE>` wählen. |
| Restore meldet `E_LOCKED` / `core-running` | Ein Supervisor oder Core antwortet noch oder der Core-Lock ist belegt. `plur1bus daemon stop` ausführen und sicherstellen, dass kein Prozess für dieses Home mehr läuft. |
| `verify` meldet `archive-corrupt`, `truncated`, `manifest-invalid`, `unsupported-format`, `unexpected-entry`, `checksum-mismatch` oder `missing-entry` | Das Archiv ist beschädigt, unvollständig oder wird nicht unterstützt. Nicht wiederherstellen; eine intakte Kopie verwenden. |
| Snapshot meldet `source-busy` | Der Store änderte sich während der Snapshot-Erstellung. Erneut versuchen, wenn weniger Schreibaktivität stattfindet. |
| Snapshot meldet `insufficient-disk` | Für den Snapshot ist nicht genug Speicherplatz verfügbar. Speicher freigeben und erneut versuchen. |
| Der Core warnt beim Start vor einem Restore, der noch Tombstones einzuspielen hat | Der Marker `state/.restore-reapply-tombstones` liegt noch, weil die Engine das Einspielen nicht (vollständig) ausführen konnte. Die Warnung nennt den Grund. Siehe „Vergessene Erinnerungen nach einem Restore“. |
| Snapshot meldet `store-outside-home` | Der konfigurierte Store liegt außerhalb des Home-Verzeichnisses; dieser Backup-Befehl verweigert ihn, statt den Pfad zu erraten. |

Weitere Angaben zu Verzeichnissen und Dienststeuerung enthält das [Operations-Handbuch](../user/en/operations.md);
die vollständigen Optionen stehen in der [CLI-Referenz](../cli.md).
