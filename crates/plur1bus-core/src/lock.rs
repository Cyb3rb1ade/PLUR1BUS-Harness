//! P4-10: the single-instance core lock on `state/core.lock`, the SQLite database the TypeScript core holds with
//! `BEGIN EXCLUSIVE` (module-api's `acquireExclusiveLock`); `plur1bus-store` opens it, so this crate stays free of
//! `unsafe`. A lock another core holds is `E_LOCKED` with reason `core-lock-held` and exit code 3. Empty in P4-03.
