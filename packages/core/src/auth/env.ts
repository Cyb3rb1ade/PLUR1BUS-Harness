/** The one pair of predicates every login flow consults (ADR-005 "Headless / SSH"). They read an injected snapshot, never
 *  `process` directly, so tests table-drive them. */
export interface EnvSnapshot {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
}

export function snapshotFromProcess(): EnvSnapshot {
  return { env: process.env, platform: process.platform, stdoutIsTTY: Boolean(process.stdout.isTTY) };
}

// Remote-IDE / cloud-shell markers. This allowlist always lags reality (Hermes' documented weakness), so it is only one
// of the signals: the SSH, display and TTY signals below do not depend on it.
const REMOTE_ENV_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CODESPACES", "CLOUD_SHELL", "GITPOD_WORKSPACE_ID", "VSCODE_IPC_HOOK_CLI", "REMOTE_CONTAINERS", "CLAUDE_CODE_REMOTE"];

const set = (env: EnvSnapshot["env"], k: string) => (env[k] ?? "") !== "";

export function isRemoteSession(s: EnvSnapshot): boolean {
  return REMOTE_ENV_MARKERS.some((k) => set(s.env, k));
}

/** True only when a browser can plausibly open on the machine the person is sitting at. */
export function canOpenGraphicalBrowser(s: EnvSnapshot): boolean {
  if (isRemoteSession(s)) return false;
  if (s.platform === "darwin" || s.platform === "win32") return true; // a desktop session is the default there
  return set(s.env, "DISPLAY") || set(s.env, "WAYLAND_DISPLAY");
}
