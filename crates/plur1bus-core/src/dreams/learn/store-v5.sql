CREATE TABLE learn_handoff(finding_id TEXT NOT NULL REFERENCES learn_finding(id), hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(finding_id,hash));
