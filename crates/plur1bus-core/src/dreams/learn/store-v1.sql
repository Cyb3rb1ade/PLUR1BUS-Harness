CREATE TABLE learn_run(id TEXT PRIMARY KEY, target_hash TEXT NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, metadata TEXT NOT NULL, UNIQUE(target_hash,window_from,window_to));
        CREATE TABLE learn_step(run_id TEXT NOT NULL REFERENCES learn_run(id), step TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,step));
        CREATE TABLE learn_payload(run_id TEXT NOT NULL REFERENCES learn_run(id), key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,key));
        CREATE TABLE learn_finding(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES learn_run(id), state TEXT NOT NULL);
        CREATE TABLE learn_decision(finding_id TEXT PRIMARY KEY REFERENCES learn_finding(id), reviewer TEXT NOT NULL, outcome TEXT NOT NULL, decided_at INTEGER NOT NULL, receipt TEXT NOT NULL);
