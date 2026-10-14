# Wiederkehrende Aufgaben

Unter **Wiederkehrende Aufgaben** kannst du eine eigene Aufgabe anlegen, bearbeiten und nach Bestätigung löschen. Wähle einen Agenten, den du verwalten darfst, einen Prompt, einen Cron-Ausdruck mit fünf Feldern und eine IANA-Zeitzone. Der Dialog zeigt die nächsten drei Termine. System- und Engine-Jobs bleiben unveränderlich.

Die Aufgabe läuft unter der Identität ihres Erstellers. Vor jedem Lauf gelten dessen aktuelle Rolle, Agentenrechte und Budgets. Bearbeitest du die Aufgabe einer anderen Person, läuft sie künftig unter deinem Namen; vor dem Speichern erscheint ein Hinweis. Der Aufgabenverlauf zeigt den Anzeigenamen der ausführenden Person.

Bei Rechteverlust oder einer inaktiven Person wird die Aufgabe deaktiviert und ein Inbox-Hinweis erzeugt. Ein hartes Budget überspringt den Lauf. Werkzeugfreigaben und OS-Bestätigungen benötigen die normale Entscheidung der Person. Die Aufgabe bestätigt sie nicht automatisch.

Technische Details stehen im [Backend-Leitfaden für wiederkehrende Aufgaben](../../recurring.md). Die Web-Anschlüsse sind gegen den typisierten Mock geprüft; der authentifizierte RPC-/Event-Transport folgt in einem eigenen Paket.
