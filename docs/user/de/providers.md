# Modell-Provider und Profile

Diese Seite erklärt, wie du dich bei Anbietern anmeldest, wie Modelle gewählt werden, wann ein Fallback greift, wie
lokale Modelle laufen und was die Fehlerklassen bedeuten. Die technische Referenz ist
[../../providers.md](../../providers.md) (englisch); die englische Fassung dieser Seite ist
[../en/providers.md](../en/providers.md).

## Bei einem Anbieter anmelden

Die Anmeldung läuft über `plur1bus login`. Bei OpenAI kannst du dich mit deinem ChatGPT-Konto anmelden oder einen
API-Schlüssel hinterlegen. Alle anderen Anbieter nutzen einen API-Schlüssel. Der Befehl spricht mit dem Core. Ist der Core nicht gestartet, bricht er mit `E_CORE_UNAVAILABLE` ab;
starte ihn dann mit `plur1bus daemon start`.

Die Anmeldung ist noch experimentell. Eine Anmeldung über die Web-Oberfläche gibt es noch nicht; alles läuft über die
Kommandozeile.

### Mit ChatGPT anmelden

1. Starte die Anmeldung. Für ChatGPT ist der Anbieter `openai`:

   ```sh
   plur1bus login <anbieter>
   ```

2. Der Befehl gibt eine Adresse aus und versucht, den Browser zu öffnen. Melde dich dort bei ChatGPT an und bestätige den
   Zugriff.
3. Danach meldet die Kommandozeile die gespeicherte Anmeldung: Kennung, Workspace und Ablaufdatum. Das Token selbst
   wird nie ausgegeben.

Die Anmeldung wartet standardmäßig 600 Sekunden. Mit `--timeout <sekunden>` änderst du das. Ctrl-C bricht ab, dann wird
nichts gespeichert. Ist das Kontingent deines Abos aufgebraucht, meldet Plur1bus das und wechselt nicht stillschweigend
auf eine andere Abrechnung.

### Ohne Browser: Server, SSH, Container

Dieser Abschnitt betrifft nur die ChatGPT-Anmeldung bei OpenAI. Mit `--no-browser` gibt der Befehl nur die Adresse aus und
öffnet keinen Browser:

```sh
plur1bus login <anbieter> --no-browser
```

Läuft Plur1bus auf einem Rechner ohne Browser, kannst du den Rückruf-Port per SSH zu deinem Rechner durchreichen. Den
Port nennt die Kommandozeile in ihrer Ausgabe; im Beispiel ist es 49152. Führe den Tunnel auf dem Rechner mit Browser aus:

```sh
ssh -L 49152:127.0.0.1:49152 <benutzer>@<rechner>
```

Ohne diesen Tunnel landet der Browser auf einer Seite, die nicht erreichbar ist. Dann hilft `--paste`: Kopiere die
vollständige Adresse aus der Adressleiste dieser Seite und füge sie in die Eingabe ein, die der Befehl anfordert:

```sh
plur1bus login <anbieter> --no-browser --paste
```

Die Adresse enthält den Anmeldecode. Plur1bus nimmt nur die Adresse dieser einen Anmeldung an, speichert sie nicht und
gibt sie nicht aus.

### API-Schlüssel

Andere Anbieter (Anthropic, Google, Gemini, xAI, OpenRouter, Together, fal, Replicate, ElevenLabs) nutzen einen
API-Schlüssel. Er wird von der Standardeingabe gelesen, nie als Argument:

```sh
printf %s "$ANTHROPIC_API_KEY" | plur1bus login anthropic
```

Plur1bus speichert den Schlüssel als Geheimnis mit dem Namen `<anbieter>/api-key` (mit `--name` änderst du den Namen).
Ausgegeben wird nur dieser Name. In der Konfiguration verweist du mit `apiKeyRef` darauf, nicht auf den Schlüssel selbst.

Hast du einen Schlüssel jemals als Argument getippt, lehnt der Befehl ihn ab (`value-in-argument`). Behandle ihn dann als
offengelegt und erstelle einen neuen.

### Anmeldungen verwalten

```sh
plur1bus login status
plur1bus login list
plur1bus login logout <kennung>
```

- `status` zeigt die gespeicherten Anmeldungen und laufende Anmeldungen.
- `list` zeigt Kennung, Workspace, Ablaufdatum und ob eine neue Anmeldung nötig ist.
- `logout` entfernt eine Anmeldung samt lokalem Token. Die Kennung darf ein eindeutiger Anfang sein, mindestens acht
  Zeichen lang.

Die Schlüssel selbst verwaltet der Geheimnisspeicher: `plur1bus secret status` zeigt, welcher Speicher genutzt wird.

## Profile

Ein **Profil** ist eine benannte, geordnete Liste von Modellen. Das erste wird zuerst versucht; scheitert es aus einem
Grund, den ein anderes Modell beheben könnte, kommt das nächste dran. Profile stehen unter `modelProfiles` in
`config.json`:

```json
{
  "modelProfiles": {
    "default": {
      "candidates": [{ "model": "openai/gpt-4.1" }, { "model": "gemini/gemini-2.5-pro" }, { "model": "ollama/llama3.1:8b" }],
      "params": { "temperature": 0.2, "maxTokens": 4096 }
    }
  }
}
```

