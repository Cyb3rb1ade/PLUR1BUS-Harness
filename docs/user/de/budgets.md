# Nutzung und Limits

Die Seite Nutzung & Kontingent (`#/usage`) zeigt, was deine Agenten verbraucht haben und wo die Grenzen liegen. Die Nutzung wird immer gezählt. Die Limits bestimmen, was bei einem Wert passiert: Ein **weiches Limit** warnt, ein **hartes Limit** stoppt weitere Modellaufrufe (bei einem Medien-Limit weitere Bilder und Videos). Die englische Version dieser Seite ist [../en/budgets.md](../en/budgets.md).

## Die Seite lesen

- Jede Anzeige zeigt ein Limit als „verbraucht von Limit (Prozent)“, zum Beispiel *Tages-Tokens*, *Bilder pro Tag* oder *Videosekunden pro Monat*.
- Der Reiter **Verbrauch** zeigt Tokens, erzeugte Bilder und erzeugte Videosekunden für heute und diesen Monat, je Agent und Modell.
- Der Zustand ist einer von: **Innerhalb des Limits**, **Warnung: weiches Limit erreicht**, **Überschritten: hartes Limit erreicht**.
- Ohne Limit wird nichts gestoppt. Die Seite zeigt trotzdem, was bisher verbraucht wurde.

## Ein Limit setzen

1. Wähle **Limit setzen**.
2. Wähle den Geltungsbereich: **Global** (alle Agenten zusammen) oder einen **Agenten**.
3. Wähle die **Messgröße**:
   - **Tokens**: Eingabe- und Ausgabe-Tokens (die Ausgabe enthält gemeldete Reasoning-Tokens).
   - **Bilder**: erzeugte Bilder. Eine Anfrage nach mehreren Bildern wird ganz abgelehnt, wenn nicht alle hineinpassen.
   - **Videosekunden**: Sekunden erzeugten Videos, auf ganze Sekunden aufgerundet.
4. Trage ein **weiches Limit**, ein **hartes Limit** oder beide als ganze Zahl ein. Das weiche Limit darf nicht höher sein als das harte. Plur1bus rechnet nirgends in Geld; es gibt keine Kostenlimits und keine Preisanzeige.
5. Bestätige das Limit.

Mit **Limit bearbeiten** änderst du ein Limit, mit **Limit entfernen** löschst du es. Beim Entfernen wirst du zuerst gefragt.

Limits pro Projekt oder pro Benutzer gibt es noch nicht.

## Was an den Grenzen passiert

- **Weiches Limit:** der Zustand wechselt zu einer Warnung. Die Agenten arbeiten weiter.
- **Hartes Limit:** weitere Modellaufrufe werden gestoppt, bis der Zeitraum zurückgesetzt oder das Limit angehoben wird. Ein Medien-Limit stoppt nur Bilder oder Videos: Die Anfrage wird abgelehnt, bevor sie an den Anbieter geht. Liefert ein Anbieter weniger Bilder oder ein kürzeres Video als angefragt, zählt nur das Gelieferte.
- Ein Bild-Limit stoppt weder Chats noch Videos, und Bilder verbrauchen kein Token-Limit.

Auf der Kommandozeile: `plur1bus budget set --global --period day --metric images --hard 20` (oder `--metric video-seconds`).

## Weiter

- Modell-Provider und Profile: [providers.md](providers.md)
- Lange Gespräche und Zusammenfassungen, die ebenfalls Modellaufrufe nutzen: [lange-gespraeche.md](lange-gespraeche.md)
