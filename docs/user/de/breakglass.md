# Break-Glass-Zugriff

Break-Glass (`#/breakglass`) ist der Notfallzugriff auf private Daten einer anderen Person: ihre Karten und Gesprächsverläufe. Er ist für Fälle gedacht, in denen der normale Weg nicht reicht. Jede Anforderung wird revisionssicher protokolliert, ist zeitlich begrenzt und lässt sich nicht rückgängig machen. Die betroffene Person wird sofort benachrichtigt. Die englische Version dieser Seite ist [../en/breakglass.md](../en/breakglass.md).

## Wer das nutzen kann

Nur Owner und Admin sehen die Seite. Alle anderen sehen einen Hinweis, dass die Berechtigung fehlt.

## Zugriff anfordern

1. Wähle **Break-Glass anfordern**.
2. Trage die **Zielperson** ein, also die Benutzer-ID (zum Beispiel `usr_admin`).
3. Schreibe eine **Begründung** mit 10 bis 500 Zeichen. Sie steht in der Benachrichtigung an die betroffene Person und im Protokoll.
4. Wähle das **Zeitfenster** in Minuten.
5. Setze das Bestätigungshäkchen. Ohne es wird die Anforderung nicht gesendet.
6. Wähle **Zugriff anfordern**.

Das Fenster gibt für die gewählte Zeit lesenden Zugriff auf die privaten Karten und Gesprächsverläufe der Zielperson.

## Während ein Fenster aktiv ist

- Ein Banner oben zeigt die Zielperson, die verbleibende Zeit und die Schaltfläche **Jetzt widerrufen**.
- **Jetzt widerrufen** fragt nach. Mit **Fenster widerrufen** endet der Zugriff sofort, mit **Aktiv lassen** bricht du ab.

## Die drei Reiter

- **Aktive Fenster:** Fenster, die gerade laufen.
- **Vergangene Fenster:** abgelaufene und widerrufene Fenster, mit Begründung.
- **Erhaltene Hinweise:** was die betroffene Person sieht, wenn du die Zielperson bist. Diese Hinweise erscheinen auch im [Posteingang](posteingang.md).

## Gut zu wissen

- Der Zugriff wird protokolliert. Rechne damit, dass die betroffene Person die Begründung sieht.
- Das Fenster steht fest, sobald du es anforderst. Brauchst du danach noch Zugriff, fordere ein neues an.

## Weiter

- Protokoll und Logs: [Betriebshandbuch](operations.md)
