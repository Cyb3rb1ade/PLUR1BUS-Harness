// Failure-only job diagnostics accept image basenames/PIDs/parents, never paths or command lines.
const jobReasons = new Set(['FIXTURE_JOB_CREATE_FAILED', 'FIXTURE_JOB_LIMIT_FAILED', 'FIXTURE_JOB_STDIO_FAILED', 'FIXTURE_JOB_EXECUTABLE_INVALID', 'FIXTURE_JOB_SPAWN_FAILED', 'FIXTURE_JOB_ASSIGN_FAILED', 'FIXTURE_JOB_RESUME_FAILED', 'FIXTURE_JOB_ACCOUNTING_FAILED', 'FIXTURE_JOB_PROCESS_LIST_FAILED', 'FIXTURE_JOB_PROCESS_SNAPSHOT_FAILED', 'FIXTURE_JOB_TERMINATE_FAILED', 'FIXTURE_JOB_TERMINATION_UNCONFIRMED', 'FIXTURE_JOB_PRIMARY_WAIT_FAILED', 'FIXTURE_JOB_PRIMARY_EXIT_FAILED', 'FIXTURE_JOB_ARGUMENT_INVALID', 'FIXTURE_JOB_EXECUTABLE_FAILED', 'FIXTURE_JOB_UNAVAILABLE']);
export function jobDiagnostic(line) {
  if (jobReasons.has(line)) return line;
  const prefix = 'FIXTURE_JOB_DRAIN_TIMEOUT remaining=';
  if (!line.startsWith(prefix) || line.length > 4096) return;
  const remaining = line.slice(prefix.length);
  if (jobReasons.has(remaining)) return line;
  if (!remaining || !remaining.split(',').every(row => {
    const match = /^([A-Za-z0-9_.-]{1,128}):(\d+):(\d+)$/.exec(row);
    return match && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0 && Number.isSafeInteger(Number(match[3]));
  })) return;
  return line;
}
export function jobSafeToDelete(line) { return line === 'FIXTURE_JOB_SAFE_TO_DELETE active=0'; }
