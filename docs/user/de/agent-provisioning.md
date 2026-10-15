# Agenten erstellen und Modelllizenzen

Der Agenten-Wizard sendet pro Versuch einen Erstellungsschlüssel. Nach einem Verbindungsfehler kann derselbe Versuch wiederholt werden: Der Server liefert denselben Agenten. Eine unvollständige Erstellung wird beim Neustart rückgängig gemacht; eine nicht verfügbare Wiederherstellung wird gemeldet, bevor Agenten laufen können.

Der Memory-Wizard speichert die Lizenzbestätigung mit deinem Konto, Serverzeit, Modell, Lizenz und gepinnter Revision. Ein anderes NC-Modell oder eine andere Revision benötigt eine passende Bestätigung. Die Administration kann die Einträge über `model.licence.list` abfragen. Nicht-interaktive Installation verwendet multilingual E5-small.

Agenten → Agentenisolation zeigt agentenbezogene und prozessglobale Bereiche. Agentenbezogener Laufzeitzugriff wird ohne passenden Kontext verweigert. Derselbe Betriebssystemnutzer bleibt die akzeptierte Vertrauensgrenze.

Vor dem Löschen den Agenten archivieren und exportieren. Echtes Löschen bleibt mit „Erasure-API fehlt“ gesperrt, bis die Engine dies unterstützt.

Der Memory-Schritt bleibt offen, wenn das gewählte Modell nicht unterstützt wird oder die sichere Migration fehlt. Wähle das aktive multilingual E5-small ausdrücklich oder aktualisiere die Engine und schließe die Embedding-Migration ab; Setup behält niemals still ein anderes Modell.
