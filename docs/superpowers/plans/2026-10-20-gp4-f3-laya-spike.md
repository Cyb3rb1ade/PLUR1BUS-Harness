# F3-Vorarbeit — Laya ONNX

Isolierter Spike auf Basis F1, kein Produktbackend und keine Dependency-/Pinänderung.

1. Unveränderliche Upstream-Revision und sechs SHA-256-Artefakte aus Primärquelle verifizieren.
2. Feste 60 deutsche/englische Kernpaare und 30 Verbraucher-Zusatzpaare vor Inferenz erstellen;
   Labels als nicht menschlich validierte Vorschläge kennzeichnen.
3. Failing Tests für Softmax, Temperatur je Primitive, Promptbudget, Brier und Gate; dann reine Helper.
4. Failing Tests für HostFetch, Hash-/Bytefehler und Abbruch; dann atomare Downloadvorbereitung.
5. Vorhandene installierte ONNX-/Tokenizer-Runtime explizit an den Spike geben; keine Engine-Interna importieren.
6. Native CPU-Inferenz auf macOS arm64, ein/vier Threads; Accuracy/Brier/p50/p95/RSS und fünf Fragen messen.
7. Handoff mit Rohdaten, Nichtbestehen des deutschen Gates und offenem Linux-/Windows-/role-Nachweis.
8. Diff, Tests und Quellen unabhängig prüfen, dann echten Stack-PR auf F1 öffnen. F3-Laufzeit später
   am öffentlichen F2-Backend-Port und D70-Modul integrieren; keine Bibliothek allein als fertig ausgeben.

Review-Fokus: fehlende Evidenz darf keinen Gate-Pass liefern; keine still abgeschnittenen Optionen;
keine global-fetch-Ausweichroute; falscher Temperaturindex für Score/Noul; unverifiziertes Modell
oder `.part` wird nie inferiert; keine Auto-Auswahl deutscher Inputs nach Gate-Fehler.
