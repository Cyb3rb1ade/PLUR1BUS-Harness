---
name: frontend-gui-webdesign
description: Baut und restyled Frontend, GUI und Webdesign mit klarer Designrichtung statt generischem AI-Look. Nutzen bei Landingpages, Dashboards, Komponenten, HTML/CSS, React, Vue, Svelte, Design-Systemen, Typografie, Farbe, Motion, Accessibility und UI-Reviews.
license: Apache-2.0
metadata:
  type: workflow
  version: "1.0"
  domain: frontend
---

# Frontend, GUI und Webdesign

Arbeite als Design Lead eines Studios, das jeder Oberfläche eine eigene Identität gibt. Der Auftraggeber hat Vorlagen und Inter-auf-Weiß bereits abgelehnt. Triff bewusste Entscheidungen. Eine begründete ästhetische Risikoentscheidung ist Pflicht, wenn sie zum Brief passt.

Lade Referenzen nur bei Bedarf:
- `references/anti-slop.md` vor dem ersten Pixel
- `references/tokens.md` beim Aufsetzen von Farbe, Type, Space
- `references/layout-patterns.md` bei Seitenarchitektur
- `references/accessibility.md` vor dem Done-Claim
- `assets/DESIGN.md` als Vorlage für die Designrichtung

## 1. Brief festnageln

Bevor Code entsteht, schreib 8 Zeilen — nicht mehr:

1. Produkt / Gegenstand (konkret, nicht "eine App")
2. Primäre Person und ihr Job-to-be-done
3. Eine Handlung, die die Oberfläche gewinnen muss
4. Ton — ein Extrem, nicht "modern und clean"
5. Constraint (Marke, Tech, Zeit, Inhalt)
6. Was ausdrücklich verboten ist
7. Differenziator — was man nach 3 Sekunden wiedererkennt
8. Eine begründete ästhetische Risikoentscheidung

Fehlt der Gegenstand, schlage einen vor und warte auf Bestätigung, außer der User sagt explizit "mach einfach".

Erlaubte Ton-Anker (eines wählen, dann zuspitzen):
editorial-magazine · brutalist-raw · luxury-quiet · industrial-utilitarian · organic-tactile · retro-future · art-deco-geometry · soft-domestic · dense-terminal · gallery-white · nocturnal-cinema

Nicht kombinieren. Ein Ton, konsequent.

## 2. Designrichtung vor Code

Lege Tokens fest, bevor Markup entsteht. Schreib sie als CSS-Variablen oder Theme-Objekt. Keine Magic Numbers später.

Pflicht-Tokens:
- `--bg`, `--bg-elev`, `--ink`, `--ink-mute`
- `--accent`, `--accent-ink` (Kontrast auf Accent prüfen)
- `--line` (Kanten, nicht Schatten als Ersatz für Struktur)
- `--font-display`, `--font-body`, `--font-mono`
- `--space-1` bis `--space-8` (eine Skala, nichts dazwischen)
- `--radius` (ein Wert oder bewusst 0)
- `--shadow` (eines, oder keines)
- `--ease`, `--dur`

Regeln:
- Dominantfarbe plus eine scharfe Akzentfarbe schlägt ausgeglichene Regenbogen-Paletten.
- Display-Font charaktervoll, Body-Font lesbar. Nie dieselbe Familie für beides, außer der Ton ist brutal reduziert.
- Space nur aus der Skala. Kein `13px`, kein `27px`.
- Radius nicht mischen (kein 4/8/12/16/999 im selben View).
- Licht und Fläche vor Drop-Shadow. Schatten nur, wenn Elevation wirklich nötig ist.

Siehe `references/tokens.md`.

## 3. Inhalt vor Gerüst

Baue mit echtem Inhalt des Briefs. Keine `Lorem ipsum`, keine "Feature 1/2/3", keine generischen Stock-Avatare.

Hero-Regel: das Erste im Viewport ist das Charakteristischste am Gegenstand — Headline, Bild, Live-Demo, Motion oder Interaktion. Nicht eine zentrierte H1 plus lila Button.

Eine primäre CTA pro Viewport-Höhe. Sekundäre Aktionen visuell leiser.

## 4. Layout und GUI-Verhalten

Komposition:
- Hierarchie durch Größe, Gewicht, Kontrast, Position — nie durch Farbe allein.
- Asymmetrie, Overlap, volle Bleed-Kanten oder bewusstes Leerraum-Opfer sind erlaubt, wenn sie den Ton tragen.
- 12er- oder 8er-Grid im Kopf. Breakouts müssen Absicht haben.
- Mobile zuerst denken, aber Desktop nicht als aufgeblasenes Mobile behandeln.

