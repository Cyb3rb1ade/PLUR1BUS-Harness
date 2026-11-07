# Synthetischer Lern-Pass-Eval

24 selbst geschriebene MIT-Fälle, keine Produktionsdaten und keine abgeleiteten
Modellartefakte. `cases.json` enthält die synthetischen Aussagen, Quellenarten,
handschriftlich festgelegten Modellantworten und erwartete Cluster-/Score-/Tier-/Skeptiker-Labels.
Der Fixture-Provider ersetzt Referenzplätze durch die tatsächlichen IDs aus dem
Session-Store. Auswahl, Extraktion, Aggregation, Verify, Skeptiker und Tier laufen
über `LearnService`; Kanalprovenienz über eine echte temporäre Identity-Datenbank.

Der Bericht verwendet exakten Inhaltsschlüssel-Abgleich für Präzision und Recall,
keinen zusätzlichen Modellrichter. Damit können semantisch passende Live-Antworten
mit anderem Schlüssel als Fehler erscheinen; die Zahlen sind keine semantische
Qualitätszusage. Der Bericht enthält ausschließlich Fall-IDs, Zähler und Messwerte.
Die operative Ledger-Projektion und Inbox enthalten keine Texte; abgeleitete
Befundtexte gehören allein in den getrennten, befristeten Prüfpayload.

Offline: `node --experimental-strip-types --conditions=source scripts/eval/learn-eval.ts --fake`.
Ohne Modus bzw. mit `--dry-run` werden nur Anzahl und Plan ausgegeben.

Ein Live-Lauf verlangt sowohl `--live` als auch `PLUR1BUS_LEARN_EVAL_LIVE=1` und eine
explizite `PLUR1BUS_LEARN_EVAL_MODELS`-Liste im Format des Turn-Evals. Zugangsdaten
kommen aus dessen Harness-Secret-Store (`PLUR1BUS_TURN_EVAL_HOME`), niemals aus
Fixture-Dateien. Pro ausgewähltem Modell wird die gesamte Pipeline durch dessen
explizite Eval-Route geprüft. Keine Tools, keine automatischen Wiederholungen.
Der Workflow `learn-eval.yml` hat ausschließlich `workflow_dispatch` mit separater
Kostenfreigabe; es gibt weder Zeitplan noch voreingestellte Modellliste.
