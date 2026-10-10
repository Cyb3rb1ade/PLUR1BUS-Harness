Diagnostic persistence on the Core hot path
=========================================

Legacy info/debug records are redacted and appended synchronously, so diagnostic
readers and SIGKILL recovery can see complete lines immediately. Disk sync is
coalesced by the writer's one-second timer. Explicit `flush()`, orderly close,
uncaught-exception/exit hooks, warn/error records and rotation sync the dirty
file. Rotation syncs the old file before renaming it. Sink callers that use the
default `append()` still sync before returning.

This avoids one blocking disk flush per engine or journal-replay diagnostic.
A machine power loss may lose the most recent unsynced info/debug batch; a
process kill does not discard lines already appended to the OS. Diagnostics
are separate from the capture journal, turn replay guard and audit chain,
whose persistence is unchanged.
