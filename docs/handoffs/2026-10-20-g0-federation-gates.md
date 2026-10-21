# Großpaket 4 G0: Föderations-Gates

Stand: 20.10.2026. Geprüfte Basis: `origin/main` =
`31f8dd62cb1bf022ae99cae58a9538e38df5c918`. Dies ist eine Bestandsaufnahme für G1–G4,
keine Implementierung oder Freigabe der Föderationslaufzeit. Ein gemergter PR belegt die
Verfügbarkeit seines Codes auf dieser Basis; er ersetzt keine fachliche oder reale Netzabnahme.

Verbindlich sind die [Föderations-Spec](../superpowers/specs/2026-10-19-federation-cluster-design.md)
(D114, §3, §7.3, §15), der [Föderationsplan](../superpowers/plans/2026-10-19-federation-cluster.md)
(S0, WP2–WP4, WP12 und Abhängigkeitstabelle) und die
[D116-Spec](../superpowers/specs/2026-10-20-memory-tree-relationships-design.md) (§12, Punkt 9).
Ihre letzte gemeinsame Änderung auf der geprüften Basis ist
`23ffedb2ad878878412e1fd3672289f262a62b4f`.
Die Voraussetzungstabelle der Föderations-Spec beschreibt ausdrücklich den älteren Stand
`dcab21bc`; die folgende Tabelle aktualisiert den Befund, ohne diese historische Tabelle umzudeuten.

## Entscheidung für die nächsten Pakete

| Phase | Status | Wartet auf / startbarer Umfang |
|---|---|---|
| G1 = WP2 Identität, Pairing, Peer-Principal | **wartet auf** | Föderations-S0 mit dokumentierten Ergebnissen sowie P9-Abstimmung und Vertrag für `peer` in RBAC und RPC-Identität. M3-Pairing und Secret-Store sind als Grundlage vorhanden. Der WP2-Code soll `peer` anschließend additiv umsetzen; die heutige Art `a2a-peer` im D109-Evaluator erfüllt P9 nicht. |
| G2 = WP3 Transport, Egress, Limits | **wartet auf** | G1/WP2, Föderations-S0 und Großpaket 2 **Phase P** auf `main`. P7 ist erfüllt. Der Plan nennt Phase P ausdrücklich als Voraussetzung; G2 ist deshalb kein unabhängiger Ready-PR auf der geprüften Basis. Ein Draft-Stack ist erst auf einem konkreten Phase-P-PR sinnvoll. Bei dieser Prüfung wurde kein offener Phase-P-PR identifiziert. |
| G3 = WP4 Projektfreigabe | **wartet auf** | G1/WP2 und G2/WP3. M5-Basis und #570-Durchsetzung liegen auf `main`; neue Share-Pfade brauchen trotzdem eigene Privacy-, Objekt- und Erinnerungsgrenzen-Tests. |
| G4 = WP12-Vorarbeit | **startbar** | Nur Datenmodell, Lease-Regeln, Fakes und Tests gemäß Großpaket 4. Keine aktive Leihe, keine Modell-/Toolaufrufe und kein Transport. Die Laufzeit wartet auf WP3/WP4 und D116 C3/C4 auf `main` sowie die vollständigen WP12-Voraussetzungen einschließlich P8. |

Der konkrete nächste Schritt für den Föderationsstart ist S0 mit Ergebnisprotokoll und
die Abstimmung des P9-Vertrags mit den RBAC-Verantwortlichen. Parallel ist der begrenzte
G4-Modellteil möglich. WP1, WP5–WP11, WP13 und WP14 sind nicht Teil dieses Pakets;
M6 N/O und D115 werden dadurch nicht als erledigt erklärt. Für WP14 bleiben insbesondere
die D115-Unterprojekte, Berichtskanal und Isolation gesonderte Voraussetzungen.

## Prüfung der einzelnen Gates

