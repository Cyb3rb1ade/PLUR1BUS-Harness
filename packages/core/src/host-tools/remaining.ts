import { joinPath, asObject, type HostTool, type HostContext } from './types.ts';
import { HostFailure, requireString } from './errors.ts';
import { runCaptured } from './exec.ts';
import { redactText } from './denylist.ts';
import { which } from './context.ts';
const empty = { type: 'object', additionalProperties: false, properties: {} };
const output = { type: 'object' };
export const sysMemoryTool: HostTool = {
  name: 'sys.memory', capability: 'sys.read', riskClass: 'low', description: 'Current total/free physical memory in bytes; no process contents.', schema: { input: empty, output },
  async run(input, ctx) { asObject(input); return { totalBytes: ctx.os.totalmem(), freeBytes: ctx.os.freemem() }; },
};
export const sysStartupItemsTool: HostTool = {
  name: 'sys.startupItems', capability: 'sys.read', riskClass: 'low', description: 'Bounded startup-entry names from standard directories; does not read launch commands or credentials.', schema: { input: empty, output },
  async run(input, ctx) {
    asObject(input);
    const roots = ctx.platform === 'darwin' ? [joinPath(ctx.platform, ctx.homedir, 'Library', 'LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']
      : ctx.platform === 'linux' ? [joinPath(ctx.platform, ctx.homedir, '.config', 'autostart'), '/etc/xdg/autostart']
      : [joinPath(ctx.platform, ctx.homedir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')];
    const sources = await Promise.all(roots.map(async source => {
      try { const all = await ctx.fs.readdir(source); return { source, available: true, items: all.slice(0, 256).map(redactText), truncated: all.length > 256 }; }
      catch { return { source, available: false, items: [], truncated: false }; }
    }));
    return { sources, coverage: ctx.platform === 'win32' ? 'startup-folder-only; registry Run keys and scheduled tasks are not included' : 'standard-directories-only' };
  },
};
async function checked(ctx: HostContext, program: string, args: string[]) {
  const r = await runCaptured(ctx, { program, args });
  if (r.exitCode !== 0) throw new HostFailure('not_supported_on_platform', 'the OS service did not provide this read-only report');
  return { output: redactText(r.stdout), truncated: r.truncated };
}
export const sysServicesTool: HostTool = {
  name: 'sys.services', capability: 'sys.read', riskClass: 'low', description: 'Read service status; no start, stop or system configuration changes.', schema: { input: empty, output },
  async run(input, ctx) { asObject(input); return ctx.platform === 'darwin' ? checked(ctx, 'launchctl', ['list']) : ctx.platform === 'linux' ? checked(ctx, 'systemctl', ['--user', 'list-units', '--type=service', '--no-pager', '--no-legend']) : checked(ctx, 'sc.exe', ['query', 'type=', 'service', 'state=', 'all']); },
};
export const sysUpdatesTool: HostTool = {
  name: 'sys.updates', capability: 'sys.read', riskClass: 'low', description: 'List available updates using the OS manager; never install or refresh package indexes.', schema: { input: empty, output },
  async run(input, ctx) {
    asObject(input);
    if (ctx.platform === 'darwin') return checked(ctx, 'softwareupdate', ['--list']);
    if (ctx.platform === 'win32') return checked(ctx, 'winget', ['upgrade', '--disable-interactivity']);
    if (await which(ctx, 'apt')) return checked(ctx, 'apt', ['list', '--upgradable']);
    throw new HostFailure('not_supported_on_platform', 'no supported read-only update reporter is installed');
  },
};
function appAction(action: 'focus' | 'quit'): HostTool {
  return {
    name: `apps.${action}`, capability: action === 'focus' ? 'apps.launch' : 'proc.signal', riskClass: 'medium',
    description: action === 'focus' ? 'Activate an application by bundle id, WM_CLASS or Windows process name; requires launch approval.' : 'Request application close; always requires approval, never forces unsaved work away.',
    schema: { input: { type: 'object', additionalProperties: false, required: ['appId'], properties: { appId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' } } }, output },
    async run(input, ctx) {
      const o = asObject(input);
      if (Object.keys(o).some(k => k !== 'appId')) throw new HostFailure('invalid_input', 'only appId is accepted; force and script source are unavailable');
      const id = requireString(o.appId, 'appId', 1, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) throw new HostFailure('invalid_input', 'appId must be a bundle id, WM_CLASS or process name');
      if (ctx.platform === 'darwin') await checked(ctx, 'osascript', ['-e', `tell application id "${id}" to ${action === 'focus' ? 'activate' : 'quit'}`]);
      else if (ctx.platform === 'linux') await checked(ctx, 'wmctrl', [action === 'focus' ? '-xa' : '-xc', id]);
      else {
        // Identifier grammar excludes PowerShell quoting, interpolation and operators. No user script source is accepted.
        const script = action === 'focus' ? `$p=Get-Process -Name '${id}' -ErrorAction Stop | Select-Object -First 1; $w=New-Object -ComObject WScript.Shell; if(-not $w.AppActivate($p.Id)){exit 1}` : `$p=Get-Process -Name '${id}' -ErrorAction Stop; foreach($x in $p){if(-not $x.CloseMainWindow()){exit 1}}`;
        await checked(ctx, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      }
      return { appId: id, action, requested: true };
    },
  };
}
export const appsFocusTool = appAction('focus');
export const appsQuitTool = appAction('quit');
