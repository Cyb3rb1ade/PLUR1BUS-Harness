'use strict';
async function main() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('t');
  if (location.pathname === '/auth/ticket') {
    const redeemed = ticket && await fetch('/api/v1/auth/ticket/redeem', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});
    if (!redeemed || !redeemed.ok) { history.replaceState(null, '', '/auth/ticket'); location.replace('/auth/ticket-failed'); return; }
    const result = await redeemed.json();
    window.mockCsrf = result.csrf; // Provisional SPA session token, kept only in this renderer's memory.
    history.replaceState(null, '', '/');
  }
  const res = await fetch('/api/v1/auth/whoami');
  if (res.ok) { const user = await res.json(); document.getElementById('identity').textContent = user.userId; }
  if (window.__TAURI_INTERNALS__?.invoke) {
    try { const info = await window.__TAURI_INTERNALS__.invoke('shell_info'); document.getElementById('bridge').textContent = JSON.stringify(info); } catch { document.getElementById('bridge').textContent = 'Bridge unavailable'; }
  }
  window.mockReady = true;
}
main().catch(() => { document.getElementById('identity').textContent = 'Sign-in failed'; });