| Gate | Befund auf der geprüften Basis | Beleg und verbleibende Grenze |
|---|---|---|
| Föderations-S0 | **offen** | Es gibt den Spike-Auftrag im Föderationsplan, aber keinen Ergebnisbericht im versionierten Baum. Die Suche nach `fed-s0`/Föderations-Handoffs und die Pfadinventur ergeben nur Spec und Plan. SSH-S0 aus #592 ist ein anderer Spike und schließt dieses Gate nicht. |
| P7: POST über `egress.request` | **vorhanden** | #570 liefert POST; #574 stellt A2A-Push und OAuth-POST um. `packages/core/src/egress/service.ts` reicht Methoden, Header und begrenzte Bodies an den bewachten HTTP-Client weiter; `packages/core/src/a2a/push.ts` und `packages/core/src/auth/http.ts` nutzen `request`. `packages/core/test/egress/post-paths.test.ts` enthält den Socket-Guard. Die per Peer begrenzte LAN-/Tailnet-Ausnahme ist weiterhin S0/WP3-Arbeit: `Egress.decide` nimmt heute nur die URL an, private Netze bleiben gesperrt. |
| P9: RBAC-Art `peer` und RPC-Identität | **offen** | `packages/core/src/rbac/types.ts` enthält `PRINCIPAL_KINDS = ["person", "agent"]`; `$defs.CallerIdentity` in `packages/rpc-schema/schema/rpc.schema.json` kennt nur den CLI-Kanal. WP2 nennt die erforderlichen RBAC-/Schemaänderungen. Der D109-Subject `a2a-peer` in `packages/core/src/policy/decide.ts` ist ein anderer Vertrag und wird derzeit mit `surface-untrusted` abgelehnt. Kein bestehender Peer-Grant kann daher als Implementierung dieses Gates gelten. |
| M3-Pairing (P5, wiederverwendbare Grundlage) | **vorhanden, Abnahme begrenzt** | `packages/remote-access/src/pair-code.ts`, `pair-proof.ts`, `device-store.ts`; `packages/api/src/remote-pairing-controller.ts` und `remote-pairing-routes.ts` verdrahten Code, TLS-Origin, Pair-Proof und DeviceStore. #291/#352 sind gemergt. [Remote-Zugriff](../remote-access.md) beschreibt API-Integration und verbleibende Desktop-Abnahme. Dies ist Device-Pairing, noch kein gegenseitig bestätigtes Instanz-Pairing mit SAS, PeerStore und Peer-Principal. Reale Zwei-Maschinen-/Tailnet-Föderationsabnahme ist offen. |
| M5 auf `main` (P4) | **Basis vorhanden** | #510/#514/#515/#516/#520 sind gemergt. `packages/core/src/collab/target.ts`, `handoff.ts`, `store.ts`, `runner.ts`, `service.ts`, `verifier.ts`, `chat-promotion.ts` und [M5-Doku](../collaboration.md) belegen Ziele, D104, Sessions, Trace und Budgetpfade. `DelegationTarget.kind` bleibt `local \| external \| a2a`; Föderationsziel `peer` ist noch hinzuzufügen. Fan-out bleibt aus; Fake-Evaluation ist kein Beleg für Qualität mit echten Modellen. D115-Projektgedächtnis wird hier nicht mitbehauptet. |
| #570: `localOnly`-Durchsetzung (P6) | **Grundlage vorhanden** | `packages/core/src/privacy/local-only.ts` entscheidet installations-/agentenbezogen und über exakte `privacy.localEndpoints`; #570 ist gemergt. Eine LAN-Adresse allein wird nicht lokal. Föderationspfade existieren noch nicht: `localForPrivacy` muss dort explizit und standardmäßig aus sein; beim Wechsel sind Peer-/Share-/Mission-Pfade erneut zu prüfen. Die vorhandene Durchsetzung ist keine fertige Peer-Privacy-Abnahme. |
| Phase P / P3 | **offen** | [A2A-Doku](../a2a.md), `packages/core/src/a2a/types.ts` (`A2A_PROTOCOL_VERSION = "0.3.0"`), `server.ts` und `packages/core/src/session/types.ts` belegen den heutigen Inbound-/Loopback-Stand. `packages/api/src/server.ts` bindet A2A nicht ein; der dedizierte Session-Kind `a2a` fehlt. Outbound 1.0.0, signierte Karte, dauerhafter Task-Store und API-Binding sind weiterhin Phase-P-Arbeit. #574 macht Push-POST zentral, aber nicht aus A2A 0.3.0 die Phase-P-Laufzeit. |

