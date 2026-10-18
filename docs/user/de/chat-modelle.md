# Chat-Modelle und Denkstufe

In Plur1bus kannst du das Modell und die Denkstufe (Reasoning-Level) individuell für jede Chat-Sitzung festlegen, auch in temporären Inkognito-Chats. Die englische Version dieser Seite ist [../en/chat-models.md](../en/chat-models.md).

## So geht's

### Web-UI

1. Öffne den **Chat** (`#/chat` oder `#/chat/new`).
2. Wähle in der Kopfzeile des Gesprächs die gewünschten Optionen aus den Auswahlmenüs:
   - **Modell-Menü:** Wähle eines der konfigurierten Profile (z. B. `openai/gpt-4.1` oder `ollama/llama3.1:8b`).
   - **Denkstufen-Menü:** Wähle die gewünschte Tiefe der Überlegungen:
     - `none` (Aus): Standard-Antwort ohne erweiterte Denkschritte.
     - `low` (Niedrig): Kurzes Denkbudget für schnelle, einfache Überlegungen.
     - `medium` (Mittel): Ausgewogenes Denkbudget für analytische Aufgaben.
     - `high` (Hoch): Ausführliche Gedankenkette für komplexe Programmier- oder Logikaufgaben.
3. **Inkognito-Chat („Nicht gemerkt“):**
   - Aktiviere unter **Neuer Chat** (`#/chat/new`) den Schalter **Nicht gemerkt** (`memoryMode: "incognito"`).
   - Modellwahl, Denkstufe und Verlauf werden im Inkognito-Modus rein im Arbeitsspeicher gehalten und beim Schließen verworfen.

### CLI

Verfügbare Modell-Kandidaten auflisten:

```sh
plur1bus model list
```

Aktive und vergangene Chatsitzungen auflisten:

```sh
plur1bus session list
```

Details und Modell-Einstellungen einer Sitzung anzeigen:

```sh
plur1bus session show <ID>
```

## Gut zu wissen

- **Anbieter-Unterstützung:**
  - OpenAI-Modelle mit Unterstützung für `reasoning_effort` (z. B. `o1` und `o3-mini`).
  - Anthropic-Modelle mit Denkbudget (z. B. Claude 3.7 Sonnet).
  - Gemini-Modelle mit Thinking-Modus (z. B. Gemini 2.0 Flash Thinking).
  - Bei Modellen ohne Reasoning-Unterstützung wird die Einstellung ignoriert, ohne einen Fehler auszulösen.
- **Nur für menschliche Nutzer:** Das Ändern des Modells im Chat (`chat.model.set`) ist menschlichen Bedienern vorbehalten. Autonome Agenten und WebMCP-Werkzeuge können das Chatmodell nicht eigenständig umschalten.
- **Nur-Lokal-Prüfung:** Ist „Nur lokal“ aktiv, werden Cloud-Profile im Auswahlmenü ausgeblendet und bei direkter Anforderung verweigert.
- **Inkognito-Datenschutz:** Inkognito-Chats schreiben weder Karten in die Memory-Engine noch Gesprächsprotokolle auf die Festplatte.

## Fehlermeldungen

- `E_MODEL_FORBIDDEN_LOCAL_ONLY`: Das gewählte Modellprofil verweist auf einen Cloud-Dienst, während der Modus „Nur lokal“ aktiv ist.
- `E_NOT_FOUND`: Das angeforderte Modellprofil existiert nicht in der Konfiguration.
- `E_FORBIDDEN`: Ein Werkzeug, Agent oder nicht-menschlicher Aufrufer hat versucht, das Sitzungsmodell zu ändern.

## Weiter

- Modell-Profile verwalten: [providers.md](providers.md)
- Datenschutz und Nur-Lokal-Modus: [Datenschutz](datenschutz.md)
- Lange Unterhaltungen verwalten: [Lange Gespräche](lange-gespraeche.md)
