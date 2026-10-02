// Executed only by the explicitly launched diagnostic example, never the shell.
addEventListener('DOMContentLoaded', async () => {
  const out = {kind: SPIKE.kind, userAgent: navigator.userAgent, origin: location.origin,
    cookieBefore: document.cookie, violations: []};
  addEventListener('securitypolicyviolation', e => out.violations.push({directive: e.effectiveDirective, blocked: e.blockedURI.split('?')[0]}));
  const url = (base, path) => `${base}${path}?key=${encodeURIComponent(SPIKE.key)}`;
  const attempt = async fn => {try {return await fn();} catch (e) {return {error: String(e)};}};
  const fetchTimed = async target => {
    const start = performance.now();
    const response = await fetch(target, {cache: 'no-store', signal: AbortSignal.timeout(5000)});
    const body = await response.arrayBuffer();
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return {ms: performance.now() - start, bytes: body.byteLength, body};
  };
  const wsProbe = target => new Promise(resolve => {
    const start = performance.now(); let socket;
    const finish = result => {clearTimeout(timer); if(socket) socket.close(); resolve(result);};
    const timer = setTimeout(() => finish({outcome: 'timeout'}), 2500);
    try {
      socket = new WebSocket(target);
      socket.onopen = () => socket.send('native-spike-echo');
      socket.onmessage = event => finish({outcome: 'echo', payload: event.data, ms: performance.now()-start});
      socket.onerror = () => finish({outcome:'error',ms:performance.now()-start});
    } catch (e) {finish({outcome:'constructor-rejected',error:String(e)});}
  });
  const sseProbe = target => new Promise(resolve => {
    const start = performance.now(); const events=[]; let stream;
    const finish = outcome => {clearTimeout(timer); if(stream)stream.close(); resolve({outcome,events});};
    const timer = setTimeout(() => finish('timeout'), 5000);
    try {
      stream = new EventSource(target);
      stream.onmessage = e => {events.push({data:e.data,ms:performance.now()-start});if(events.length===2)finish('two-events');};
      stream.onerror = () => finish('error');
    } catch(e) {finish(String(e));}
  });
  out.cspSelfScript = await new Promise(resolve => {
    const node = document.createElement('script'); node.src=url(SPIKE.base,'/self.js');
    const timer=setTimeout(()=>resolve({loaded:false,timeout:true}),3000);
    node.onload=()=>{clearTimeout(timer);resolve({loaded:window.spikeSelfScript===true});};
    node.onerror=()=>{clearTimeout(timer);resolve({loaded:false});};document.head.append(node);
  });
  out.cspForeignScript = await new Promise(resolve => {
    const node=document.createElement('script');
    node.src=url(SPIKE.direct.replace('127.0.0.1','localhost'),'/self.js');
    const timer=setTimeout(()=>resolve({loaded:false,timeout:true}),2000);
    node.onload=()=>{clearTimeout(timer);resolve({loaded:true});};
    node.onerror=()=>{clearTimeout(timer);resolve({loaded:false});};
    document.head.append(node);
  });
  for(const [key,command] of [['localCapability','app_info'],['remoteCapability','settings_get']]) {
    out[key] = await attempt(()=>Promise.race([
      window.__TAURI_INTERNALS__.invoke(command),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('IPC timeout')),3000))]));
  }
  out.requestOrigin = await attempt(async () => JSON.parse(new TextDecoder().decode((await fetchTimed(url(SPIKE.base,'/ping'))).body)));
  out.postOrigin = await attempt(async () => (await fetch(url(SPIKE.base, '/ping'), {method: 'POST', signal: AbortSignal.timeout(5000)})).json());
  out.sse = await sseProbe(url(SPIKE.base,'/events'));
  out.directSse = await sseProbe(url(SPIKE.direct,'/events'));
  out.websocket = await wsProbe(url(SPIKE.base.replace(/^http/,'ws'),'/ws'));
  if (SPIKE.kind==='custom') out.mappedWebsocket = await wsProbe(url('ws://plur1bus-harness.localhost','/ws'));
  out.download = await attempt(async()=>{
    const result=await fetchTimed(url(SPIKE.base,'/download'));
    const bytes=new Uint8Array(result.body);
    return {bytes:result.bytes,ms:result.ms,allBytesCorrect:bytes.every(b=>b===0x5a)};
  });
  out.latency = await attempt(async()=>{
    const overhead=[],direct=[],proxy=[];
    for(let n=0;n<110;n++) {
      let a,b;
      if(n%2){b=await fetchTimed(url(SPIKE.base,'/ping'));a=await fetchTimed(url(SPIKE.direct,'/ping'));}
      else {a=await fetchTimed(url(SPIKE.direct,'/ping'));b=await fetchTimed(url(SPIKE.base,'/ping'));}
      if(n>=10){overhead.push(b.ms-a.ms);direct.push(a.ms);proxy.push(b.ms);}
    }
    const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
    return {samples:overhead.length,p95OverheadMs:p95(overhead),p95DirectMs:p95(direct),p95ProxyMs:p95(proxy),within5ms:p95(overhead)<=5,pairedOverheadMs:overhead};
  });
  out.cookieAfter=document.cookie;
  location.href=`spike-result://localhost/?data=${encodeURIComponent(JSON.stringify(out).replaceAll(SPIKE.key, "[ephemeral-key]"))}`;
});
