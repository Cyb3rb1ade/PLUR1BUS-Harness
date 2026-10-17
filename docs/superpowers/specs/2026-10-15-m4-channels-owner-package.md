# Codex-Großpaket: M4 Channels abschließen (15.10.2026)

Repo: Cyb3rb1ade/PLUR1BUS-Harness. Basis: frisches `origin/main` ≥ `4557176c`.

Umfang: etwa 18–24 Agenten-Tage in **fünf Phasen, jede mit eigenem Branch und PR**. Die Reihenfolge ist empfohlen. Phase 2 (Matrix-E2EE) und Phase 3 (Buzz) sind unabhängig voneinander.
- Zwischen den Phasen `origin/main` normal mergen.
- Ist der vorige PR noch offen, dessen Branch normal hineinmergen und den neuen PR als Draft „baut auf #N auf“ öffnen.

**Ziel:** Die Abnahmekriterien 1 bis 5 aus `docs/milestones.md` §M4 sind erfüllt. Kriterium 6 ist schon erfüllt und bleibt grün.

**Parallel laufen** die Codex-Pakete M6 (`codex/m6-*`: tools, mcp, a2a, agent-bridge) und M3 (`codex/m3-*`: api chats/ws, remote-access, webauthn, Saga). Hotspots:
- die Chat-Routen aus M3 Phase 1 (für `/web`-Handoff, siehe Phase 5)
- `packages/core/src/channels/**` gegen Agent-Tools aus M6

Neue Logik kommt in neue Dateien, die Verdrahtung in kleine eigene Commits.

## Verbindliche Quellen

- `docs/milestones.md` §M4: Scope, Abnahme, Status 14.10., Direct-Chat-Continuity D93
- ADR-003 §„Behaviour profiles“ (vier Ebenen, monotoner Merge, Action 2), ADR-007 §„Pairing flow“ und Finding 1, ADR-009 §„Delivery“
- `docs/switchboard.md`, `docs/channels/*.md` (vor allem matrix.md §5), `docs/platform-matrix.md` §3 (WASM statt NAPI)
- `docs/superpowers/specs/2026-09-28-direct-chat-design.md` (Handoff)
- Code:
  - `packages/channels-{telegram,discord,matrix}/**`
  - `packages/core/src/channels/**`
  - Switchboard-Host
  - `packages/core/src/identity/**`
  - `packages/core/src/user-jobs/**` und `system-jobs/**`

## Owner-Defaults

Die folgenden Defaults gelten, bis Christian etwas anderes sagt. Abweichungen im PR als „Owner-Frage“ markieren.

- **Q4:** ein Agent, viele Bot-Verbindungen. Mention-Routing zwischen mehreren Agenten frühestens ab M6, hier nicht.
- **ADR-003 Q2:** keine fünfte Ebene pro Chat.
- **ADR-003 Q3:** Gruppen-Capture standardmäßig `provenance-only`.
- **Gruppen-Defaults:** `on-mention`, `provenance-only`, kein `captureOtherSpeakers`.
- **Pairing-Codes:** 8 Zeichen aus eindeutigem Alphabet, 1 h gültig, höchstens 3 offene, Rechte `0600`, offene Codes werden nie exportiert.

  Die Entropie der Codes ist eine offene Owner-Frage aus früheren Runden. Hier nicht ändern, nur dokumentieren.

## Regeln (wie bisher)

- Commits: `Cyb3rb1ade <cyb3rblade@me.com>` plus die bekannten Trailer.
- Kein Force-Push, Rebase, Amend oder `git stash`. CI nicht pollen.
- **Neue Abhängigkeiten nur aus dem M4-Scope**, exakt gepinnt:
  - `@matrix-org/matrix-sdk-crypto-wasm@18.9.0`: **WASM, nicht das NAPI-Paket**.
  - `nostr-tools` in der aktuell stabilen Version für Buzz. Version im PR begründen.
  - Prüfe zuerst, was im Matrix-Adapter schon verwendet wird; nichts doppelt einführen.
- Keine Engine-Änderungen.
  - **Engine-Blocker PR-06** (host-deklarierte `SUPPORTED_ROUTE_PROVIDERS` und trusted-command-Liste) liegt im Engine-Repo. Prüfe im Code, ob der Harness die Provider schon deklariert bzw. ob die angepinnte Engine das kann.
  - Wenn nicht, bekommen Matrix- und Buzz-Nutzer keinen Principal. Bau den Harness-Teil, schreibe einen KNOWN-GAP-todo-Test und dokumentiere den Blocker deutlich.
- Bereiche des Sonnet-Sicherheitspakets nur additiv ändern: `identity`, `switchboard*`, `channels-{slack,telegram,discord}/src`. Das Paket ist bisher nicht als PR erschienen; wenn es erscheint, normal nachmergen.
- Keine Sammelcodes wie `E_FOO_*` in der Doku. Keine token-artigen Literale. Tests nicht abschwächen.
- Eingehende Ereignisse sind immer nicht vertrauenswürdig. Es gilt deny-by-default: Ein Ereignis ohne passende Route wird verworfen und geloggt, nie gebroadcastet.