### Was S0 noch nachweisen muss

Der Plan nennt fünf konkrete Prüfungen (auch wenn sein Einleitungssatz von vier Unbekannten spricht):

1. SDK `@a2a-js/sdk` 1.2.0: A2A-1.0.0-Karte, `capabilities.extensions`, eigene JSON-RPC-Methoden;
   Entscheidung gemeinsamer Endpunkt oder `/federation/v1`.
2. Zwei Cores hinter `tailscale serve`: SSE ohne Pufferung und gemessene Zeit bis zum ersten Ereignis.
3. Ed25519-Challenge mit TLS-Kanalbindung; hinter dem Proxy gegebenenfalls API-Session und Nonce,
   auf direktem TLS-Listener exportiertes Schlüsselmaterial.
4. Je Peer gepinnte Egress-Ausnahme für Tailnet `100.64.0.0/10` und RFC-1918-Adressen,
   ohne allgemeine Lockerung der SSRF-Regeln.
5. ACP-Erweiterungen `_plur1bus/*` und `_meta` gegen den vorgesehenen ACP-Client.

G0 hat keine dieser Messungen ausgeführt. Ein künftiger S0-Bericht muss je Prüfung Ergebnis,
Aufbau, Versionen und Entscheidung nennen. Die SSH-S0-Abnahme kann dafür nicht wiederverwendet werden.

## G4: verbindliche Grenze der Vorarbeit

Die Vorarbeit kann mit deterministischen Fakes und Uhr beginnen. Ihr Vertrag muss mindestens enthalten:

- Lease 120 s, Heartbeat 30 s; Grace bei unerreichbarem Verleiher 24 h und bei unerreichbarem
  Entleiher 15 min; Mission maximal 30 Tage. Ablauf/Revoke verhindert im Modell weitere Arbeit.
- Ein Auftrag gehört genau zu einem Projekt beim Entleiher. Definition, Identität und Eigentum
  bleiben beim Verleiher; die heimische Instanz arbeitet weiter. Secrets werden nur als Namen referenziert.
- Kontinuierlicher Rückfluss in bestätigten Batches mit direktem Import, getrennt nach Beziehung
  und Vertraulichkeitsstufe. Jedes Element trägt Mission, Herkunft, `relationshipKey` und
  `teilbar|vertraulich|privat`; am Heimatort lautet der fremde Beziehungsschlüssel
  `rel:<agentId>:peer:<borrowerFingerprint>:<personKey>`.
- In Gesprächen mit der heimischen Person: `teilbar` mit Herkunft, `vertraulich` verwendbar ohne
  Offenlegung, `privat` nie im Prompt. Private Einträge dürfen nicht ins ausgewählte Leihpaket.
  Berichte an das Elternprojekt laufen über die Projektebene, nicht über Beziehungserinnerungen.
- Wiederholte Batches sind idempotent; Beziehung und Stufe bleiben bei Import, Bestätigung,
  Rückgabe und Wiederverbindung erhalten. Kopien beim Entleiher bleiben nur mit Erlaubnis im Angebot.

D116 §12 präzisiert Q10. Ältere Formulierungen zu optionalem Rückfluss erst bei Rückgabe oder zu
einem Vorschlagsschritt im WP12-Text sind keine Grundlage für einen abweichenden G4-Standard.
Die Vorarbeit liefert noch keinen echten Import-/Recall-/Prompt-Datenschutzbeleg.

