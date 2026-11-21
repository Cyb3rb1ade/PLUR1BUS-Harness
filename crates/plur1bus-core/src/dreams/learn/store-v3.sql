ALTER TABLE learn_finding ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE learn_decision RENAME TO old_decision;
          CREATE TABLE learn_decision(finding_id TEXT NOT NULL REFERENCES learn_finding(id), revision INTEGER NOT NULL,
            reviewer TEXT NOT NULL, outcome TEXT NOT NULL, decided_at INTEGER NOT NULL, receipt TEXT NOT NULL,
            summary TEXT NOT NULL, PRIMARY KEY(finding_id,revision));
          CREATE TABLE learn_observation(run_id TEXT NOT NULL REFERENCES learn_run(id), finding_id TEXT NOT NULL REFERENCES learn_finding(id), PRIMARY KEY(run_id,finding_id));
          INSERT INTO learn_observation SELECT run_id,id FROM learn_finding;
