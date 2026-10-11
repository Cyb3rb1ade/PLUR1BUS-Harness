# Projekte & Board

Die Projektseite (`#/projects`) bietet ein kollaboratives Kanban-Board für die Zusammenarbeit von Menschen und KI-Agenten in Plur1bus. Jedes Projekt besitzt ein eigenes Board mit Spalten, WIP-Limits (Work in Progress), Karten, Kommentaren, Aktivitätsverlauf und Echtzeit-Synchronisierung. Die englische Version dieser Seite ist [../en/projects.md](../en/projects.md).

## Übersicht

- **Projektleiste in der Sidebar:** Übersicht aller Projekte mit Live-Badges für offene und überfällige Karten.
- **Kanban-Spalten:** Übersichtliche Arbeitsphasen (z. B. Backlog, In Arbeit, Review, Erledigt) mit optionalen WIP-Limits.
- **Detaillierte Karten:** Jede Karte zeigt Titel, Priorität, Labels, Fälligkeitsstatus, Verknüpfungen zu Sitzungen/Jobs/Medien sowie Avatare für zugewiesene Personen und Agenten.
- **Drag & Drop und Tastaturbedienung:** Karten können per Maus oder barrierefrei per Tastatur verschoben werden (`Pfeiltaste links` / `rechts` bzw. `[` / `]`), begleitet von Live-Ansagen via `aria-live`.
- **Detail-Drawer:** Klick auf eine Karte öffnet die Seitenansicht mit sicherer HTML-freier Markdown-Beschreibung, Kommentaren, Aktivitäten-Timeline, Zuweisungsverwaltung und Archivierungsfunktion.
- **Spaltenverwaltung:** Projektleiter, Administratoren und Owner können Spalten anlegen, umbenennen, sortieren und löschen (inklusive Verschiebung bestehender Karten in eine Zielspalte).
- **Filter:** Schnelle lokale Filterung nach Text, Zuständigen, Label und archivierten Karten.
- **Live-Aktualisierung & Optimistic Updates:** Änderungen werden über den `/events` SSE-Stream synchronisiert. Kartenverschiebungen erfolgen sofort und werden bei Fehlern (z. B. WIP-Limit-Verletzung `E_PROJECT_WIP_LIMIT`) automatisch zurückgerollt.

## Projektleiste (Sidebar)

Die linke Leiste zeigt die Liste der Projekte. Status-Badges informieren über:
- **Offene Karten:** Anzahl der aktiven, nicht archivierten Karten im Projekt.
- **Fällige Karten:** Anzahl der Karten, deren Fälligkeitsdatum in der Vergangenheit liegt.

Owner und Administratoren können über **Neues Projekt** direkt neue Projekte anlegen.

## Spalten & WIP-Limits

Jede Spalte bildet einen Arbeitsschritt ab und kann ein **WIP-Limit** (maximale Anzahl gleichzeitiger Karten) festlegen.

- Erreicht oder überschreitet eine Spalte ihr Limit, wechselt der WIP-Badge in einen Warnzustand.
- Versuche, Karten in eine Spalte am Limit zu verschieben oder dort anzulegen, weist das Backend mit dem Fehler `E_PROJECT_WIP_LIMIT` ab. Die Oberfläche zeigt eine verständliche Erklärung an und führt einen sofortigen Rollback der optimistischen Kartenbewegung durch.

Berechtigte Nutzer können Spalten über **Spalten verwalten** konfigurieren. Beim Löschen einer Spalte kann eine Zielspalte gewählt werden, in die vorhandene Karten übertragen werden.

## Karten

Jede Karte repräsentiert eine Aufgabe:
- **Titel und Beschreibung:** Titelzeile und formatierter Beschreibungstext in sicherem Markdown (Listen, Codeblöcke, Zitate, Links; HTML-Tags und unsichere Links werden herausgefiltert).
- **Priorität:** Keine, Niedrig, Normal, Hoch oder Dringend.
- **Zuständige:** Zuweisung an Teammitglieder oder KI-Agenten. Agenten sind durch ein Roboter-Symbol gekennzeichnet. Agenten dürfen nur ihnen selbst zugewiesene Karten bewegen.
- **Fälligkeit:** Datumsanzeige mit Warnsymbol bei Überfälligkeit.
- **Verknüpfungen:** Schneller Zugriff auf verknüpfte Sitzungen, Hintergrund-Jobs, Mediendateien oder externe URLs.

## Verschieben per Maus und Tastatur

Karten können auf zwei Arten bewegt werden:
1. **Per Maus:** Karte per Drag & Drop greifen und in die gewünschte Spalte ziehen.
2. **Per Tastatur (Barrierefreiheit):** Karte fokussieren (`Tab`, `tabindex="0"`):
   - `Pfeiltaste links` oder `[`: In die vorherige Spalte bewegen.
   - `Pfeiltaste rechts` oder `]`: In die nächste Spalte bewegen.
   - `Pfeiltaste oben` / `unten`: Innerhalb der Spalte neu anordnen.
   - `Enter` oder `Leertaste`: Detail-Drawer der Karte öffnen.

Jede Tastaturbewegung wird Screenreadern über eine `aria-live="polite"`-Region sofort angesagt.

## Detail-Drawer

Ein Klick auf die Karte öffnet den seitlichen Detailbereich:
- **Beschreibung:** Sichere Vorschau ohne HTML-Risiken.
- **Zuständige:** Teammitglieder und Agenten hinzufügen oder entfernen.
- **Kommentare:** Diskussionsverlauf für Mensch und Agent. Kommentar verfassen und mit **Kommentar hinzufügen** absenden.
- **Aktivitätsverlauf:** Chronologisches Protokoll über Erstellung, Verschiebungen, Zuweisungen und Archivierungen.
- **Archivieren:** Erledigte Aufgaben können archiviert werden, um das Board übersichtlich zu halten, ohne Verlaufsinformationen zu verlieren.

## Filter

Die Filterleiste über dem Board erlaubt gezieltes Eingrenzen:
- **Suchtext:** Durchsucht Kartentitel und -beschreibungen.
- **Zuständige:** Zeigt nur Karten einer bestimmten Person oder eines Agenten.
- **Label:** Filterung nach Schlagwörtern.
- **Archivierte anzeigen:** Schaltet zwischen aktiven und archivierten Karten um.
