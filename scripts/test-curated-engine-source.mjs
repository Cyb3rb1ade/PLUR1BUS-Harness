// Explicit source-only acceptance; never installs, links or changes the Engine pin.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [source,...tests]=process.argv.slice(2);
if(!source||!tests.length||!existsSync(join(resolve(source),'engine/create-engine.js'))) {
 console.error('Usage: node scripts/test-curated-engine-source.mjs ENGINE_SOURCE TEST_FILE...');
 process.exit(1);
}
const hook=`import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const prefix='@cyb3rb1ade/plur1bus-memory/';
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier.startsWith(prefix))return {url:pathToFileURL(process.env.PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE+'/'+specifier.slice(prefix.length)).href,shortCircuit:true};
 return nextResolve(specifier,context);
}});`;
const result=spawnSync(process.execPath,[
 '--import',`data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
 '--experimental-strip-types','--conditions=source','--no-warnings=ExperimentalWarning',
 '--test','--test-concurrency=1','--test-timeout=120000',...tests,
],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit',env:{...process.env,PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE:resolve(source),PLUR1BUS_REQUIRE_CURATED_ENGINE:'1'}});
if(result.error)console.error('Engine source acceptance could not start');
process.exit(result.status??1);
