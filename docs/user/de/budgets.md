# Nutzung und Limits

Die Seite Nutzung & Kontingent (`#/usage`) zeigt, was deine Agenten verbraucht haben und wo die Grenzen liegen. Die Nutzung wird immer gezählt. Die Limits bestimmen, was bei einem Wert passiert: Ein **weiches Limit** warnt, ein **hartes Limit** stoppt weitere Modellaufrufe. Die englische Version dieser Seite ist [../en/budgets.md](../en/budgets.md).

## Die Seite lesen

- Jede Anzeige zeigt ein Limit als „verbraucht von Limit (Prozent)“, zum Beispiel *Tageskosten* oder *Monatstokens*.
- Der Zustand ist einer von: **Innerhalb des Limits**, **Warnung: weiches Limit erreicht**, **Überschritten: hartes Limit erreicht**.
- Ohne Limit wird nichts gestoppt. Die Seite zeigt trotzdem, was bisher verbraucht wurde.

## Ein Limit setzen

1. Wähle **Limit setzen**.
2. Wähle den Geltungsbereich: **Global** (alle Agenten zusammen) oder einen **Agenten**.
3. Trage ein **weiches Limit**, ein **hartes Limit** oder beide ein. Das weiche Limit darf nicht höher sein als das harte.
4. Kostenlimits gelten in US-Dollar, zum Beispiel `5` oder `0.25`. Tokenlimits zählen Eingabe- und Ausgabe-Tokens.
5. Bestätige das Limit.

Mit **Limit bearbeiten** änderst du ein Limit, mit **Limit entfernen** löschst du es. Beim Entfernen wirst du zuerst gefragt.

Limits pro Projekt oder pro Benutzer gibt es noch nicht.

## Was an den Grenzen passiert

- **Weiches Limit:** der Zustand wechselt zu einer Warnung. Die Agenten arbeiten weiter.
- **Hartes Limit:** weitere Modellaufrufe werden gestoppt, bis der Zeitraum zurückgesetzt oder das Limit angehoben wird.

## Weiter

- Modell-Provider und Profile: [providers.md](providers.md)
- Lange Gespräche und Zusammenfassungen, die ebenfalls Modellaufrufe nutzen: [lange-gespraeche.md](lange-gespraeche.md)