---

## Phase 1: Behaviour-Profile mit monotonem Merge über vier Ebenen (Kriterium 4)

Branch `codex/m4-p1-behaviour-merge`. Umfang etwa 4–5 Tage.

1. Behaviour-Profile `direct` und `group` werden über vier Ebenen gemergt: Global, Agent, Channel und Chat-Typ (genaue Ebenen nach ADR-003).
   - Verbote werden vereinigt: Was eine Ebene verbietet, bleibt verboten.
   - Scopes werden geschnitten: Eine Ebene kann nur einengen, nie erweitern.
   - Der Merge muss monoton sein.
   - Felder: `replyPolicy` (`always`, `on-mention`, `never`), `capture` (`full`, `provenance-only`, `none`), `captureOtherSpeakers`, erlaubte Commands, erlaubte Tools bzw. Capabilities, Rate-Grenzen.
2. Gruppen bekommen die ausgelieferten Defaults (siehe oben).
3. Alle Channel-Adapter (Telegram, Discord, Matrix, plus vorhandene Slack-, Signal- und E-Mail-Adapter) lesen das gemergte Profil aus **einer** Funktion im Core. Keine Adapter-eigene Logik mehr; doppelte Logik entfernen.
4. Config-Schema mit `x-write-roles` owner/admin und `x-audit`.
5. **Tests:**
   - Matrix 4 Ebenen × {direct, dm, group, channel} × 4 Channel-Arten.
   - Property-Tests für die Invarianten: Deny-Union und Scope-Schnitt.
   - Kein Profil darf je mehr erlauben als jede einzelne beteiligte Ebene.
6. Web: Unter Settings → Switchboard eine Profil-Ansicht pro Channel, die das effektive Profil mit Herkunft je Feld anzeigt. Nur Anzeige und Bearbeitung der eigenen Ebene. DE/EN.

## Phase 2: Matrix-E2EE mit Geräteverifikation (Kriterium 5)

Branch `codex/m4-p2-matrix-e2ee`. Umfang etwa 6–8 Tage.

1. E2EE mit `@matrix-org/matrix-sdk-crypto-wasm@18.9.0`, **ein WASM-Artefakt für alle fünf Targets**.
2. **Crypto-Store:**
   - Persistiert unter dem Harness-Home, Rechte 0600 bzw. Windows-ACL wie andere Stores.
   - Schlüssel über den Secret-Store, nie im Klartext in der Config.
   - Schreiben atomar mit fsync.
   - Ein Absturz mitten im Schreiben führt nicht zum Schlüsselverlust (Test).
3. **Geräteverifikation:**
   - SAS (Emoji bzw. Dezimal) über die bestehenden Owner-Kanäle bzw. die Web-UI.
   - Cross-Signing-Bootstrap mit Owner-Bestätigung.
   - Unverifizierte Geräte: konfigurierbar, Default „Nachrichten von unverifizierten Geräten verwerfen und melden“.
4. **Raum-Verhalten:**
   - Verschlüsselte Räume werden jetzt bedient, statt wie bisher abgelehnt zu werden.
   - Die bekannte Lücke aus Audit d07 schließen: Nach einem Neustart fehlt im ersten Sync der `m.room.encryption`-State, und Klartext-Nachrichten in einem eigentlich verschlüsselten Raum würden verarbeitet. Lösung: State pro Raum abrufen bzw. persistieren. Klartext in verschlüsselten Räumen wird verworfen.
   - Zweite Lücke aus d07: Dedupe nach einem Absturz zwischen Handler und `save(next_batch)`. Persistentes Dedupe im Sync-State ist erlaubt; das ist eine Formatänderung mit Migration.
5. **Schlüssel-Backup** (falls der Server es anbietet): nur mit Owner-Bestätigung, der Recovery-Key wird dem Owner einmal gezeigt und nie geloggt.
6. **Tests:**
   - Fake-Homeserver mit verschlüsselten Räumen: senden, empfangen, Gerät verifizieren, unverifiziertes Gerät abweisen, Schlüsselrotation.
   - Neustart mit Crypto-Store.
   - Klartext im verschlüsselten Raum wird verworfen.
   - Die bestehenden Härtungen aus #476 (Markdown-Tiefe, Event-Größe, mxc, Mentions) bleiben grün.
7. Doku: `docs/channels/matrix.md` §5 neu schreiben, Setup DE/EN.

## Phase 3: Buzz/Nostr-Adapter (Kriterium 1, Teil 2)

Branch `codex/m4-p3-buzz`. Umfang etwa 4–6 Tage.

1. Neues Paket `packages/channels-buzz` mit `nostr-tools`, gleiche Schnittstelle wie die anderen Adapter (Manifest, Lifecycle, Health, Contract-Suite).
2. **Relays:**
   - Mehrere Relays mit Reconnect, Backoff und Jitter.
   - Nur `wss://`, außer Loopback.
   - Egress-Policy gilt.
