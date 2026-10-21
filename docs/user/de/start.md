# Startseite

Die Startseite (`#/home`) bündelt Links und einen kurzen Systemstatus. Du öffnest sie über die Adresse im Browser. Sie hat keinen eigenen Eintrag in der Seitenleiste; die normale Startansicht der Anwendung ist **Chat**. Die englische Fassung steht unter [home.md](../en/home.md).

## Dokumentation und Repositories

**Benutzerhandbuch** öffnet die gebündelte Schnellstartseite, **Betrieb & FAQ** das Betriebshandbuch. Beide bleiben in der Anwendung. Die Links zu den drei Projekt-Repositories und zur offiziellen Webseite öffnen einen neuen Tab. Kontakt- und Spendenlinks erscheinen erst, wenn dafür eine Adresse hinterlegt ist.

Die Links bleiben auch dann benutzbar, wenn der Systemstatus nicht geladen werden kann. Mehr zur Navigation in der Doku steht unter [Hilfe](hilfe.md).

## Systemstatus lesen

Die Statuskarte lädt beim Öffnen Informationen von der API und dem Core. Sie zeigt **Version und Build**, **Core-Status** und, soweit gemeldet, **Prozesszustand**, **Engine bereit** und **Laufzeit** in Sekunden. Fehlende Informationen werden nicht durch erfundene Werte ersetzt: Bei einer fehlenden Version steht ein Strich; andere nicht gemeldete Felder entfallen.

Den Status dürfen Owner, Admin und Operator lesen. Member und Viewer sehen den Hinweis **Der Status ist für deine Rolle nicht verfügbar**. Diese Meldung sagt nichts darüber aus, ob der Core läuft.

Antwortet keine der Statusquellen und liegt das nicht allein an fehlenden Rechten, zeigt die Karte **Getrennt** und **Erneut versuchen**. Antwortet nur eine Quelle, werden deren verfügbare Angaben angezeigt. Die Seite aktualisiert den Status nicht regelmäßig im Hintergrund.

Für genauere Prüfungen und Protokolle öffne [Status und Protokolle](diagnose.md). Die Startseite startet keine Reparatur und ändert keine Konfiguration.
