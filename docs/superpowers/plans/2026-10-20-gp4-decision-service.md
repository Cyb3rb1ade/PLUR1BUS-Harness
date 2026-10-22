# Großpaket 4 — Entscheidungsdienst

Verbindlicher Auftrag: Großpaket 4 vom 20.10.2026; Kern-Spec D18/D30/D33/D34/D69/D70/D105,
D116-Spec §§7–8. Je Phase ein PR; keine Engine-Pin- oder Lockfile-Änderung, kein bezahlter
oder Cloud-Modellaufruf ohne Owner-Freigabe, kein CI-Polling. Umsetzung in dieser Sitzung.

## F1 — ADR-015 und Config-Vertrag

Dateien: `docs/adr/ADR-015-decision-service.md`, ADR-Index,
`packages/config-schema/schema/config.schema.json`, `packages/config-schema/test/decision.test.ts`,
generierte Config-Fixtures und Einstellungen-Index; Handoff `docs/handoffs/2026-10-20-f1-decision-contract.md`.

1. Bestehenden Config-Testlauf als Baseline ausführen.
2. Fehlende geschlossene Backend-Auswahl, endliche Budgets, Konfidenzgrenzen, Rückwärtskompatibilität
   von `timeoutMs`/`classProfiles` und Live-Restart mit Tests zeigen (rot).
3. Reservierten Namespace beschreiben: `backend`, `timeoutMs`, `budgets`, `confidence`, `classProfiles`.
   Standard `role`; F1 aktiviert keine neuen Backends. Alle Felder mit `x-restart: live` / `x-tier: advanced`.
4. ADR: drei Primitive, Modulgrenze nach D70, Core-Client und Übergangsbackend `role`, Deadline und
   Abbruch, konservative Verbraucher-Fallbacks, deutsch/englische Kalibrierung, datensparsamer Trace,
   D73-Egress und lokale Privacy-Prüfung vor jedem Backend-Versuch.
5. `pnpm gen`, Config-Tests (grün), `pnpm docs:gen`, Typecheck, Config-Rust-Tests, Diffprüfung.
6. Gesamten F1-Diff unabhängig prüfen; Review-Befunde beheben. Handoff mit Zahlen und offenen
   Laufzeit-Phasen. Commit, Push, Ready-PR gegen main.

## Folgephasen und Schnittstellen

- F2: `packages/core/src/decision/` als einheitlicher Client mit `noul`, `choice`, `score`;
  `role` nutzt den bestehenden Provider-Router (Budget, Secret-Lease, Privacy), D105-Migration ohne
  neuen Triage-Payload, Pruning-Adapter. Experimental `decision.status` / humanOnly `decision.test`
  mit Schema/RBAC/Inventar/Rust-Tabellen, keine rohen Eingaben in Status oder Trace.
- F3: Modellkatalog und Host-Fetch; echte Artefakt-/Lizenz-/Hashprüfung. 60 zweisprachige Fälle,
  Accuracy und Brier; macOS/Linux/Windows p50/p95/Speicher getrennt ausweisen. Fehlende native
  Messung ist kein bestandener Gate. Laya bei deutschem Fehlschlag explizit verfügbar, aus Auto-DE ausgeschlossen.
- F4: gemeinsamer System-One-Client für Jev/Kev, ausschließlich Loopback-Antwortformen bis Freigabe;
  Kev-MLX-Spike und deutsches Gate vor Auslieferung; Secret-Store und Egress, keine Zugangsdaten in Trace.
- F5: Agent-Policy fixed/auto, Session-Stabilität und explizites `/model`; Tier-Liste zugleich Failover-Liste.
- F6: Pruning keep/truncate/drop mit bestehenden Schutzregeln; Skill-Vorstufe und finale Auswahl,
  maximal drei im dynamischen Suffix; Pin/Block und Trace.
- F7: D116-Port `TreeChooser.choose(query, candidates, signal)` adaptieren, keine Engine-Doppelimplementierung;
  Web-Einstellungen de/en, axe, keine Inline-Styles; `docs/decision-service.md`.

G0 und H1 werden in getrennten Worktrees bearbeitet. G1–G4 folgen den tatsächlich auf main
verfügbaren Gates; H2 arbeitet bis Controller-Pin gegen Vertrags-Fakes. H3 braucht echte lokale
Medien und einen echten Encoder, keinen Fake als Abnahme.

## Review-Fokus

Unbekannte Backends und Tippfehler werden abgelehnt; 0/negative/unendliche Budgets werden nicht
akzeptiert; fehlendes `decision` bleibt mit alten Configs kompatibel; bestehende Class-Profile gehen
nicht verloren; Namespace-Aktivierung behauptet keine installierte Backend-Laufzeit.
