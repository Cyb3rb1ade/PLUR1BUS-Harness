# Accessibility

Design, das man nicht nutzen kann, ist kein Design.

## Kontrast

- Fließtext und UI-Label ≥ 4.5:1
- Große Überschriften (≥ 24px regular oder 18.5px bold) ≥ 3:1
- Placeholder zählt als Text
- Fokus-Ring ≥ 3:1 zum Hintergrund

## Tastatur und Fokus

- Tab-Reihenfolge = visuelle Reihenfolge
- `:focus-visible` sichtbar, 2px Minimum, nicht `outline: none` ohne Ersatz
- Dialoge fangen Fokus und geben ihn zurück
- Escape schließt das oberste Overlay

## Semantik

- Eine `h1` pro Seite
- Überschriften nicht überspringen
- `button` für Aktionen, `a` für Navigation
- `nav`, `main`, `header`, `footer` nutzen
- Icon-only Controls brauchen `aria-label`

## Bewegung und Medien

- `prefers-reduced-motion: reduce` → keine parallax/autoplay-motion
- Autoplay-Video stumm und pausierbar
- Bilder mit sinnvollem `alt`; dekorativ `alt=""`

## Formulare

- Jedes Feld hat ein sichtbares Label
- Fehlertext ist mit dem Feld verknüpft
- Pflichtfelder nicht nur durch Sternchenfarbe

## Zielgröße

- Touch 44×44px wo möglich
- Desktop mindestens 24×24px plus Abstand

## Check vor Done

- Nur Tastatur durch die Kernaufgabe
- Zoom 200% ohne Verlust der Kernaufgabe
- Screenreader-Namen der Primäraktionen sinnvoll
