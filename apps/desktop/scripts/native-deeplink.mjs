import {spawn} from 'node:child_process';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {removeExitedProfile} from './owned-process.mjs';
const desktop = fileURLToPath(new URL('..', import.meta.url));
// Every child is tracked to close before disposable profile removal. Never forward raw output.
function owned(command, args, options, timeout, onLine = () => {}) {
  const child = spawn(command, args, {cwd:desktop, ...options, stdio:['ignore','pipe','pipe']});
  let output = '', pending = '', overflow = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) {overflow = true; child.kill('SIGKILL');} });
  child.stderr.on('data', chunk => {
    pending += chunk;
    if (pending.length > 8192) { overflow = true; child.kill('SIGKILL'); pending = ''; }
    const lines = pending.split('\n'); pending = lines.pop();
    lines.forEach(onLine);
  });
  const done = new Promise(resolve => {
    child.once('error', () => {});
    child.once('close', code => {clearTimeout(timer); resolve({code, output, overflow});});
  });
  return {child, done};
}
async function main() {
  const build = await owned('cargo', ['build','--quiet','--manifest-path','Cargo.toml','--locked','--example','production_deeplink'], {}, 300000).done;
  if (build.code !== 0 || build.overflow) throw Error('NATIVE_DEEPLINK_BUILD_FAILED');
  const root = await mkdtemp(join(tmpdir(), 'p1-native-deeplink-'));
  const children = [];
  try {
    await mkdir(join(root, 'home'));
    const env = {...process.env, HOME:join(root,'home'), USERPROFILE:join(root,'home'), CFFIXED_USER_HOME:join(root,'home'), XDG_CONFIG_HOME:join(root,'config'), XDG_DATA_HOME:join(root,'data'), XDG_CACHE_HOME:join(root,'cache'), PLUR1BUS_DEEPLINK_FIXTURE_ROOT:root};
    const executable = resolve(desktop,'target/debug/examples/production_deeplink' + (process.platform === 'win32' ? '.exe' : ''));
    const args = ['plur1bus://pair?origin=http%3A%2F%2F127.0.0.1%3A1&code=0123-4567'];
    let second;
    const first = owned(executable,args,{env},25000,line => {
      if (line === 'FIXTURE_DEEPLINK_READY' && !second) {
        second = owned(executable,args,{env},8000); children.push(second);
      }
    });
    children.push(first);
    const result = await first.done;
    if (!second) throw Error('NATIVE_DEEPLINK_SECOND_NOT_STARTED');
    const secondary = await second.done;
    if (result.code !== 0 || secondary.code !== 0 || result.overflow || secondary.overflow) throw Error('NATIVE_DEEPLINK_CHILD_FAILED');
    let report;
    try {report = JSON.parse(result.output.trim());} catch {throw Error('NATIVE_DEEPLINK_REPORT_INVALID');}
    const keys = ['startup_pair_intent','second_instance_same_intent','ignored_fixed_only','route_refused_without_session'];
    if (!report || Object.keys(report).sort().join() !== keys.sort().join() || !keys.every(key => report[key] === true)) throw Error('NATIVE_DEEPLINK_REPORT_INCOMPLETE');
    console.log(JSON.stringify({...report,second_instance_exited:true}));
  } finally {
    for (const item of children) if (item.child.exitCode === null) item.child.kill('SIGKILL');
    await Promise.all(children.map(item => item.done));
    await removeExitedProfile(root);
  }
}
main().catch(error => {console.error(/^NATIVE_DEEPLINK_[A-Z_]+$/.test(error.message) ? error.message : 'NATIVE_DEEPLINK_FAILED');process.exitCode=1;});
