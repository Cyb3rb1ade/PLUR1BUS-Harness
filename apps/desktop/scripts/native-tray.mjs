import {spawn} from 'node:child_process';
import {mkdtemp, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const fields = ['english_headers','german_headers','runtime_and_secrets_words','settings_ipc_refresh','native_tooltip_matches','colour_image_default','decoder_fallback_is_native_template','colour_image_restored'];
const reasons = new Set(['TRAY_FIXTURE_DISPATCH_FAILED','TRAY_FIXTURE_GUI_TIMEOUT','TRAY_FIXTURE_OBSERVER_TIMEOUT','TRAY_FIXTURE_HEADER_MISSING','TRAY_FIXTURE_COLOUR_FAILED','TRAY_FIXTURE_SETTINGS_IPC_FAILED','TRAY_FIXTURE_NATIVE_TEXT_FAILED','TRAY_FIXTURE_DECODER_FAILED','TRAY_FIXTURE_TEMPLATE_SET_FAILED','TRAY_FIXTURE_TEMPLATE_FLAG_FAILED','TRAY_FIXTURE_COLOUR_RESTORE_FAILED']);
function run(command, args, timeout, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {cwd:desktop, stdio:capture ? ['ignore','pipe','pipe'] : 'inherit'});
    let output = ''; let exceeded = false;
    const timer = setTimeout(() => {exceeded = true; child.kill('SIGKILL');}, timeout);
    if (capture) {
      child.stdout.on('data', data => {output += data; if (output.length > 8192) child.kill('SIGKILL');});
      child.stderr.on('data', data => {for (const match of data.toString().matchAll(/\bTRAY_FIXTURE_[A-Z_]+\b/g)) if (reasons.has(match[0])) console.error(match[0]);});
    }
    child.on('error', () => {clearTimeout(timer); reject(new Error('NATIVE_TRAY_FAILED'));});
    child.on('close', code => {
      clearTimeout(timer);
      if (exceeded || code !== 0) reject(new Error(exceeded ? 'NATIVE_TRAY_TIMEOUT' : 'NATIVE_TRAY_FAILED'));
      else accept(output);
    });
  });
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('NATIVE_TRAY_FIXTURE_UNAVAILABLE');
  await run('cargo',['build','--manifest-path','Cargo.toml','--locked','--example','production_tray'],300000);
  const root = await mkdtemp(join(tmpdir(),'wp06-native-tray-'));
  try {
    const output = await run(resolve(desktop,'target/debug/examples/production_tray'),[root],120000,true);
    let report;
    try {report = JSON.parse(output.trim().split('\n').at(-1));}
    catch {throw new Error('NATIVE_TRAY_REPORT_MISSING');}
    if (Object.keys(report).length !== fields.length || fields.some(field => report[field] !== true)) throw new Error('NATIVE_TRAY_INCOMPLETE');
    console.log(JSON.stringify(report));
  } finally {
    await rm(root,{recursive:true,force:true});
    try {await lstat(root); throw new Error('NATIVE_PROFILE_CLEANUP_FAILED');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
}
try {await main();}
catch (error) {
  const codes = new Set(['NATIVE_TRAY_FAILED','NATIVE_TRAY_TIMEOUT','NATIVE_TRAY_REPORT_MISSING','NATIVE_TRAY_INCOMPLETE','NATIVE_PROFILE_CLEANUP_FAILED','NATIVE_TRAY_FIXTURE_UNAVAILABLE']);
  console.error(codes.has(error.message) ? error.message : 'NATIVE_TRAY_FAILED');
  process.exitCode = 1;
}