- Ein Modell steht als `provider/modell`. Alles nach dem ersten `/` ist die Modell-ID.
- Die Reihenfolge der Liste ist die Priorität.
- `params` setzt Standardwerte fürs Sampling; was eine Anfrage selbst setzt, gewinnt.
- Ein Profil namens `default` gilt, wenn nichts anderes genannt wird. Ohne Konfiguration wird eines aus den Providern
  gebaut, die ein Standardmodell haben.
- Ein Tippfehler wird mit Fundstelle gemeldet, z. B. `modelProfiles.fast.candidates[1].model: unknown provider "opnai"`.
  Alle Probleme werden auf einmal aufgelistet.
- `strategy: "moa"` (Mixture of Agents) wird akzeptiert und geprüft, ist aber noch nicht ausführbar: Ein solches Profil
  schlägt mit klarer Meldung fehl, statt stillschweigend wie eine einfache Fallback-Liste zu laufen.

## Wann greift der Fallback?

| Problem | Wiederholung | Fallback aufs nächste Modell |
|---|---|---|
| Rate-Limit (429) | ja, mit der vom Provider genannten Wartezeit | ja |
| Provider überlastet oder 5xx | ja | ja |
| Timeout, Netzwerkfehler | ja | ja |
| Falscher oder fehlender API-Key | nein | **nein** — Key korrigieren |
| Ungültige Anfrage, Inhalts-/Safety-Sperre | nein | **nein** — ein anderer Anbieter lehnt sie ebenfalls ab |
| Prompt zu lang fürs Modell | nein | **nein** |
| Du hast abgebrochen | nein | nein |

Jedes Modell jedes Providers hat seinen eigenen Circuit-Breaker: Fällt `gemini-2.5-pro` dauernd aus, wird es eine
Weile übersprungen, während `gemini-2.5-flash` nutzbar bleibt. Die Wartezeit zwischen Wiederholungen wächst
exponentiell mit zufälligem Jitter; ein Provider, der eine sehr lange Wartezeit verlangt, wird zugunsten des nächsten
Modells übersprungen.

## Lokale Modelle (Ollama, LM Studio)

Ollama (`127.0.0.1:11434`) und LM Studio (`127.0.0.1:1234`) werden automatisch gefunden und brauchen keinen Key. Läuft
eines nicht, gilt es einfach als **nicht verfügbar** und das nächste Modell des Profils kommt dran; nichts stürzt ab,
der Start wird nicht verzögert. An lokale Server werden nie Zugangsdaten gesendet. Ein Server auf einem anderen Rechner
braucht eine ausdrückliche Einstellung und eine Egress-Freigabe.

## Fehlerklassen

`auth`, `rate_limit`, `overloaded`, `context_length`, `invalid_request`, `network`, `timeout`, `aborted`, `unknown`.
Sie sind für alle Provider gleich; rohe Provider-Fehler werden nicht angezeigt, API-Keys erscheinen nie in
Fehlermeldungen oder Logs.

## Token-Zahlen

Provider melden unterschiedlich viele Details. Meldet einer eine Zahl nicht, wird sie als *unbekannt* geführt, nicht
als 0.

## Wenn etwas nicht klappt

Die Fehler der Anmeldung kommen mit einem `reason` (vollständige Tabelle in
[openai-auth.md](../../openai-auth.md#cli-and-rpc-login)).

| Fehler | Bedeutung | Was tun |
|---|---|---|
| `E_CORE_UNAVAILABLE` | Der Core läuft nicht. | `plur1bus daemon start`, dann erneut anmelden. |
| `E_CONFLICT`, `login-timeout` | Die Anmeldung wurde nicht rechtzeitig abgeschlossen. | Erneut starten, bei Bedarf mit `--timeout` mehr Zeit geben. |
| `E_CONFLICT`, `port-in-use` | Der Rückruf-Port ist belegt. | Das andere Programm schließen und erneut anmelden. |
| `E_DENIED`, `state-mismatch` | Die eingefügte Adresse gehört nicht zu dieser Anmeldung oder ist verändert. | Eine neue Anmeldung starten und die neue Adresse verwenden. |
| `E_DENIED`, `access-denied` | Du hast den Zugriff abgelehnt. | Erneut anmelden und bestätigen. |
| `E_NOT_FOUND`, `auth-required` | Die gespeicherte Anmeldung ist abgelaufen. | `plur1bus login <anbieter>`. |
| `E_NOT_AVAILABLE`, `transport-failed` | OpenAI war nicht erreichbar. | Netzwerk prüfen und später erneut versuchen. |
| `E_STORAGE`, `persist-failed` | Der Geheimnisspeicher konnte nicht schreiben. | `plur1bus secret status` prüfen. |
| `E_INVALID_PARAMS`, `value-in-argument` (Exit 2) | Ein Schlüssel stand im Befehl. | Schlüssel erneuern und den Befehl mit stdin wiederholen. |
| Exit 130 (`E_CANCELLED`) | Du hast mit Ctrl-C abgebrochen. | Nichts zu tun; die Anmeldung wurde nicht gespeichert. |
