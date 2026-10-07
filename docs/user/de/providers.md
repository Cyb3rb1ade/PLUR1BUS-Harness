# Modell-Provider und Profile

Diese Seite erklärt, wie Modelle gewählt werden, wann ein Fallback greift, wie lokale Modelle laufen und was die
Fehlerklassen bedeuten. Die technische Referenz ist [../../providers.md](../../providers.md) (englisch); die englische
Fassung dieser Seite ist [../en/providers.md](../en/providers.md).

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
