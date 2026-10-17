# Desktop-Pakete und Migration

Direkte Installer gibt es online und offline. Offline-Releasepakete enthalten das Harness-Image für die jeweilige Architektur und die Standardmodelle; CI-Platzhalter können weder den Harness noch Offline-Inferenz ausführen. Store und Flatpak sind ausschließlich online. Vor einer Runtime-Installation fragt die App nach und zeigt den Lizenzhinweis.

Dem echten Harness-Image fehlen derzeit noch mehrere Desktop-Verträge für Pairing, Sitzungen und kalte Snapshots. Ein laufender Daemon beweist keinen funktionierenden Desktop-Login oder eine sichere Store-Migration. Ersetze Daten einer nativen oder Stub-Installation nicht von Hand. Bewahre die ursprüngliche Installation und ein geprüftes M8-Backup auf. Produktiver Import und Rollback mit dem echten Image bleiben bis zum vollständigen Gate und den Abbruchtests nicht verfügbar.

Native Backups verwenden `plur1bus backup create`, `plur1bus backup verify <Archiv>` und bei gestopptem Core `plur1bus backup restore <Archiv> --dry-run`. Beim Erstellen muss der Quell-Core laufen. Archive enthalten Daten, jedoch keine Zugangsdaten aus dem Secret Store oder Modellgewichte. Kopiere keine laufenden Datenbanken und gehe nicht davon aus, dass ein natives Update-Snapshot die Erinnerungen enthält. Prüfe CLI-Hilfe und Wiederherstellungsplan vor einem späteren Restore; die ursprüngliche Installation bleibt erhalten.

„Nur App“ lässt die Daten bestehen. „Alles“ erfordert die Eingabe `plur1bus-state`. Store-Autostart verwaltet Windows unter Einstellungen → Apps → Autostart; Flatpak kann weder die Host-CLI installieren noch den PATH der Host-Shell ändern.
