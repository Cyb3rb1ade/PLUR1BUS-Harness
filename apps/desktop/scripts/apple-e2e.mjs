import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function appleReport({platform,version}) {
 const reason=platform!=='darwin'?'macOS required':!version?'Apple container CLI unavailable':null;
 return {schema:'desktop.apple-e2e/1',status:reason?'skipped':'scaffold',reason:reason??'Real image, Apple hardware and owner acceptance required; availability probe only',version};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const result=process.platform==='darwin'?spawnSync('container',['--version'],{encoding:'utf8',timeout:10000}):null;
 const version=result?.status===0?result.stdout.trim():null;
 const report=appleReport({platform:process.platform,version});
 const safe=(version??'unavailable').replace(/[^a-zA-Z0-9.-]/g,'-').slice(0,80);
 writeFileSync(`apple-e2e-${safe}.json`,JSON.stringify(report,null,2)+'\n');
 console.log(`${report.status.toUpperCase()}: ${report.reason}`);
}
