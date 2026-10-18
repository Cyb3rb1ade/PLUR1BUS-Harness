// Install and launch through the same pinned package; never select a system or unrelated cached Chrome.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const uiRequire=createRequire(new URL('../ui/package.json',import.meta.url));
export function pinnedBrowser(require=uiRequire){
 const manifest=require.resolve('playwright/package.json');
 const version=JSON.parse(readFileSync(manifest,'utf8')).version;
 const declared=JSON.parse(readFileSync(new URL('../ui/package.json',import.meta.url),'utf8')).devDependencies.playwright;
 if(version!==declared||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(declared))throw Error('UI_BROWSER_PACKAGE_MISMATCH');
 const packageRequire=createRequire(manifest),core=dirname(packageRequire.resolve('playwright-core/package.json'));
 const browsers=JSON.parse(readFileSync(join(core,'browsers.json'),'utf8')).browsers;
 const browser=browsers.find(item=>item.name==='chromium-headless-shell');
 if(!browser?.revision||!browser?.browserVersion)throw Error('UI_BROWSER_REVISION_MISSING');
 return {version,revision:browser.revision,browserVersion:browser.browserVersion,cli:join(dirname(manifest),'cli.js'),module:uiRequire.resolve('playwright')};
}
export function installArguments(cli,withDeps){return [cli,'install',...(withDeps?['--with-deps']:[]),'chromium','--only-shell'];}
async function install(plan,withDeps){await new Promise((ok,fail)=>{const child=spawn(process.execPath,installArguments(plan.cli,withDeps),{stdio:'inherit',env:process.env});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('UI_BROWSER_INSTALL_FAILED')));});}
export async function verifyBrowser(plan=pinnedBrowser()){
 // Resolving the package after environment selection also binds its expected revision/path.
 const loaded=await import(pathToFileURL(plan.module).href);
 const chromium=loaded.chromium??loaded.default?.chromium;
 if(!chromium)throw Error("UI_BROWSER_PACKAGE_MISMATCH");
 const browser=await chromium.launch({headless:true,timeout:30000});
 try {if(browser.version()!==plan.browserVersion)throw Error('UI_BROWSER_VERSION_MISMATCH');}
 finally {await browser.close();}
 return {playwright:plan.version,chromium:plan.browserVersion,revision:plan.revision,headless:true};
}
async function main(){
 const [mode,...flags]=process.argv.slice(2);
 if(!['install','verify'].includes(mode)||flags.some(flag=>flag!=='--with-deps')||mode==='verify'&&flags.length)throw Error('UI_BROWSER_ARGUMENTS_INVALID');
 // Require one explicit shared path: the caller must keep it for later test invocations.
 if(!process.env.PLAYWRIGHT_BROWSERS_PATH||!isAbsolute(process.env.PLAYWRIGHT_BROWSERS_PATH))throw Error('UI_BROWSER_STORAGE_REQUIRED');
 const plan=pinnedBrowser();if(mode==='install')await install(plan,flags.includes('--with-deps'));
 console.log(JSON.stringify(await verifyBrowser(plan)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(['UI_BROWSER_PACKAGE_MISMATCH','UI_BROWSER_REVISION_MISSING','UI_BROWSER_ARGUMENTS_INVALID','UI_BROWSER_STORAGE_REQUIRED','UI_BROWSER_VERSION_MISMATCH'].includes(error.message)?error.message:'UI_BROWSER_PREPARATION_FAILED');process.exitCode=1;});
