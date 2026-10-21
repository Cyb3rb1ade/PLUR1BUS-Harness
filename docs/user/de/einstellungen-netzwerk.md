# Netzwerk-Einstellungen

Unter **Einstellungen → Netzwerk** (`#/settings/network`) bearbeitest du die Freigabeliste für ausgehende Verbindungen (`egress`). Owner und Admin dürfen diese Konfiguration lesen und ändern; Operator, Member und Viewer haben dafür keinen Zugriff. Die englische Fassung steht unter [network-settings.md](../en/network-settings.md).

## Ziele erlauben

Die Seite bietet drei Felder. Listen brauchen **einen Eintrag pro Zeile**, keine kommaseparierte Liste.

| Schlüssel | Bedeutung | Standard |
|---|---|---|
| `egress.allowHosts` | erlaubte Hostnamen oder exakte IP-Adressen, ohne Schema, Pfad oder Port | leere Liste |
| `egress.allowPorts` | erlaubte Zielports, Ganzzahlen von 1 bis 65535 | `443` |
| `egress.allowLoopback` | erlaubt Loopback-Ziele und dort auch unverschlüsseltes HTTP, wenn Host und Port ebenfalls erlaubt sind | aus |

Die leere Hostliste erlaubt kein Ziel. `example.org` erlaubt genau diesen Namen. `*.example.org` erlaubt dessen Subdomains, aber nicht `example.org` selbst. `*` erlaubt beliebige Namen; Loopback-Ziele brauchen weiterhin einen ausdrücklichen Eintrag. Verwende möglichst die konkreten Ziele, die dein Anbieter braucht.

Für einen lokalen Dienst auf `127.0.0.1:11434` trägst du beispielsweise `127.0.0.1` als Host und `11434` als zusätzlichen Port ein und schaltest `egress.allowLoopback` ein. Behalte `443` in der Portliste, falls andere erlaubte Ziele HTTPS auf diesem Port brauchen. Für ein Ziel mit `localhost` muss auch diese Schreibweise freigegeben sein.

Ein freigegebener Name hebt die Adressprüfung nicht auf: Private Netzwerkadressen und andere gesperrte Adressbereiche bleiben durch den ausgehenden Netzwerkfilter blockiert; für ausdrücklich freigegebene Loopback-Ziele gilt die genannte Ausnahme. Eine ungültige Richtlinie sperrt alle Ziele. Das Feld erlaubt keine URL mit Zugangsdaten.

## Prüfen und speichern

Ändere die Felder, wähle **Änderungen prüfen**, kontrolliere alte und neue Listen und wähle **Änderungen speichern**. Diese drei Schlüssel sind **Live**. Verwerfen, Konflikte und ungespeicherte Entwürfe funktionieren wie unter [Allgemeine Einstellungen](einstellungen-allgemein.md). Die Vorschau prüft die Konfigurationsänderung; sie führt keinen Verbindungstest zum Ziel aus. Diese Seite zeigt auch keine Zähler über erlaubte oder abgelehnte Verbindungen.

**„Nur lokale Modelle“** (`privacy.localOnly`) ist die unter [Datenschutz](datenschutz.md) beschriebene Regel für alle Modell- und Inferenzaufrufe. Als lokal gelten Loopback-Endpunkte und die ausdrücklich in `privacy.localEndpoints` eingetragenen Ursprünge. Eine Netzwerkfreigabe hebt diese Regel nicht auf; auch ein als lokal zugelassener Endpunkt muss die Egress-Regeln erfüllen. `web.fetch` und `web.search` sind keine Modellaufrufe und bleiben unabhängig von „Nur lokale Modelle“ durch Egress und Werkzeugberechtigungen geregelt. Die Netzwerkseite stellt weder einen eingehenden Listener noch Gerätezugriff ein; dafür gibt es [Geräte und Fernzugriff](remote-access.md).
