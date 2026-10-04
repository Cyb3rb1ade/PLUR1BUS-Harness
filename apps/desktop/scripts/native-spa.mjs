// Public launcher only. Rust owns pairing, credentials, temporary homes and both native children.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const index=process.argv.indexOf('--output');
const artifacts=index<0?mkdtempSync(resolve(tmpdir(),'wp05-native-artifacts-')):resolve(process.argv[index+1]);mkdirSync(artifacts,{recursive:true});
const build=spawnSync('cargo',['build','--locked','-p','plur1bus-desktop','--example','production_spa','--example','production_driver'],{cwd:desktop,stdio:'inherit',timeout:900000});if(build.status!==0)process.exit(build.status??1);
const run=spawnSync(resolve(desktop,'target/debug/examples/production_driver'+(process.platform==='win32'?'.exe':'')),[artifacts],{cwd:desktop,stdio:'inherit',timeout:240000});if(run.status!==0)process.exit(run.status??1);
console.log(`Native SPA acceptance written to ${artifacts}`);
