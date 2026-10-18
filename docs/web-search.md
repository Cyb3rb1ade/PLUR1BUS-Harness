# Web search: providers and setup / Websuche: Anbieter und Einrichtung

Hand-written. Code: `packages/core/src/tools/web/search*.ts`, `packages/core/src/sidecars/web-search*.ts`. Spec: D95
(`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`); acceptance: `docs/milestones.md` §M2 item 13.
Tool contract, result format and the SSRF guard: [web-tools.md](web-tools.md). Egress policy: [egress.md](egress.md).
SearXNG sidecar: [sidecars.md](sidecars.md).

Deutsch weiter unten: [Deutsch](#deutsch).

## English

`web.search` is one tool over pluggable providers. Every provider returns the same result format (title, URL, snippet,
source host, optional publication time) and the answer names the provider that produced it.

| Provider | Id | Needs | Reaches |
|---|---|---|---|
| SearXNG (your own instance) | `searxng` | `sidecars.searxng` (bundled or remote) | the sidecar only, over a private or tailnet address |
| Brave Search API | `brave` | an API key in the secret store | `api.search.brave.com` |
| Tavily | `tavily` | an API key in the secret store | `api.tavily.com` |
| Exa | `exa` | an API key in the secret store | `api.exa.ai` |

### Setup in three steps

1. **Store the key.** The value is read from stdin and never appears in a command line, a URL, a log or an error:

   ```sh
   plur1bus secret set web-search.brave      # then paste the key and press Ctrl-D
   plur1bus secret set web-search.tavily
   plur1bus secret set web-search.exa
   ```

   The default secret names are `web-search.<provider>`; `keys.<provider>` below points a provider at another name.
2. **Allow the host.** Egress is default-deny, so the provider's host must be listed:
   `egress.allowHosts` has to contain `api.search.brave.com`, `api.tavily.com` and/or `api.exa.ai`
   (port 443 is allowed by default). Without it a search fails with `egress-denied`, naming the host.
3. **Choose providers.** Add the section `modules.web-search` to `config.json` (it applies live; there is no schema
   change, the free-form per-module section is used):

   ```json
   {
     "modules": {
       "web-search": {
         "providers": ["searxng", "brave"],
         "agents": {
           "researcher": { "providers": ["exa", "tavily"] },
           "offline-helper": { "providers": [] }
         },
         "keys": { "brave": "web-search.brave" },
         "timeoutMs": 10000,
         "minIntervalMs": { "brave": 1000 }
       }
     }
   }
   ```

| Key | Meaning |
|---|---|
| `providers` | Fallback order for every agent. Absent: `["searxng"]`, the behaviour before the keyed providers existed. |
| `agents.<id>.providers` | Replaces that order for one agent. An empty list switches web search off for it (`no-provider`). |
| `keys.<provider>` | Name of the secret that holds the key. Default `web-search.<provider>`. |
| `timeoutMs` | Limit per provider, 1000 to 60000. Default 10000. |
| `minIntervalMs.<provider>` | Minimum spacing between two requests to that provider, 0 to 60000. Default 0. |
| `enabled` | `false` switches the tool off (`no-provider`). |

Unknown provider ids and malformed entries are ignored, never guessed at; they are reported by the core's provider
listing (`providers()` in `web-search-router.ts`).

### Per agent, not per turn

The provider is an agent setting (D95, ADR-010 R4). The list chosen for an agent in a session stays for that session; a
configuration change applies from the next session. A failing provider is skipped, the next in the list answers, and the
result names the provider used and the skipped ones (ids and reasons, never error text).

### No provider

When nothing usable is configured (no `modules.web-search` and the SearXNG sidecar off, an empty list for the agent,
`enabled: false`, or every listed provider without a key) the tool fails with `no-provider` and the hint to use
`web.fetch` on a known URL. When providers are listed but all of them fail, the error is `provider-failed` with the
provider ids and failure codes; a single failing provider reports its own typed failure.

### Keys, limits and failures

* The key is read from the secret store for each search (a rotation applies at once), travels only in a request header
  (`X-Subscription-Token`, `Authorization: Bearer`, `x-api-key`) and is scrubbed from every failure text. Traces carry
  the provider id, counts, timings and failure codes, never the query, the results or a key.
* Timeouts: the per-provider limit above, and one deadline per HTTP call. Answers are capped at 2 MiB, never compressed,
  redirects are not followed.
* **401/403** is `http-error` naming the key problem. **429** is `rate-limited` with `retryAfterSeconds` from the
  `Retry-After` header (HTTP date or seconds, capped at one hour; Brave's `X-RateLimit-Reset` is the fallback; 30 s if
  there is none). A wait of up to 2 s is served once inside the call; a longer one starts a cooldown, during which the
  provider is not contacted and fails fast with the remaining time, and the next provider in the list answers.
  Plan-quota answers (402, 432, 433) are `rate-limited` too. **5xx**, broken JSON and an unexpected answer shape are
  `http-error`.
* Egress policy applies to every call: host allowlist, `https` only, SSRF range check, connect pinned to the vetted
  address (no rebinding). SearXNG keeps its narrower sidecar rule.

### Tests

`packages/core/test/tools/web/search-providers.test.ts` (recorded fixtures: normalisation, 401, 429 with Retry-After,
5xx, broken JSON, empty answers, key redaction), `search-http.test.ts` (egress, pinning, caps, deadlines),
`packages/core/test/sidecars/web-search-router.test.ts` (selection per agent, session snapshot, fallback, `no-provider`,
keys). Fixtures in `packages/core/test/fixtures/web-search/` are hand-written JSON in each vendor's documented format:
no real keys, no real data. They have not been compared with a live account (see Open).
`packages/core/test/live/web-search-searxng.test.ts` runs in the nightly workflow only when the repository variable
`PLUR1BUS_SEARXNG_LIVE_URL` is set (a private, tailnet or loopback address); otherwise the job is skipped. It does not
gate anything.

### Open

* **Native search** (the model provider's own search tool) is not built. D95 names it, but the spec does not say which
  providers expose it, how a call is paid for or how its citations map to the result format. It needs a decision.
* The vendor mappings follow the documented API formats; no live key was available, so no live smoke has run for Brave,
  Tavily or Exa. Vendors can change fields; a live nightly with owner-held keys is the follow-up.
* `modules.web-search` is a pragmatic home. A first-class `webSearch` configuration section (with settings UI and
  schema validation) would touch the config schema, the Rust crate and the generated settings index.
* Provider state (cooldown, key present) is available in the core but not yet on an RPC or in the doctor report.
* Tavily and Exa have no language parameter in this mapping; `lang` is applied by Brave and SearXNG only.

## Deutsch

`web.search` ist ein Werkzeug über austauschbare Anbieter. Jeder Anbieter liefert dasselbe Ergebnisformat (Titel, URL,
Auszug, Quell-Host, optional Veröffentlichungszeit); die Antwort nennt den Anbieter, der sie geliefert hat.

| Anbieter | Id | Voraussetzung | Ziel |
|---|---|---|---|
| SearXNG (eigene Instanz) | `searxng` | `sidecars.searxng` (gebündelt oder remote) | nur der Sidecar, über eine private oder Tailnet-Adresse |
| Brave Search API | `brave` | API-Schlüssel im Secret-Store | `api.search.brave.com` |
| Tavily | `tavily` | API-Schlüssel im Secret-Store | `api.tavily.com` |
| Exa | `exa` | API-Schlüssel im Secret-Store | `api.exa.ai` |

### Einrichtung in drei Schritten

1. **Schlüssel ablegen.** Der Wert wird von stdin gelesen und erscheint nie in einer Kommandozeile, URL, einem Log oder
   einer Fehlermeldung:

   ```sh
   plur1bus secret set web-search.brave      # Schlüssel einfügen, dann Strg-D
   plur1bus secret set web-search.tavily
   plur1bus secret set web-search.exa
   ```

   Die Standardnamen sind `web-search.<anbieter>`; mit `keys.<anbieter>` (unten) zeigt ein Anbieter auf einen anderen Namen.
2. **Host erlauben.** Egress ist standardmäßig gesperrt, der Host des Anbieters muss in `egress.allowHosts` stehen:
   `api.search.brave.com`, `api.tavily.com` und/oder `api.exa.ai` (Port 443 ist standardmäßig erlaubt). Ohne Eintrag
   scheitert die Suche mit `egress-denied` und nennt den Host.
3. **Anbieter wählen.** Den Abschnitt `modules.web-search` in `config.json` ergänzen (wirkt sofort; es gibt keine
   Schema-Änderung, genutzt wird der freie Abschnitt je Modul). Beispiel siehe oben im englischen Teil; die Schlüssel:

| Schlüssel | Bedeutung |
|---|---|
| `providers` | Ausweichreihenfolge für alle Agenten. Fehlt er: `["searxng"]`, das Verhalten vor den Schlüssel-Anbietern. |
| `agents.<id>.providers` | Ersetzt diese Reihenfolge für einen Agenten. Eine leere Liste schaltet die Websuche für ihn ab (`no-provider`). |
| `keys.<anbieter>` | Name des Secrets mit dem Schlüssel. Standard `web-search.<anbieter>`. |
| `timeoutMs` | Limit je Anbieter, 1000 bis 60000. Standard 10000. |
| `minIntervalMs.<anbieter>` | Mindestabstand zwischen zwei Anfragen an diesen Anbieter, 0 bis 60000. Standard 0. |
| `enabled` | `false` schaltet das Werkzeug ab (`no-provider`). |

Unbekannte Anbieter-Ids und fehlerhafte Einträge werden ignoriert, nie geraten, und über die Anbieterliste des Kerns
gemeldet (`providers()` in `web-search-router.ts`).

### Pro Agent, nicht pro Zug

Der Anbieter ist eine Agenten-Einstellung (D95, ADR-010 R4). Die für einen Agenten in einer Sitzung gewählte Liste bleibt
für diese Sitzung; eine Konfigurationsänderung gilt ab der nächsten Sitzung. Ein ausfallender Anbieter wird übersprungen,
der nächste der Liste antwortet; das Ergebnis nennt den genutzten und die übersprungenen Anbieter (Ids und Gründe, nie
Fehlertext).

### Kein Anbieter

Ist nichts Nutzbares konfiguriert (kein `modules.web-search` bei ausgeschaltetem SearXNG-Sidecar, eine leere Liste für
den Agenten, `enabled: false` oder jeder gelistete Anbieter ohne Schlüssel), scheitert das Werkzeug mit `no-provider` und
dem Hinweis, `web.fetch` auf eine bekannte URL zu nutzen. Sind Anbieter gelistet und scheitern alle, lautet der Fehler
`provider-failed` mit Anbieter-Ids und Fehlercodes; ein einzelner ausfallender Anbieter meldet seinen eigenen Fehler.

### Schlüssel, Grenzen und Fehler

* Der Schlüssel wird bei jeder Suche aus dem Secret-Store gelesen (eine Rotation gilt sofort), läuft nur in einem
  Request-Header (`X-Subscription-Token`, `Authorization: Bearer`, `x-api-key`) und wird aus jedem Fehlertext entfernt.
  Traces enthalten Anbieter-Id, Zahlen, Zeiten und Fehlercodes, nie Anfrage, Ergebnisse oder Schlüssel.
* Zeitlimits: das Limit je Anbieter (oben) und eine Frist je HTTP-Aufruf. Antworten sind auf 2 MiB begrenzt, nie
  komprimiert, Weiterleitungen werden nicht verfolgt.
* **401/403** ist `http-error` mit Hinweis auf den Schlüssel. **429** ist `rate-limited` mit `retryAfterSeconds` aus dem
  Header `Retry-After` (Sekunden oder HTTP-Datum, höchstens eine Stunde; Ersatz ist Braves `X-RateLimit-Reset`; 30 s,
  wenn nichts da ist). Eine Wartezeit bis 2 s wird einmal im Aufruf abgewartet; eine längere startet eine Abkühlzeit, in
  der der Anbieter nicht angefragt wird und sofort mit der Restzeit scheitert, und der nächste Anbieter der Liste
  antwortet. Tarif-Kontingent-Antworten (402, 432, 433) sind ebenfalls `rate-limited`. **5xx**, kaputtes JSON und eine
  unerwartete Antwortform sind `http-error`.
* Die Egress-Richtlinie gilt für jeden Aufruf: Host-Erlaubnisliste, nur `https`, SSRF-Adressprüfung, Verbindung auf die
  geprüfte Adresse festgelegt (kein Rebinding). SearXNG behält seine engere Sidecar-Regel.

### Tests

Siehe den englischen Teil. Die Fixtures unter `packages/core/test/fixtures/web-search/` sind selbst geschriebenes JSON im
dokumentierten Format des jeweiligen Anbieters: keine echten Schlüssel, keine echten Daten. Der nächtliche Live-Test
gegen SearXNG läuft nur, wenn die Repository-Variable `PLUR1BUS_SEARXNG_LIVE_URL` gesetzt ist (private, Tailnet- oder
Loopback-Adresse); sonst wird der Job übersprungen. Er blockiert nichts.

### Offen

* **Native Suche** (das Suchwerkzeug des Modellanbieters) ist nicht gebaut. D95 nennt sie, die Spezifikation legt aber
  nicht fest, welche Anbieter sie bieten, wie sie abgerechnet wird und wie ihre Quellenangaben auf das Ergebnisformat
  abgebildet werden. Dafür fehlt eine Entscheidung.
* Die Anbieter-Abbildungen folgen den dokumentierten API-Formaten; es stand kein Live-Schlüssel zur Verfügung, daher lief
  kein Live-Smoke für Brave, Tavily oder Exa. Folgearbeit: nächtlicher Live-Lauf mit Schlüsseln des Owners.
* `modules.web-search` ist ein pragmatischer Ort. Ein eigener Konfigurationsabschnitt `webSearch` (mit Einstellungsseite
  und Schema-Prüfung) berührt Config-Schema, Rust-Crate und den generierten Einstellungsindex.
* Der Anbieterzustand (Abkühlzeit, Schlüssel vorhanden) ist im Kern abrufbar, aber noch nicht über RPC oder den Doctor-Bericht.
* Tavily und Exa haben in dieser Abbildung keinen Sprachparameter; `lang` wirkt nur bei Brave und SearXNG.
