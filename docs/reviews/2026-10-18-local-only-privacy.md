# Unabhängiges Review: „Nur lokal“ und Egress (#570, #509)

| | |
|---|---|
| **Thema** | „Nur lokal“ (`privacy.localOnly`), Reranker-Datenschutzbestätigung und Egress-Prüfung (#570, #509) |
| **Geprüfter Commit / Branch** | PR #509 gemergt auf `origin/main` @ `2b5a435c0`; PR #570 auf Branch `origin/feat/local-only-privacy` @ `4330a11e1` |
| **Datum** | 2026-10-18 |
| **Reviewer** | agy (unabhängiger Reviewer; hat den Code nicht verfasst) |
| **Empfehlung an den Owner** | **abnahmefähig mit Auflagen** (Keine Blocker; 2 Minor-Befunde zu Discovery-Scans und Engine-Startup-Egress) |

---

## 1. Übersicht und Abnahmekriterien

Gemäß Owner-Entscheidung vom 18.10.2026 blockiert der Schalter „Nur lokal“ (`privacy.localOnly`, installationsweit oder mit Agenten-Override via `agents.<id>.privacy.localOnly`) jeden Modell- und Inferenzaufruf, der die Maschine verlässt.
Über `privacy.localEndpoints` können selbst gehostete Heimserver (z. B. Ollama auf LAN-Host) explizit freigegeben werden. Web-Tools (`web.fetch`, `web.search`) gelten nicht als Modellaufrufe und verbleiben unter der Hoheit der regulären Egress-Richtlinie.

### Abnahmekriterien & Prüfpunkte:
1. **Lückenlose Durchsetzung an allen Modell-Stellen:**
   - Embedding & Reranker: `resolveEmbeddingProvider`, `resolveRerankerProvider` rufen `assertLocalEndpoint` auf. (Erfüllt)
   - Engine-LLM-Features: `assertEngineFeaturesLocal` durchsucht die Konfiguration rekursiv und sperrt Cloud-Ziele. (Erfüllt)
   - Chat & Rollen-Modelle: `composeTurnProvider` (`provider.ts`) prüft `localOnly && !isLocal(candidate.provider)` vor Turn und Budget. (Erfüllt)
   - Voice: `voice/v2.ts` erzwingt bei `localOnly` die lokale Stufe (Whisper/Ollama local). (Erfüllt)
   - Captioning & Media: `composition/media.ts` prüft `localOnly` vor Bildgenerierung und -editierung. (Erfüllt)
   - Discovery-Probe & Scans: (**Lücke**, siehe m1)
2. **Robustheit von `privacy.localEndpoints` (DNS-Rebinding & IP-Mapping):**
   - `isLoopbackEndpoint` prüft rein lexikalisch auf `localhost`, `::1` und `127.0.0.0/8`. Keine Namensauflösung im Check.
   - IPv4-mapped IPv6 (`::ffff:127.0.0.1`) oder manipulierte Hostnamen werden **nicht** als Loopback anerkannt. (Erfüllt)
3. **Egress-Prüfung beim Start:** `checkEngineEgress` prüft `egress.decide` für Engine-Modell-Endpunkte. (Erfüllt, aber Einschränkung bei Offline-Start, siehe m2)
4. **Schlüssel in der Konfiguration:** `apiKey` im Klartext wird strikt verweigert (`secret-in-config`), nur `apiKeyEnv` / `apiKeyRef` erlaubt. (Erfüllt)

---

## 2. Ausgeführte Tests & Verifikation

Lokal auf Branch `feat/local-only-privacy` ausgeführt:
- `packages/config-schema/test/privacy-local-only.test.ts` (14 Tests, alle bestanden)
- `packages/core/test/privacy/local-only.test.ts` (12 Tests, alle bestanden)
- `packages/core/test/privacy/enforcement.test.ts` (22 Tests, alle bestanden)
- `packages/core/test/engine-config.test.ts` (34 Tests, alle bestanden)
- `packages/core/test/egress/service.test.ts` (28 Tests, alle bestanden)

---

## 3. Befunde

### Blocker
Keine.

### Major
Keine.

### Minor / Nit

#### m1 (Minor) — Discovery-Scanner sendet API-Aufrufe an Cloud-Provider trotz aktivem „Nur lokal“ (`packages/core/src/discovery/service.ts:120-228`)
- **Datei:Zeile:** `packages/core/src/discovery/service.ts:120-228`, `packages/core/src/core.ts:548`
- **Begründung:**
  In PR #570 wurde `modelLocked` in den Discovery-Service eingefügt. Dieses Flag wird jedoch **ausschließlich** in `discovery.list()` ausgewertet, um Modelle in der Benutzeroberfläche mit dem Status `{ locked: "local-only" }` zu versehen.
  Die eigentliche Scan-Funktion `scanProvider(provider)` prüft `privacy.localOnly` **nicht**. Wenn Discovery aktiviert ist (per Hintergrund-Job oder manueller Trigger `models scan`), baut `createPinnedClient` weiterhin HTTP-Verbindungen zu Cloud-Endpunkten (z. B. `api.openai.com`, OpenRouter) auf, um den Modellkatalog abzurufen.
  Auch wenn dabei keine Chat-Prompts übertragen werden, verlassen ausgehende Metadaten- und Authentifizierungs-Requests das System in Richtung Cloud.
- **Auflage / Empfehlung:** Bei aktivem `privacy.localOnly` sollte `scanProvider` für Provider, deren `baseUrl` nicht in `localEndpoints` liegt, mit einem entsprechenden Status (z. B. `skipped: local-only`) übersprungen werden.

#### m2 (Minor) — Engine-eigene Modellaufrufe prüfen Egress nur beim Start und tolerieren Offline-Zustände (`packages/core/src/engine-config.ts:70-79`)
- **Datei:Zeile:** `packages/core/src/engine-config.ts:70-79`
- **Begründung:**
  Da die Memory-Engine (Stand Contract 1.12.0) noch keinen eigenen Fetch-Port für `egress.request` besitzt, wird die Egress-Prüfung in `checkEngineEgress` nur einmalig beim Start des Cores via `egress.decide(endpoint)` durchgeführt.
  Hierbei existieren zwei Schwachstellen:
  1. Kann ein Hostname beim Start nicht aufgelöst werden (`d.reason === "not-found"`, z. B. bei Offline-Start), wird lediglich eine Warnung geloggt und der Start zugelassen. Geht der Rechner später online, sendet die Engine Requests an den ungeprüften Host.
  2. Features, die einen Provider-Schlüssel (`apiKeyEnv`), aber keine explizite `baseUrl` definieren (und den Cloud-Default des Anbieters nutzen), werden übersprungen (`endpoint === undefined`) und nur geloggt.
- **Auflage / Empfehlung:** Bis zur Bereitstellung eines echten Fetch-Ports in der Engine sollte der Offline-Start für Cloud-Endpunkte als Risiko dokumentiert oder Fail-Closed gestaltet werden.

#### m3 (Nit) — DNS-Rebinding auf selbst gelistete Hostnamen in `localEndpoints`
- **Datei:Zeile:** `packages/core/src/privacy/local-only.ts:60`
- **Begründung:** Trägt ein Nutzer einen Domainnamen (z. B. `my-server.local`) in `privacy.localEndpoints` ein, wird der Origin-Match lexikalisch durchgeführt. Da die Engine ihre Verbindungen ohne IP-Pinning aufbaut, könnte ein Angreifer im lokalen Netz über DNS-Rebinding theoretisch die Ziel-IP ändern. (Geringes Risiko bei reinen IP-Adressen in `localEndpoints`).

---

## 4. Fazit und Empfehlung

Die Implementierung von „Nur lokal“ in PR #570 ist methodisch sauber, verwendet eine zentrale Validierungslogik (`assertLocalEndpoint`, `isLocalEndpoint`) und schützt alle primären Inferenz- und Speicherkreise zuverlässig.
**Empfehlung: Abnahmefähig mit Auflagen** (Auflagen m1 und m2 für nachfolgende Phasen festhalten).
