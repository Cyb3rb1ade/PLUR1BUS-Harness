import { lstat, realpath, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
/** Explicit cache root may be mounted elsewhere; no artifact component may redirect outside it. */
export async function artifactPath(directory,name,createParents=false) {
  if(typeof name!=='string'||!name||name.startsWith('/')||!/^[A-Za-z0-9_./-]+$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('invalid catalog path');
  const root=await realpath(directory),parts=name.split('/');let current=root;
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);const parent=i<parts.length-1;
    let info;
    try{info=await lstat(current);}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(parent&&createParents){try{await mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}info=await lstat(current);}
      else if(parent)throw e;
    }
    if(info?.isSymbolicLink())throw Error('artifact symlink');
    if(info&&(parent?!info.isDirectory():!info.isFile()))throw Error('invalid catalog file type');
  }
  return current;
}