## Verifizierte PR-Stände

Die GitHub-Metadaten wurden einmalig lesend abgefragt, ohne CI-Polling. Alle folgenden PRs sind
`MERGED`; ihre Merge-Commits sind Vorfahren der oben genannten Basis. Heads sind die von GitHub
gemeldeten PR-Heads, keine offenen Arbeitsstände.

| PR | PR-Head | Merge-Commit | Mergezeit (UTC) |
|---|---|---|---|
| [#570](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/570) | `ff17b948cbe73f694fa3a1192ce5bc350fa53faa` | `80c657de6477ec6b8134c081b22e417ef59a30d6` | 2026-10-19 00:11:10 |
| [#574](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/574) | `c153a3aeced84ea2ea9918b870d4d02bb9a4984c` | `d36e0a8f4bf94d543425b68800068d99e328dad1` | 2026-10-19 17:05:20 |
| [#291](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/291) | `085c13fab59cf94923b103214cd5dfa0c6dd3c26` | `30215768458ef60f6540670dc12e97a34cf17954` | 2026-10-08 06:51:39 |
| [#352](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/352) | `1488a84b1045c648eff62dd0219ec3f1acc7aa93` | `dc51ba9c00546096d3233119d4378ce1ebf4af69` | 2026-10-10 09:55:17 |
| [#510](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/510) | `6e8647e62c3d5e5af1b6d28d574981e5ee99ff77` | `35cc4f641d9104b0ae3ff669cb71f203bfbd05bc` | 2026-10-16 03:48:42 |
| [#514](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/514) | `0b0f9f0838fc89fd6257a8b1b24bf8008ce40253` | `2cc6a511dd3e9e304a99168c74015c05071cd6cb` | 2026-10-16 09:32:42 |
| [#515](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/515) | `cac6f72571128f26ae462077fc0e2531a806af46` | `66d0b36a7a72d7af36c15e049786634a342f65f3` | 2026-10-16 13:29:22 |
| [#516](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/516) | `bffaf41fcb4cd7fff29596e7b1b28c59d80022c9` | `e5ce9de5facd335473b9838a95a0d68d295b6de0` | 2026-10-18 09:43:52 |
| [#520](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/520) | `6ff79be317f51f414c49235eab8efe2a06db0839` | `c2c75ab237c4cc9f411c97734d9387222929672a` | 2026-10-18 16:45:12 |

## Validierung und KNOWN GAPs

G0 ändert ausschließlich dieses handgeschriebene Dokument. Validierung: `git diff --check`,
Dokumentlink-Prüfung und Git-Abstammungsprüfung der neun Merge-Commits. Produkt-Tests: 0,
Fake-Laufzeittests: 0; es wird kein Test ausgelassen oder gelockert. Kein Schema wurde geändert,
daher sind `pnpm gen` und `pnpm docs:gen` nicht erforderlich.

Offene Abnahmen für die Folgephasen: fünf S0-Prüfungen, Peer-RBAC/`humanOnly`/Replay/Revocation,
API-A2A-1.0.0-Transport, gepinntes LAN-/Tailnet-Egress, Zwei-Instanzen-Privacy und per Eintrag
ausgewählte Projektfreigaben. G4 benötigt später Fake-Clock-Tests für Lease/Grace/Recall und
Marker-Tests für jede Beziehung und Stufe; echte D116-Import-/Recall-/Prompt-Abnahme folgt erst
mit C3/C4 und WP3/WP4. Diese Liste ist ein Prüfauftrag, keine behauptete Testausführung.
Keine Owner-Frage wird erneut geöffnet; die fehlenden Voraussetzungen sind Implementierungs-
und Nachweisarbeit. Merge und Engine-Pin bleiben beim Controller.
