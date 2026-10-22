// Shared model-catalog preparation seam; caller supplies the Harness HostFetch port (#602).
// Kept outside product runtime until D70 module/dependency wiring is available.
import { mkdir, rename, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { artifactPath } from './decision-laya-paths.mjs';
import { verifyArtifacts } from './decision-laya.mjs';
export async function prepareLaya({directory,manifest,hostFetch,signal}) {
  if(typeof hostFetch!=='function')throw Error('HostFetch required');
  if(manifest.repository!=='inferenceprince/laya-onnx'||!/^[a-f0-9]{40}$/.test(manifest.revision))throw Error('invalid catalog revision');
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const file of manifest.files){
    signal?.throwIfAborted();
    if(typeof file.file!=='string'||!file.file||file.file.startsWith('/')||file.file.split('/').some(p=>p==='.'||p==='..'||!p)||!/^[A-Za-z0-9_./-]+$/.test(file.file)||!Number.isSafeInteger(file.size)||file.size<1||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid catalog artifact');
    const target=await artifactPath(directory,file.file,true);
    // A valid cache entry is reused; .part files are never inspected as models.
    try{await verifyArtifacts(directory,{files:[file]});continue;}catch{/* Re-fetch a corrupt/missing entry. */}
    const response=await hostFetch(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.file}`,{signal});
    if(response.status!==200||!response.body)throw Error('artifact status');
    const temp=`${target}.${randomUUID()}.part`;let handle,reader;
    try{
      handle=await open(temp,'wx',0o600);reader=response.body.getReader();
      const hash=createHash('sha256');let size=0;
      for(;;){
        signal?.throwIfAborted();const {value,done}=await reader.read();signal?.throwIfAborted();if(done)break;
        size+=value.byteLength;if(size>file.size)throw Error('artifact size');
        hash.update(value);await handle.writeFile(value);
      }
      if(size!==file.size)throw Error('artifact size');
      if(hash.digest('hex')!==file.sha256)throw Error('artifact digest');
      await handle.sync();await handle.close();handle=undefined;
      // Recheck immediately before promotion, including every existing parent.
      await artifactPath(directory,file.file);
      await rename(temp,target);
    }finally{
      await handle?.close();await reader?.cancel().catch(()=>{});await rm(temp,{force:true});
    }
  }
  await verifyArtifacts(directory,manifest);
  return {repository:manifest.repository,revision:manifest.revision,verified:manifest.files.length};
}