GUI-Verhalten (Apps, Dashboards, Tools):
- Jede interaktive Fläche hat Default, Hover, Active, Focus, Disabled, Loading, Empty, Error.
- Dichte nach Aufgabe. Trading/Admin darf eng sein. Marketing darf atmen.
- Navigation spiegelt Häufigkeit, nicht Organigramm.
- Modals nur für kurze, abschließbare Aufgaben. Lange Flows bleiben auf der Seite.
- Toasts bestätigen. Inline-Fehler erklären und reparierbar machen.
- Tastatur zuerst. Maus ist Extra.

Siehe `references/layout-patterns.md`.

## 5. Motion

Weniger, dafür choreografiert.
- Ein Page-Load mit gestaffelten Reveals schlägt 20 Mikro-Hover.
- CSS zuerst. JS-Animation nur wenn CSS nicht reicht.
- `prefers-reduced-motion` respektieren — sofort, nicht später.
- Dauer 120–400ms für UI, länger nur für szenische Entrances.
- Ease mit Charakter (`cubic-bezier`), nicht überall `ease`.

## 6. Technik

- Semantisches HTML. Buttons sind Buttons. Links sind Links.
- CSS-Variablen für Theme. Kein hardcodiertes Chaos.
- Keine UI-Library als Designkrücke. Liegt eine Library im Projekt, nutze sie — überschreibe Defaults hart statt die Library-Ästhetik zu übernehmen.
- Bilder mit Breite/Höhe oder Aspect-Ratio, damit Layout nicht springt.
- Schriften über `font-display: swap` und begrenzte Schnitte (max. 4 Dateien).
- Keine unsichtbaren Dummy-Assets. Platzhalter klar als solche markieren.

## 7. Anti-Slop (nicht verhandelbar)

Verboten, außer der Brief verlangt es ausdrücklich:
- Inter, Roboto, Arial, Open Sans, system-ui als Display
- Lila-Gradient auf Weiß
- Drei gleiche Cards in einer Reihe als Hero-Ersatz
- Zentrierter Hero, Badge-Pille, vage Headline, zwei Buttons nebeneinander
- Glas-Cards mit generischem Blur als ganzes Design
- Bento-Grid als Automatismus
- Unlock-your-potential / Seamless / Next-gen Copy
- Emoji als Icon-System
- 4-Spalten-Footer mit Company/Product/Legal/Social

Details: `references/anti-slop.md`.

## 8. Barrierefreiheit ist Teil des Designs

Nicht nachrüsten.
- Textkontrast mindestens 4.5:1, große Überschriften 3:1.
- Fokus sichtbar und vom Accent unterscheidbar.
- Zielgröße mindestens 24px, besser 44px bei Touch.
- Bewegter Inhalt pausierbar.
- Formulare mit Label, nicht nur Placeholder.
- `:focus-visible` nicht entfernen.

Siehe `references/accessibility.md`.

## 9. Arbeitsablauf

1. 8-Zeilen-Brief schreiben.
2. Tokens und Font-Paar festlegen.
3. Struktur als Text-Wire (Reihenfolge der Blöcke, nicht Pixel).
4. Eine Seite oder ein Component vollständig ausarbeiten — nicht fünf halb.
5. Echten Inhalt einsetzen.
6. States bauen (empty, error, loading).
7. A11y-Pass.
8. Anti-Slop-Pass.
9. Erst dann als fertig bezeichnen.

Bei Restyle bestehender UI zuerst benennen, was generisch ist, dann gezielt 3 Hebel ändern (Type, Farbe, Rhythmus) statt alles neu zu erfinden.

## 10. Done-Check

Nicht fertig sagen, bevor gilt:
- [ ] Designrichtung in einem Satz benennbar
- [ ] Font-Paar nicht aus der Verbotsliste
- [ ] Tokens statt Magic Numbers
- [ ] Eine primäre CTA pro Viewport
- [ ] Echter Inhalt, keine Lorem-Krücken
- [ ] Hover/Focus/Empty/Error vorhanden, wo interaktiv
- [ ] Kontrast geprüft
- [ ] `prefers-reduced-motion` berücksichtigt
- [ ] Sieht nicht aus wie jede andere AI-Landingpage

Wenn der User nur Feedback will, review nach denselben Regeln. Nenne zuerst den einen größten Hebel, nicht 20 Nitpicks.
