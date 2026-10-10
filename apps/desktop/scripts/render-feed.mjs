import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
/** Publisher helper: preserve native assets and hash the exact separately hosted manifests. */
export function renderFeed(metadata,bundle,latest) {
 const updater=JSON.parse(latest.toString());
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(updater.version!==metadata.version||typeof updater.notes!=='string'||!updater.platforms)throw new Error('Tauri static manifest version/notes/platforms required');
 if(!['stable','beta','dev'].includes(metadata.channel)||!['major','minor','patch'].includes(metadata.kind)||typeof metadata.security!=='boolean'||!metadata.notes?.de||!metadata.notes?.en||!metadata.minFromVersion||!/^\d{4}-\d{2}-\d{2}$/.test(metadata.date))throw new Error('Release metadata missing');
 if(metadata.kind==='major'&&(!metadata.migrationNote?.de||!metadata.migrationNote?.en))throw new Error('Major migration notes required');
 const model=JSON.parse(bundle.toString());if(model.version!==metadata.version)throw new Error('Bundle product version mismatch');
 return {...metadata,bundle:digest(bundle),tauri:digest(latest)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [metadata,bundle,latest,out]=process.argv.slice(2);
 if(!out)throw new Error('Usage: render-feed.mjs metadata.json bundle.json latest.json output.json');
 const release=renderFeed(JSON.parse(await readFile(metadata,'utf8')),await readFile(bundle),await readFile(latest));
 await writeFile(out,JSON.stringify(release,null,2)+'\n',{flag:'wx'});
}