3. **Nachrichten:**
   - DMs nach dem aktuellen NIP für verschlüsselte DMs; der Adapter unterstützt nur das, was im Scope und in der Phase-0-Recherche festgelegt ist.
   - Signatur jedes eingehenden Events prüfen.
   - Kind- und Größenlimits, Dedupe über die Event-ID.
4. **Schlüssel:**
   - Der Bot-Schlüssel liegt im Secret-Store, ist nie in Logs zu sehen und wird bei jeder Fehlerausgabe redigiert.
   - Absender-Allowlist über Pubkeys (hex bzw. npub normalisiert).
5. **Principal:** über Pairing (wie bei den anderen Channels). Ohne Engine PR-06 siehe Blocker oben: KNOWN GAP plus deutliche Meldung.
6. **Tests:**
   - Fake-Relay: Signatur gefälscht, Event zu groß, Replay, Relay-Abbruch, unbekannter Absender.
   - Contract-Suite wie bei den anderen Adaptern.
7. **Kriterium 1:** ein Cross-Channel-Persona-Test, derselbe Agent mit derselben Persona auf Telegram, Discord, Matrix und Buzz gegen Fakes.
8. Doku: `docs/channels/buzz.md` sowie Setup DE/EN.

## Phase 4: Identität kanalübergreifend und Cron-Zustellung (Kriterien 2, 3)

Branch `codex/m4-p4-identity-delivery`. Umfang etwa 3–4 Tage.

1. **Kriterium 2:**
   - Test: Eine verknüpfte Person ist auf zwei Channels derselbe Principal, gleiche Recall-Union.
   - Eine nicht verknüpfte Person ist das nicht (fail-closed nach ADR-007).
   - Mit echtem Pairing-Flow, kein Shortcut im Test.
2. **Kriterium 3, Zustellung von Cron- und Feature-Ergebnissen:**
   - Wiederkehrende Jobs (user-jobs, system-jobs, Dreams) können an **validierte** Ziele zustellen.
   - Validiert heißt: Das Ziel wurde vom Owner bzw. von der berechtigten Person bestätigt, steht auf der Allowlist und ist an einen Principal gebunden.
   - Unvalidierte Ziele werden abgewiesen und auditiert.
   - Die `runAs`-Regel aus #426 gilt: Zustellung nur an Ziele, die `runAs` sehen darf.
3. **Zielverwaltung:**
   - RPC zum Hinzufügen, Bestätigen und Entfernen von Zustellzielen; bestätigt wird über eine Nachricht im Ziel-Channel mit Einmalcode.
   - Web-Ansicht unter Recurring als Ziel-Auswahl im Job-Editor.
4. **Tests:**
   - Zustellung an ein validiertes Ziel.
   - Unvalidiertes Ziel wird abgewiesen.
   - Ziel einer anderen Person wird abgewiesen.
   - Entzogene Validierung stoppt künftige Zustellungen.

## Phase 5: `/web`-Handoff und Kanal-DMs im Web (D93)

Branch `codex/m4-p5-web-handoff`. Umfang etwa 1–2 Tage. Braucht die Chat-Routen aus dem M3-Paket, Phase 1. Ist dieser PR noch nicht gemergt, normal hineinmergen bzw. als Draft darauf aufbauen.

1. `/web` in jedem Channel liefert einer verknüpften Person einen **Einmal-Link**:
   - kurze Gültigkeit
   - an die Person gebunden
   - nach Gebrauch verbraucht
   - nie in Logs
2. Der Link öffnet einen neuen Web-Chat, vorbefüllt mit einer Zusammenfassung des Channel-Verlaufs.
3. Die Channel-DMs der Person erscheinen im Web-Chat-Verlauf nur lesend, mit „In Web fortsetzen“.
4. Für nicht verknüpfte Personen gibt es keinen Link, nur einen Hinweis auf das Pairing.
5. **Tests:**
   - Link einmalig.
   - Fremde Person kann den Link nicht nutzen.
   - Abgelaufener Link wird abgewiesen.
   - Kanal-DMs erscheinen nur bei der eigenen Person.

---

## Abschluss je Phase

PR mit Conventional-Commit-Titel und Handoff mit folgenden Teilen:
- Inventar
- Entscheidungen
- Bedrohungstabelle (Angriff → Schutz → Test)
- Verhaltensänderungen
- Owner-Fragen
- Konflikt-Hotspots
- ehrliche Validierung
- KNOWN-GAP-todos

Am Ende von Phase 5 zusätzlich:
- `docs/milestones.md` §M4 im Stil des Abgleichs vom 14.10. aktualisieren. „Erfüllt“ nur mit benanntem Test.
- Demo-Anleitung `docs/demos/m4.md`: ein Agent auf vier Channels, Pairing, Cron-Zustellung, E2EE-Verifikation.