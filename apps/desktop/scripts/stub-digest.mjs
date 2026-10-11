// Locally built images have an image ID (config digest) but no RepoDigest. The runtime, like the bundle, speaks in
// registry manifest digests, so acceptance fixtures obtain one by pushing to a throwaway loopback registry.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export const MANIFEST_ACCEPT='application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json';
export function manifestDigest(value) {
 if(!/^sha256:[a-f0-9]{64}$/.test(value??''))throw new Error('Registry digest missing');
 return value;
}
export function loopbackAddress(portOutput) {
 const address=String(portOutput).split('\n')[0].trim();
 if(!/^127\.0\.0\.1:\d+$/.test(address))throw new Error('Registry must be loopback-only');
 return address;
}
// Pushes each local tag to a loopback registry and returns its manifest digest. The pushed aliases are kept so the
// image keeps its RepoDigest; the caller removes them (cleanup) once the acceptance run is over.
export async function manifestDigests(runtime,tags,registryImage='registry:2') {
 const cli=(args,timeout=30000)=>{const r=spawnSync(runtime,args,{encoding:'utf8',timeout});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${runtime} ${args[0]}: ${r.stderr.slice(-2000)}`);return r.stdout.trim();};
 const aliases=[];let registry;
 const cleanup=()=>{for(const alias of aliases.splice(0))spawnSync(runtime,['image','rm',alias],{stdio:'ignore',timeout:30000});};
 try {
  registry=`p1t-digest-${randomUUID()}`;
  cli(['image','inspect',registryImage]);
  cli(['run','--detach','--name',registry,'--label',`app.plur1bus.test=${registry}`,'--tmpfs','/var/lib/registry','--publish','127.0.0.1::5000',registryImage]);
  const address=loopbackAddress(cli(['port',registry,'5000/tcp']));
  for(let n=0;n<40;n++){try{if((await fetch(`http://${address}/v2/`)).ok)break;}catch{}if(n===39)throw new Error('Registry unavailable');await delay(250);}
  const digests=[];
  for(const [index,tag] of tags.entries()) {
   const alias=`${address}/p1t-stub-digest:i${index}`;
   cli(['tag',tag,alias]);aliases.push(alias);
   cli(['push',...(runtime==='podman'?['--tls-verify=false']:[]),alias],120000);
   const manifest=await fetch(`http://${address}/v2/p1t-stub-digest/manifests/i${index}`,{headers:{Accept:MANIFEST_ACCEPT}});
   if(!manifest.ok)throw new Error('Registry manifest unavailable');
   digests.push(manifestDigest(manifest.headers.get('docker-content-digest')));
   // Podman re-encodes on push, so the registry's manifest digest differs from the one it recorded for the local
   // image. Pulling that exact digest back makes the engine hold what the registry serves, and record it as a
   // RepoDigest of the pinned reference (a pull by digest verifies the content, so nothing is trusted blindly).
   let inspected=alias;
   if(runtime==='podman'){
    inspected=`${address}/p1t-stub-digest@${digests.at(-1)}`;
    cli(['pull','--tls-verify=false',inspected],120000);aliases.push(inspected);
   }
   // Diagnostics: what the engine reports for the pushed alias, to explain any later image_present failure.
   const repoDigests=cli(['image','inspect','--format','{{json .RepoDigests}}',inspected]);
   console.log(`[digest] ${tag} -> ${alias} manifest=${digests.at(-1)} id=${cli(['image','inspect','--format','{{.Id}}',inspected])} repoDigests=${repoDigests}`);
   // The runtime only trusts RepoDigests: fail here, with the evidence above, if the engine did not record the
   // registry's manifest digest for the pushed alias (e.g. a podman push that re-encoded the manifest).
   if(!repoDigests.includes(`@${digests.at(-1)}`))throw new Error(`Engine did not record ${digests.at(-1)} as a RepoDigest of ${inspected}: ${repoDigests}`);
  }
  return {digests,cleanup,tags:()=>aliases.filter(a=>!a.includes('@'))};
 } catch(error) {
  cleanup();throw error;
 } finally {
  if(registry)spawnSync(runtime,['rm','--force',registry],{stdio:'ignore',timeout:30000});
 }
}
