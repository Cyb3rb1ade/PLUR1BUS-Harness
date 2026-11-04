/** Launch the same pnpm installation as the parent lifecycle, or use pnpm on PATH. */
export function pnpmCommand(args, { env = process.env, platform = process.platform, node = process.execPath } = {}) {
  const entry = env.npm_execpath?.includes("pnpm") ? env.npm_execpath : null;
  // pnpm/action-setup also installs @pnpm/exe, a native Mach-O/ELF/PE binary. Only JavaScript entries go through Node.
  if (entry && /\.(?:c|m)?js$/i.test(entry)) return { command: node, args: [entry, ...args], shell: false };
  const command = entry ?? "pnpm";
  return { command, args, shell: platform === "win32" && (!entry || /\.(cmd|bat)$/i.test(entry)) };
}
