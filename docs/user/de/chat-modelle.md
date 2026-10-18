# Chat-Modelle und Denkstufe

Jeder Chat kann sein eigenes Modellprofil nutzen, auch ein Chat, der nicht gemerkt wird. Ab der nächsten Version stellst du pro Chat auch die Denkstufe ein (wie viel das Modell nachdenkt, bevor es antwortet). Die englische Version dieser Seite ist [../en/chat-models.md](../en/chat-models.md).

## So geht's

### Web-UI

1. Öffne den **Chat** (`#/chat`) und ein Gespräch.
2. **Modell wechseln:** Tippe in der Kopfzeile des Chats den Namen eines konfigurierten Modellprofils bei **Modellprofil** ein und wähle **Modellwechsel vorbereiten**. Lies die Warnung: Der Prompt-Cache wird neu aufgebaut, Cache-Schreibkosten und andere Modellkosten können entstehen. Mit **Modellwechsel bestätigen** wird er übernommen; das neue Profil gilt ab der nächsten Antwort.
3. **Modell und Denkstufe, ab der nächsten Version:** Die Kopfzeile hat zwei Auswahlmenüs, **Modell** und **Reasoning**. Gesperrte oder nicht verfügbare Modelle bleiben in der Liste, deaktiviert und mit Begründung. Das Reasoning-Menü bietet nur die Stufen an, die das Modell unterstützt:
   - **Standard (Anbieter):** Es wird nichts gesendet; der Anbieter entscheidet.
   - **Aus**, **Minimal**, **Niedrig**, **Mittel**, **Hoch**, **Sehr hoch**: zunehmende Denktiefe.
   Eine Änderung gilt ab der nächsten Antwort und ist nicht möglich, solange eine Antwort läuft. Ein kurzer Hinweis sagt, wenn eine höhere Stufe mehr kostet.
4. **Chats, die nicht gemerkt werden:** Schalte unter **Neuer Chat** (`#/chat/new`) vor der ersten Nachricht **Diesen Chat nicht merken** ein (`memoryMode: "incognito"`). Das lässt sich danach nicht mehr ändern.

### CLI

Den Modellkatalog auflisten:

```sh
plur1bus model list
```

Mit einem Modellprofil deiner Wahl chatten. Der Befehl warnt vor dem Cache und fragt nach, bevor er wechselt; `--yes` bestätigt für Skripte. `--no-memory` startet einen Chat, der nicht gemerkt wird.

```sh
plur1bus chat --model <PROFILE> --no-memory
```

Chat-Sitzungen auflisten und eine ansehen:

```sh
plur1bus session list
plur1bus session show <ID>
```

## Gut zu wissen

- **Denkstufen (ab der nächsten Version):** Die Skala ist Standard, aus, minimal, niedrig, mittel, hoch und sehr hoch. Ein Modell bietet nur einige davon an. Wird deine Wahl nicht angeboten, wird die nächstliegende unterstützte Stufe genutzt, und der Chat sagt das, nie stillschweigend. Ein Modell ohne Reasoning-Einstellung ignoriert die Wahl, und der Anbieter entscheidet. Ein Modellwechsel allein behält die gewählte Stufe.
- **Kosten:** Reasoning-Tokens werden als Ausgabe-Tokens abgerechnet, eine höhere Stufe kann also pro Antwort mehr kosten. Ist der Preis bekannt, zeigt der Chat ihn an. Die erste Antwort nach einem Wechsel kann mehr kosten, weil der Cache neu aufgebaut wird.
- **Nur für Menschen:** Das Wechseln des Chat-Modells ist Personen vorbehalten. Agenten und WebMCP-Werkzeuge können es nicht ändern.
- **Nur lokal (ab der nächsten Version):** Gilt „Nur lokal“ für den Agenten, werden Cloud-Profile als gesperrt gelistet und abgelehnt ([datenschutz.md](datenschutz.md)).
- **Nicht gemerkt:** Ein solcher Chat speichert nichts im Gedächtnis. Sein Verlauf sowie seine Modell- und Reasoning-Wahl bleiben nur im Arbeitsspeicher und werden nicht auf die Festplatte geschrieben.

## Fehlermeldungen

- `E_NOT_AVAILABLE` mit reason `model-profile-unavailable`: Das Profil ist nicht konfiguriert. Prüfe die Profilnamen in [providers.md](providers.md).
- `E_DENIED` mit reason `agent-principal`: Ein Agent oder Werkzeug wollte das Modell des Chats ändern; das darf nur eine Person.
- `E_CONFLICT`: Die Wahl wurde zwischenzeitlich anderswo geändert. Ab der nächsten Version sind die reasons `stale-model-preview` (sieh dir den aktuellen Stand an und wähle neu) und `session-busy` (eine Antwort läuft noch).
- Ab der nächsten Version: `E_DENIED` mit reason `local-only` (das Profil ist cloudbasiert, während „Nur lokal“ gilt), `E_NOT_AVAILABLE` mit reason `model-unavailable` und `E_INVALID_PARAMS` bei einer Denkstufe, die nicht auf der Skala liegt.

## Weiter

- Modell-Profile und Anbieter verwalten: [providers.md](providers.md)
- Datenschutz und Nur lokal: [datenschutz.md](datenschutz.md)
- Lange Unterhaltungen verwalten: [Lange Gespräche](lange-gespraeche.md)
