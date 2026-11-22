ALTER TABLE learn_run ADD COLUMN owner TEXT NOT NULL DEFAULT '';
        UPDATE learn_run SET owner=json_extract(metadata,'$.target.owner');
        CREATE INDEX learn_run_owner ON learn_run(owner,window_to DESC);
        CREATE INDEX learn_run_target ON learn_run(target_hash,window_to DESC);
