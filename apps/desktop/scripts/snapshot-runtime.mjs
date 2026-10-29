// Stage the host snapshot producer and a Node executable extracted only from a committed official archive pin.
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {chmod,lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {build} from 'esbuild';

const repo=fileURLToPath(new URL('../../..',import.meta.url));
const version='24.21.0';
const targets=new Map([
 ['aarch64-apple-darwin','darwin-arm64'],
 ['x86_64-pc-windows-msvc','win-x64'],
 ['aarch64-pc-windows-msvc','win-arm64'],
 ['x86_64-unknown-linux-gnu','linux-x64'],
 ['aarch64-unknown-linux-gnu','linux-arm64'],
]);

async function hashFile(path){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}

/** Only committed Node SHASUMS are authoritative; caller-supplied executables or digests are not accepted. */
async function extractNode(archive,target,output){
 const distribution=targets.get(target);
 if(!distribution||!archive)throw Error('snapshot-node-archive-required');
 const windows=distribution.startsWith('win-');
 const extension=windows?'.zip':basename(archive).endsWith('.tar.xz')?'.tar.xz':'.tar.gz';
 const stem=`node-v${version}-${distribution}`,name=`${stem}${extension}`;
 if(basename(archive)!==name)throw Error('snapshot-node-archive-name');
 const metadata=await lstat(archive);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>256*1024*1024)throw Error('snapshot-node-archive-invalid');
 const sums=await readFile(join(repo,'crates/plur1bus/tests/fixtures',`node-v${version}-SHASUMS256.txt`),'utf8');
 const pin=sums.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===name)?.[0];
 if(!pin||await hashFile(archive)!==pin)throw Error('snapshot-node-archive-checksum');
 const member=`${stem}/${windows?'node.exe':'bin/node'}`;
 await extractMember(archive,member,output,256*1024*1024);
 await extractMember(archive,`${stem}/LICENSE`,join(output,'..','LICENSE-node.txt'),1024*1024);
}

async function extractMember(archive,member,output,maximum){
 const env={PATH:process.env.PATH??'',LC_ALL:'C'};
 for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 const child=spawn('tar',['-xOf',archive,member],{stdio:['ignore','pipe','pipe'],env,windowsHide:true});
 child.stderr.resume();
 const exited=new Promise((resolve,reject)=>{
  child.once('error',()=>reject(Error('snapshot-node-extractor-missing')));
  child.once('close',code=>code===0?resolve():reject(Error('snapshot-node-extraction-failed')));
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),60_000);
 let bytes=0;
 try {
  await Promise.all([exited,pipeline(child.stdout,new Transform({transform(chunk,_,callback){
   bytes+=chunk.length;
   callback(bytes>maximum?Error('snapshot-node-too-large'):null,chunk);
  }}),createWriteStream(output,{flags:'wx',mode:0o755}))]);
  if(!bytes)throw Error('snapshot-node-empty');
  await chmod(output,0o755);
 }catch(error){
  child.kill('SIGKILL');
  await rm(output,{force:true});
  throw error;
 }finally{clearTimeout(timer);}
}

/** Fixture Node is explicitly inert; the actual bundled JavaScript still exercises the shared producer. */
export async function stageSnapshotRuntime({target,resources,archive,fixture=false}){
 if(!targets.has(target))throw Error('snapshot-target-invalid');
 const nodePath=`snapshot/${target.includes('windows')?'node.exe':'node'}`;
 const entryPath='snapshot/import-snapshot.mjs';
 await mkdir(join(resources,'snapshot'),{recursive:true});
 const executable=join(resources,nodePath);
 if(fixture){
  await writeFile(executable,'CI PLACEHOLDER - snapshot Node is not runnable\n',{mode:0o755});
  await writeFile(join(resources,'snapshot/LICENSE-node.txt'),'CI placeholder: no Node binary is distributed in this fixture.\n');
 }
 else await extractNode(archive,target,executable);
 const result=await build({
  conditions:['source'],
  entryPoints:[join(repo,'apps/desktop/snapshot/import-snapshot.ts')],
  outfile:join(resources,entryPath),bundle:true,platform:'node',target:'node24',format:'esm',metafile:true,
  logLevel:'silent',
 });
 if(Object.keys(result.metafile.inputs).some(path=>/[/\\](?:engine|plur1bus-engine)[/\\]|plur1bus-memory/.test(path))){
  throw Error('snapshot-producer-engine-dependency');
 }
 return {
  nodeVersion:version,
  node:{path:nodePath,sha256:await hashFile(executable)},
  entry:{path:entryPath,sha256:await hashFile(join(resources,entryPath))},
 };
}
