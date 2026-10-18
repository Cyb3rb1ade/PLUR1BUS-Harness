# Import rückgängig machen (Import-Rollback)

Jeder Importlauf, den du mit `--apply` anwendest, legt einen Bericht und einen Snapshot des Zustands davor an. Der Rollback nutzt beides, um Plur1bus in diesen Zustand zurückzuversetzen. Die englische Version dieser Seite ist [../en/import-rollback.md](../en/import-rollback.md).

> **Verfügbarkeit:** Das Zurückrollen dessen, was der Import in deine Installation geschrieben hat (Skills, Dateien, Konfiguration), funktioniert heute. Das Rückgängigmachen der importierten **Erinnerungskarten** ist ab Engine 1.15 verfügbar. Bis dahin meldet ein Rollback sie als `not-reverted (engine has no undo)` und lässt den Gedächtnis-Store unverändert.

## So geht's

Dafür gibt es keine Web-UI. Nutze die CLI.

1. Quelle und das, was ein Import fände, ansehen. Das ändert nichts:

```sh
plur1bus import hermes --detect
```

2. Rollback eines Laufs in der Vorschau ansehen. Übergib die `report.json` des Laufs; sie liegt im Ordner `imports` deines Plur1bus-Verzeichnisses unter der Lauf-ID. Ohne `--apply` wird nichts geschrieben.

```sh
plur1bus import hermes --rollback <REPORT>
```

3. Rollback anwenden. Stoppe vorher den Core; ein Rollback läuft nicht, solange der Core läuft.

```sh
plur1bus import hermes --rollback <REPORT> --apply
```

Dasselbe gilt für `openclaw` statt `hermes`.

## Gut zu wissen

- **Erst die Vorschau:** Der Rollback ist ein Probelauf, solange du nicht `--apply` angibst. Der Bericht listet, was entfernt, wiederhergestellt oder behalten würde.
- **Deine Änderungen bleiben:** Eine Datei, die der Import angelegt und die du danach geändert hast, wird nicht gelöscht. Sie wird gesichert, bleibt liegen und als `kept-modified` gemeldet. Die Option `--force` löscht solche Dateien nach der Sicherung.
- **Erinnerungskarten:** Siehe den Verfügbarkeitshinweis oben. Ein Rollback löscht oder ändert heute keine Erinnerungskarten.
- **Im Zweifel Abbruch:** Ein beschädigtes oder fehlendes Ledger oder ein Snapshot, der nicht zum Bericht passt, stoppt den Rollback, statt Erfolg zu melden und importierte Dateien liegen zu lassen.
- **Die Quelle bleibt unverändert:** Dein Hermes- oder OpenClaw-Verzeichnis wird beim Import und beim Rollback nur gelesen.
- **Nur einmal:** Ein Lauf, der schon zurückgerollt wurde, wird abgelehnt. Du kannst jederzeit mit anderen Optionen erneut importieren.

## Fehlermeldungen

Der Importer meldet eigene Fehlercodes; der `reason` sagt, was nicht stimmt.

- `E_ROLLBACK_INVALID` mit reason `report-unreadable`, `report-missing` oder `report-outside-home`: Die Berichtsdatei ist nicht lesbar, existiert nicht oder ist nicht die `report.json` ihres Lauf-Ordners. Gib die Datei aus dem Ordner des Laufs an.
- `E_ROLLBACK_INVALID` mit reason `not-an-apply-report`: Der Lauf war nur eine Vorschau, es gibt nichts rückgängig zu machen. `already-rolled-back`: Der Lauf wurde schon zurückgerollt. `source-mismatch`: Der Bericht gehört zur anderen Quelle (`hermes` oder `openclaw`).
- `E_ROLLBACK_INVALID` mit reason `snapshot-missing`, `snapshot-corrupt`, `snapshot-invalid`, `ledger-corrupt` oder `unsafe-symlink`: Dem gesicherten Zustand ist nicht zu trauen, deshalb wird nichts wiederhergestellt.
- `E_ROLLBACK_STALE` mit reason `skills-changed-since`: Deine Skills haben sich nach diesem Lauf geändert. Rolle zuerst die späteren Läufe zurück.
- Reason `target-running` (eigener Fehler des Importers): Der Core läuft. Stoppe ihn mit `plur1bus daemon stop` und versuche es erneut.

## Weiter

- Betrieb und Wartung: [Betriebshandbuch](operations.md)
- Desktop-Pakete und Migration: [Desktop](desktop.md)
- Schnellstart: [Schnellstart](quickstart.md)
