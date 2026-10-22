# Secrets verwalten

Plur1bus bewahrt API-Schlüssel und Tokens in einem Secret Store auf, getrennt von der Konfiguration. Ein Wert lässt sich schreiben und ersetzen, wird aber nie wieder angezeigt. Den Secret Store darf nur der Owner nutzen. Die englische Version dieser Seite ist [../en/secrets.md](../en/secrets.md).

## So geht's

### Web-UI

1. Öffne **Einstellungen → Geheimnisse** (`#/settings/secrets`). Die Seite zeigt nur Namen und Metadaten.
2. **Secret anlegen:** Wähle **Geheimnis hinzufügen**, gib den Namen ein (zum Beispiel `openai/api-key`) und füge den Wert in das maskierte Feld ein. Der Wert wird beim Speichern sofort geleert. Ab der nächsten Version gibt es zusätzlich eine optionale einzeilige Beschreibung, wofür das Secret dient.
3. **Secret rotieren:** Wähle **Rotieren**, gib den neuen Wert ein und bestätige mit **Jetzt rotieren**. Der alte Wert funktioniert sofort nicht mehr, seine Leases werden widerrufen.
4. **Secret löschen:** Wähle **Löschen** und bestätige. Das Secret wird aus allen Backends entfernt und seine Leases werden widerrufen; alles, was es nutzt, funktioniert dann nicht mehr.

### CLI

Prüfen, welches Backend deine Secrets hält (Schlüsselbund des Betriebssystems oder verschlüsselte Datei):

```sh
plur1bus secret status
```

Alle Secret-Namen auflisten (gibt niemals Werte aus):

```sh
plur1bus secret ls
```

Secret anlegen oder rotieren, indem der Wert über die Standardeingabe übergeben wird:

```sh
printf %s "$API_KEY" | plur1bus secret set <NAME>
```

Metadaten anzeigen (Backend, Zeitstempel und ab der nächsten Version die Beschreibung):

```sh
plur1bus secret get <NAME>
```

Secret aus allen Backends entfernen (`--yes` ist außerhalb eines Terminals Pflicht):

```sh
plur1bus secret rm <NAME>
```

Ab der nächsten Version nimmt `secret set` auch `--description` mit einem einzeiligen Text von höchstens 200 Zeichen. Ohne diese Option behält eine Rotation die gespeicherte Beschreibung; ein leerer Text entfernt sie.

## Gut zu wissen

- **Nie als Argument:** Ein Secret-Wert wird nie als Befehlszeilenargument akzeptiert. Tippst du einen ein, lehnt der Befehl ihn ab, ohne ihn zu wiederholen; behandle das Getippte als offengelegt (Shell-Verlauf, Prozessliste) und rotiere es. Übergib den Wert über die Standardeingabe oder nutze die Web-UI. Der Wert darf bis zu 65536 Bytes lang sein, ein abschließender Zeilenumbruch wird entfernt.
- **Namen:** Buchstaben, Ziffern und `. _ : / @ -`, beginnend mit Buchstabe oder Ziffer, höchstens 128 Zeichen.
- **Was Agenten sehen (`secret_names`):** Das Werkzeug `secret_names` listet Namen, Geltungsbereich und Vorhandensein der Secrets, auf die die eigene Konfiguration des Agenten verweist, etwa ein Kanal, den er bedient, oder der Anbieter seines Modellprofils. Es zeigt nie einen Wert, eine Länge oder ein Präfix, und ein Agent kann nicht nach einem anderen Agenten fragen. Ab der nächsten Version zeigt es auch die Beschreibung.
- **Kurze Werte:** Ein Wert mit weniger als 8 Zeichen wird wie jeder andere gespeichert, aber der Log-Redaktor maskiert so kurze Werte nicht, er könnte also in einer Logzeile auftauchen. Die CLI gibt dann einen Hinweis aus und die Web-UI zeigt eine Meldung; das JSON-Ergebnis enthält eine `warning` mit dem Code `short-value-unmasked`. Nimm einen längeren Wert, wo der Dienst es erlaubt.
- **In Ausgaben maskiert:** Secret-Werte, die der Core kennt, werden in seinen Log-Ausgaben sowie in daraus gebildetem Audit-Protokoll und Berichten maskiert; ein ausgemusterter Wert bleibt nach Rotation oder Löschen maskiert. Das Diagnose-Bundle (`plur1bus 1staid bundle`) enthält nie Secrets.
- **Backends:** Zuerst kommt der Schlüsselbund des Betriebssystems (macOS Keychain, Linux Secret Service, Windows Credential Manager). Ist keiner nutzbar, wird eine verschlüsselte Datei verwendet, aber nur wenn `secrets.fileFallback.enabled` eingeschaltet ist. Ohne Backend ist die Secret-Ablage nicht verfügbar.
- **Wert anzeigen:** `plur1bus secret get <NAME> --reveal` gibt den Wert aus. Es ist der einzige Befehl dafür, nur der Owner darf ihn ausführen, und jeder Aufruf wird protokolliert.

## Fehlermeldungen

- `E_NOT_FOUND` (reason `not-found`): Kein Secret hat diesen Namen. Prüfe die Namen mit `plur1bus secret ls`.
- `E_INVALID_PARAMS` mit reason `value-in-argument`: Ein Wert wurde als Argument getippt. Übergib ihn stattdessen über die Standardeingabe. Der reason `value-from-stdin` heißt, dass die Standardeingabe ein Terminal ist; `stdin-unreadable`, dass sie nicht gelesen werden konnte. Die reasons `invalid-name` und `invalid-value` heißen, dass Name oder Wert fehlerhaft sind (leerer Wert, Wert mit NUL-Zeichen oder über der Größengrenze); ein kurzer Wert ist kein Fehler. Ab der nächsten Version heißt `invalid-description`, dass die Beschreibung zu lang ist, mehr als eine Zeile hat oder den Secret-Wert enthält.
- `E_DENIED` (reason `denied`): Secret-Operationen sind dem Owner vorbehalten.
- `E_NOT_AVAILABLE` mit reason `no-backend` oder `backend-unavailable`: Kein Schlüsselbund ist nutzbar und der Datei-Fallback ist aus, oder das Backend ist nicht erreichbar. Schalte `secrets.fileFallback.enabled` ein oder repariere den Schlüsselbund.
- `E_CANCELLED` (reason `declined`): Du hast die Rückfrage von `secret rm` mit Nein beantwortet; es wurde nichts geändert.

## Weiter

- Secrets für Anbieter nutzen: [providers.md](providers.md)
- Cloud-Embeddings und die Umgebungsvariable für ihren Schlüssel: [cloud-embeddings.md](cloud-embeddings.md)
- Betrieb und Diagnose-Bundles: [Betriebshandbuch](operations.md)
