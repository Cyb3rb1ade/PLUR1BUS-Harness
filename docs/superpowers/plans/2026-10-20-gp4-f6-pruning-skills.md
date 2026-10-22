# F6 — Pruning und Skill-Auswahl

Basis F2; Engine-Pin/Lockfile unverändert, keine neuen Abhängigkeiten oder bezahlten Aufrufe.

1. Pruning-Tests rot: keep unverändert, truncate mit Head/Tail und Originalref, drop mit
   Argumenthash/Status; offene Folgeaufrufe, letzte K Turns, Audit/Approval und Unsicherheit schützen.
2. Overlay-Migration für verdict/confidence/saved-token-Metadaten; Originalevents bleiben unverändert.
   Bestehende binäre Ports bleiben kompatibel. Gemeinsames Deadline-Budget und erneute Revisionprüfung.
3. Dreiweg-Choice am F2-Port, konservative Fallbacks, Erklärungs-/Re-Fetch-Metriken.
4. Skill-Auswahl zuerst rot testen: vorhandene Keyword/Embedder-Kandidaten, Choice plus none,
   höchstens drei inklusive Pins; Block gewinnt. Bei Unsicherheit, Timeout oder fehlendem Modell gilt die Regel-Shortlist (Top 3); das Modell verfeinert mit einem Aufruf (Owner-Entscheidung 2026-10-21).
5. Produktionshook am bestehenden LiveCapabilityIndex mit demselben DecisionClient; nur
   dynamischer Suffix, keine neue unkontrollierte Embedder-/Provider-Pipeline.
6. Benutzerzugriff auf Compact-Erklärung/Ref-Restore ergänzen, gleiche Session-Eigentumsprüfung;
   falls neue RPC/CLI-Fläche nötig, Schema/Inventar/Rust/Generatoren gemeinsam ändern.
7. Passende Session-/Decision-/Provider-/Schema-/Rust-Tests, Typecheck und Docs prüfen;
   unabhängiges Review, Handoff und echter Stack-PR auf F2.
