const result = {};
(async () => {
  document.title = 'WP5_STAGE:entry';
  const until = Date.now() + 20000;
  document.title = 'WP5_STAGE:ready-wait';
  while (!window.mockReady && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  document.title = 'WP5_STAGE:ready';
  result.loggedIn = document.getElementById('identity')?.textContent === 'mock-owner';
  result.fragmentGone = !location.hash;
  result.cookieStoreEmpty = document.cookie === '';
  document.title = 'WP5_STAGE:ipc';
  try { const info = await window.__TAURI_INTERNALS__.invoke('shell_info'); result.shellInfo = info.product === 'PLUR1BUS' && info.features.length === 0; } catch { result.shellInfo = false; }
  try { await window.__TAURI_INTERNALS__.invoke('app_info'); result.onlyShellInfo = false; } catch { result.onlyShellInfo = true; }
  document.title = 'WP5_STAGE:fetch';
  const good = await fetch('/api/v1/session/check', {method:'POST',headers:{'x-csrf-token':window.mockCsrf}});
  const missing = await fetch('/api/v1/session/check', {method:'POST'});
  const wrong = await fetch('/api/v1/session/check', {method:'POST',headers:{'x-csrf-token':'wrong'}});
  result.csrf = good.ok && missing.status === 403 && wrong.status === 403;
  const started = performance.now();
  const stream = await fetch('/events');
  const reader = stream.body.getReader();
  document.title = 'WP5_STAGE:sse-first';
  const first = await reader.read();
  result.sseFirstMs = performance.now() - started;
  result.sseUnbuffered = result.sseFirstMs < 2000 && !first.done;
  document.title = 'WP5_STAGE:sse-second';
  const second = await reader.read();
  result.sseSurvivesTenSeconds = !second.done && performance.now() - started > 10000;
  await reader.cancel();
  document.title = 'WP5_STAGE:websocket';
  result.websocket = await new Promise(resolve => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
    const timeout = setTimeout(() => { ws.close(); resolve(false); }, 15000);
    ws.onopen = () => ws.send('native-echo');
    ws.onmessage = e => { clearTimeout(timeout); ws.close(); resolve(e.data === 'native-echo'); };
    ws.onerror = () => { clearTimeout(timeout); resolve(false); };
  });
  const inline = document.createElement('script'); inline.textContent = 'window.mockForbiddenInline = true'; document.head.appendChild(inline); result.inlineCspBlocked = !window.mockForbiddenInline;
  document.title = 'WP5_STAGE:download';
  const download = new Uint8Array(await fetch('/__test/download').then(r => r.arrayBuffer())); result.download10MiB = download.byteLength === 10*1024*1024 && download.every(byte => byte === 0x5a);
  document.title = 'WP5_STAGE:foreign';
  result.foreignRedirectBlocked = (await fetch('/__test/foreign-redirect?target=' + encodeURIComponent(FOREIGN + '/foreign-redirect'))).status === 502;
  const bytes = await fetch('/spa.js').then(r => r.arrayBuffer()); result.selfAsset = bytes.byteLength > 0;
  result.foreignFetchBlocked = await fetch(FOREIGN + '/foreign-fetch').then(() => false, () => true);
  result.foreignImageBlocked = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve(false); image.onerror = () => resolve(true); image.src = FOREIGN + '/foreign-image'; });
  result.foreignWebsocketBlocked = await new Promise(resolve => { let ws; try { ws = new WebSocket(FOREIGN.replace(/^http/, 'ws') + '/foreign-ws'); } catch { resolve(true); return; } ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true); setTimeout(() => { ws.close(); resolve(false); }, 2000); });
  document.title = 'WP5_STAGE:terminal';
  document.title = 'WP5:'  + JSON.stringify(result);
})().catch(() => { document.title = 'WP5_STAGE:failed'; document.title = 'WP5:' + JSON.stringify({...result,probeFailed:true}); });
