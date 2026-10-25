# Agenten erstellen und Modelllizenzen

Der Agenten-Wizard sendet pro Versuch einen Erstellungsschlüssel. Nach einem Verbindungsfehler kann derselbe Versuch wiederholt werden: Der Server liefert denselben Agenten. Eine unvollständige Erstellung wird beim Neustart rückgängig gemacht; eine nicht verfügbare Wiederherstellung wird gemeldet, bevor Agenten laufen können. Die englische Version dieser Seite ist [../en/agent-provisioning.md](../en/agent-provisioning.md).

Der Memory-Wizard speichert die Lizenzbestätigung mit deinem Konto, Serverzeit, Modell, Lizenz und gepinnter Revision. Ein anderes NC-Modell oder eine andere Revision benötigt eine passende Bestätigung. Die Administration kann die Einträge über `model.licence.list` abfragen. Ein bestätigtes nicht-kommerzielles Modell wird nur geladen, solange die Nutzungsart nicht kommerziell ist. Nicht-interaktive Installation verwendet multilingual E5-small, wenn noch keine Embedding-Auswahl besteht. Ein erneuter Setup-Lauf erhält eine bestehende Embedding-Konfiguration; ein Modell- oder Dimensionswechsel benötigt den Migrationspfad.

Agenten → Agentenisolation zeigt agentenbezogene und prozessglobale Bereiche. Agentenbezogener Laufzeitzugriff wird ohne passenden Kontext verweigert. Derselbe Betriebssystemnutzer bleibt die akzeptierte Vertrauensgrenze.

Vor dem Löschen den Agenten archivieren und exportieren. Echtes Löschen bleibt mit „Erasure-API fehlt“ gesperrt, bis die Engine dies unterstützt.

Der Memory-Schritt kommt vor dem Anlegen des ersten Agenten, weil das Anlegen eines Agenten seine Gedächtnistabelle im aktiven Embedding-Modell anlegt. Solange das Gedächtnis keine Daten enthält, schreibt der Schritt das gewählte Embedding-Modell und den Reranker nach `engine.embedding` und `engine.reranker`, und die Gedächtnis-Engine nutzt sie ab ihrem Neustart ([erinnerungen.md](erinnerungen.md#embedding-modell-und-reranker)). Sobald Daten da sind, behält der Schritt das Embedding-Modell in Verwendung und ändert nur den Reranker; ein anderes Embedding-Modell braucht dann den Migrationspfad ([reembed.md](reembed.md)). Der Schritt meldet nie ein Modell als gewählt, das die Engine nicht nutzt.
