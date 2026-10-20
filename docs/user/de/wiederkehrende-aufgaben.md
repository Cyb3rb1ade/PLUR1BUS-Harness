# Wiederkehrende Aufgaben

Wiederkehrende Aufgaben führen geplante Vorgänge im Hintergrund aus, etwa regelmäßige Wartung, Synchronisierung und automatisierte Abläufe. Diese Seite beschreibt, wie geplante Jobs eingesehen, überwacht und ausgeführt werden. Die englische Version dieser Seite ist [../en/recurring-tasks.md](../en/recurring-tasks.md).

In der Weboberfläche findest du geplante Jobs und ihre Ausführungsprotokolle unter **Wiederkehrende Aufgaben** (`#/recurring`).

## Geplante Aufgaben ansehen

Die Weboberfläche listet alle geplanten Jobs auf, die der Jobs-Dienst liefert (`jobs.list`). Jeder Eintrag zeigt:

- **Name und Kennung:** die Bezeichnung der Aufgabe und ihren Zweck.
- **Zeitplan:** den Cron-Ausdruck oder das Intervall.
- **Laufzeitpunkte:** den letzten Lauf und den geplanten nächsten Lauf.
- **Status:** den aktuellen Betriebszustand (aktiv, pausiert oder deaktiviert).

Wählst du eine Aufgabe aus, erscheint ihr Ausführungsverlauf (`jobs.history`) mit Laufzeiten, Exit-Codes und Statusprotokollen.

## Eine Aufgabe sofort ausführen

Bei System- und Agent-Hintergrundjobs kannst du den vorhandenen manuellen Auslöser nutzen, ohne auf den nächsten geplanten Zeitpunkt zu warten. Das Panel für eigene Aufgaben bietet derzeit Anlegen, Bearbeiten, Löschen und den Verlauf; der manuelle Lauf dafür läuft über einen eigenen RPC.
Ein Klick auf **Jetzt ausführen** fragt vor dem Start des Jobs (`jobs.run`) um Bestätigung.

## Eine Aufgabe anlegen und bearbeiten

Mit **Wiederkehrende Aufgabe anlegen** wählst du einen Agenten, den du verwalten darfst, gibst einen Prompt, einen Cron-Ausdruck mit fünf Feldern und eine IANA-Zeitzone ein. Der Dialog zeigt die nächsten drei Termine. Ein Zeitplan, der nie auslöst, etwa `0 0 30 2 *` (30. Februar), wird abgelehnt. Die Zeiten gelten in der Zeitzone der Aufgabe: Eine Uhrzeit, die am Tag der Umstellung auf Sommerzeit nicht existiert (zum Beispiel 02:30 in Berlin am letzten Sonntag im März), entfällt an diesem Tag; eine Uhrzeit, die bei der Rückstellung zweimal vorkommt, läuft einmal, beim ersten Mal. Du kannst die Aufgabe aktivieren oder deaktivieren und nach Bestätigung löschen. System- und Engine-Jobs bleiben unveränderlich.

Die Aufgabe läuft unter der Identität ihres Erstellers; die aktuellen Rechte werden vor jedem Lauf geprüft. Bearbeitest du die Aufgabe einer anderen Person, läuft sie künftig unter deiner Identität; vor dem Speichern erscheint ein Hinweis. Der Aufgabenverlauf zeigt den Anzeigenamen der ausführenden Person. Bei Rechteverlust oder einer inaktiven Person wird die Aufgabe deaktiviert und ein Inbox-Hinweis erzeugt. Ein hartes Budget überspringt den Lauf. Werkzeugfreigaben und OS-Bestätigungen folgen dem normalen Freigabeablauf; die Aufgabe bestätigt sie nie automatisch.

Technische Details zu RPC, CLI und Scheduler stehen im [Backend-Leitfaden für wiederkehrende Aufgaben](../../recurring.md). Die Web-Anschlüsse sind gegen den typisierten Mock geprüft; der authentifizierte RPC-/Event-Transport folgt in einem eigenen Paket.
