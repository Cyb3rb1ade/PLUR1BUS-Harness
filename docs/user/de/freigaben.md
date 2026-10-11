# Freigaben und Berechtigungen

Wenn ein Agent eine Aktion außerhalb seiner Standardrechte ausführen möchte, stellt er eine Freigabeanfrage. Sie
können Anfragen prüfen, bewilligen oder ablehnen und bestehende Berechtigungen (Grants) verwalten. Jeder Befehl hier
existiert in diesem Build (`docs/cli.md` ist die vollständige Referenz). Die englische Version dieser Seite ist
[../en/approvals.md](../en/approvals.md).

Für Aktionen, die eine Authentifizierung durch das Betriebssystem verlangen (Touch ID, Windows Hello, polkit), siehe
[bestaetigung-betriebssystem.md](bestaetigung-betriebssystem.md).

In der Weboberfläche werden Freigabeanfragen und bestehende Berechtigungen unter **Approvals** (`#/approvals`)
verwaltet.

## Offene Anfragen prüfen

Offene Anfragen anzeigen:

```sh
plur1bus approval pending
```

Oder alle Freigabeanfragen auflisten:

```sh
plur1bus approval list
```

In der Weboberfläche wird jede offene Anfrage als Karte nach dem D109-Layout dargestellt. Für eine sichere und
objektive Entscheidung zeigt die Karte die angeforderte Fähigkeit, die konkrete Auswirkung, exakte Ziele, das
Risikoniveau, die Umkehrbarkeit und das Aktions-Hash-Kürzel strikt **vor** der Begründung des Agenten an (welche
deutlich als unverifiziert gekennzeichnet ist).

## Über Anfragen entscheiden

Eine Anfrage bewilligen:

```sh
plur1bus approval approve <id>
```

Eine Anfrage ablehnen:

```sh
plur1bus approval deny <id>
```

In der Weboberfläche ermöglicht der Freigabedialog die Auswahl von Gültigkeitsbereich und Dauer (maximal 90 Tage).
Wenn der Server eine lokale Bestätigung durch das Betriebssystem erfordert, erklärt ein verständlicher Hinweis den
anstehenden Bestätigungsschritt.

## Bestehende Berechtigungen und Widerruf

Aktive Berechtigungen (Grants) auflisten:

```sh
plur1bus grant list
```

Eine aktive Berechtigung vorzeitig widerrufen:

```sh
plur1bus grant revoke <id>
```

In der Weboberfläche listet der Reiter **Aktive Berechtigungen** alle gültigen Freigaben mit Ziel, Ablaufzeitpunkt und
Widerrufs-Schaltfläche auf.
