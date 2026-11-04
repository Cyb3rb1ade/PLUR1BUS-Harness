/** Environment of native tools processes: no Core credentials or provider configuration are inherited. */

/** Minimal OS environment, including Windows loader basics; excludes all provider and application credentials. */
export function toolsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CI",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      env[name] === undefined ? [] : [[name, env[name]]],
    ),
  );
}
