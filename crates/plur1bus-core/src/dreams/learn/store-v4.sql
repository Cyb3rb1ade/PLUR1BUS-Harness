CREATE TABLE learn_failure(run_id TEXT NOT NULL REFERENCES learn_run(id), at INTEGER NOT NULL);
        INSERT INTO learn_failure SELECT id,json_extract(metadata,'$.finishedAt') FROM learn_run WHERE json_extract(metadata,'$.outcome')='failed';
        CREATE TABLE learn_action(finding_id TEXT NOT NULL REFERENCES learn_finding(id), revision INTEGER NOT NULL,
          state TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(finding_id,revision));
