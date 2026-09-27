# Tokens

Eine Skala. Keine Ausnahmen ohne Begründung.

## Farbe

Plane in `oklch` oder HSL, nicht in zufälligem Hex.

Minimum:
```css
:root {
  --bg: oklch(0.99 0.01 95);
  --bg-elev: oklch(1 0.005 95);
  --ink: oklch(0.22 0.02 40);
  --ink-mute: oklch(0.45 0.02 40);
  --accent: oklch(0.55 0.14 35);
  --accent-ink: oklch(0.99 0.01 95);
  --line: oklch(0.88 0.01 95);
}
```

Regeln:
- `--ink` auf `--bg` mindestens 4.5:1
- `--accent-ink` auf `--accent` mindestens 4.5:1
- Dark Mode ist invertierte Hierarchie, nicht nur invertierte Helligkeit. Flächen bleiben gestuft.
- Semantikfarben (ok, warn, danger) nicht als Markenfarben missbrauchen.

## Typografie

Zwei Familien, vier Schnitte maximal.

Beispiel-Paare nach Ton:
- editorial — Fraunces / Source Serif ↔ Newsreader / Geist
- industrial — DIN / Barlow Condensed ↔ IBM Plex Sans
- luxury — Cormorant ↔ Manuale oder Outfit
- terminal — IBM Plex Mono überall, Größe statt Familie als Hierarchie
- organic — Fraunces / Recoleta ↔ Satoshi / Nunito nur wenn der Brief weich ist

Skala (Desktop, mobile −1 Stufe):
```
display: clamp(2.4rem, 6vw, 5.5rem)
h1: clamp(2rem, 4vw, 3.2rem)
h2: 1.75rem
h3: 1.25rem
body: 1.0625rem
small: 0.8125rem
```

Zeilenlänge Body 45–75 Zeichen. Headlines dürfen enger und unruhiger sein.
`line-height` Body 1.45–1.6, Display 0.95–1.15.
Überschriften nicht in Farbe unterscheiden, sondern in Größe/Gewicht/Schnitt.

## Raum

8er-Skala:
```
--space-1: 0.25rem
--space-2: 0.5rem
--space-3: 0.75rem
--space-4: 1rem
--space-5: 1.5rem
--space-6: 2rem
--space-7: 3rem
--space-8: 5rem
```

Sektion-Innenraum aus `--space-6` bis `--space-8`. Komponenten-Innenraum aus `--space-3` bis `--space-5`.
Nie `gap: 13px` oder `padding: 22px`.

## Form und Linie

Ein Radius-Token. Entweder scharf (`0` / `2px`) oder weich (`12px`). Pillen nur für echte Chips/Tags.
Linie 1px in `--line`. 2px nur als bewusste Betonung.

## Motion-Tokens

```
--dur-1: 120ms
--dur-2: 200ms
--dur-3: 400ms
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)
```
