# Doctor report

`doctor.report` serves the Core's cached projection of the authoritative `plur1bus --json 1staid check` report. Core performs an internal startup check; reads use that snapshot. `refresh: true` runs another check for Owner, Admin or Operator, at most once per 30 seconds. All human roles may read under the `agent.list` admission scope; refresh additionally needs `doctor.run`, so read-only scoped tokens cannot force checks. Concurrent refreshes and requests inside that interval return `E_CONFLICT` with `reason: refresh-rate-limit`. Missing CLI/check output returns `E_NOT_AVAILABLE`.

The `provisioning` group includes check IDs, normalized statuses, redacted summaries and repair hints. Raw detail, stderr and full home paths are omitted. Checks absent from the existing Rust source (containers, secret presence, certificates, ports and disks in this revision) are explicitly `skipped`; they are not claimed as verified. Completing these authoritative checks remains open.

The Doctor page reads this report alongside its existing health and uploaded-report views. The health refresh button is natively disabled while the current request is pending, fixing the previous race where a click could be silently dropped before loading finished.
