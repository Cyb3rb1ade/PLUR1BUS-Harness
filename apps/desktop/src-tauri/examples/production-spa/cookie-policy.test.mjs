import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../../../ui/node_modules/playwright/index.mjs';

const policy = await readFile(new URL('../../src/windows_spa_cookie_policy.js', import.meta.url), 'utf8');
test('native backing store stays empty across direct, descriptor and frame attempts', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    await context.addInitScript(policy);
    await context.route('http://127.0.0.1/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>cookie challenge</title>'}));
    const page = await context.newPage();
    await page.goto('http://127.0.0.1/');
    const result = await page.evaluate(async () => {
      const attempt = target => {
        target.document.cookie = 'canary=direct; Path=/';
        Object.getOwnPropertyDescriptor(target.Document.prototype, 'cookie').set.call(target.document, 'canary=descriptor; Path=/');
        let redefined = false;
        try { Object.defineProperty(target.Document.prototype, 'cookie', {set() {}}); redefined = true; } catch {}
        // Cross-realm document wrappers may accept harmless JS expandos. They
        // must never recover the native setter or reach the backing cookie store.
        try { Object.defineProperty(target.document, 'cookie', {value:'shadow'}); } catch {}
        return !redefined && Object.getOwnPropertyDescriptor(target.Document.prototype, 'cookie').get.call(target.document) === '';
      };
      const main = attempt(window);
      const frame = document.createElement('iframe');
      frame.src = '/child';
      const loaded = new Promise(resolve => frame.onload = resolve);
      document.body.append(frame);
      // Newly created about:blank realm must not supply an unguarded native setter.
      let synchronous = true;
      try { synchronous = attempt(frame.contentWindow); } catch { synchronous = false; }
      await loaded;
      const child = attempt(frame.contentWindow);
      return {main, synchronous, child};
    });
    assert.deepEqual(result, {main:true,synchronous:true,child:true});
    assert.deepEqual(await context.cookies(), []);
  } finally { await browser.close(); }
});

test('guarded SPA keeps same-origin API usable while browser cookie APIs stay blocked', async () => {
  const {createServer} = await import('node:http');
  const server = createServer((request, response) => {
    if (request.url === '/api') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>guarded SPA</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    await context.addInitScript(policy);
    const page = await context.newPage();
    await page.goto(origin);
    assert.deepEqual(await page.evaluate(async () => {
      const response = await fetch('/api');
      document.cookie = 'canary=browser; Path=/';
      return {status: response.status, body: await response.json(), cookie: document.cookie};
    }), {status:200, body:{ok:true}, cookie:''});
    assert.deepEqual(await context.cookies(), []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('secure-context Cookie Store and service-worker prototype/frame bypasses are blocked', async () => {
  const {createServer} = await import('node:http');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url?.endsWith('.js') ? 'application/javascript' : 'text/html');
    response.end(request.url === '/sw.js' ? "self.addEventListener('install', () => self.skipWaiting());" : request.url === '/worker.js' ? "postMessage(typeof cookieStore);" : '<!doctype html><title>secure policy</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true});
  try {
    const baseline = await browser.newContext();
    const control = await baseline.newPage();
    await control.goto(origin);
    assert.equal(await control.evaluate(async () => {
      await cookieStore.set('positive', 'cookie-store');
      const registration = await navigator.serviceWorker.register('/sw.js');
      await registration.unregister();
      return true;
    }), true);
    assert.equal((await baseline.cookies()).some(cookie => cookie.name === 'positive'), true);
    await baseline.close();
    const context = await browser.newContext();
    await context.addInitScript(policy);
    const page = await context.newPage();
    await page.goto(origin);
    const guarded = await page.evaluate(async () => {
      const attempt = async target => {
        await target.cookieStore.set('blocked', 'direct');
        await target.CookieStore.prototype.set.call(target.cookieStore, 'blocked', 'prototype');
        let redefine = false;
        try { Object.defineProperty(target.CookieStore.prototype, 'set', {value: () => {}}); redefine = true; } catch {}
        let denied = 0;
        for (const register of [() => target.navigator.serviceWorker.register('/sw.js'),
          () => target.ServiceWorkerContainer.prototype.register.call(target.navigator.serviceWorker, '/sw.js')]) {
          try { await register(); } catch (error) { if (error.name === 'SecurityError') denied++; }
        }
        let workerRedefine = false;
        try { Object.defineProperty(target.ServiceWorkerContainer.prototype, 'register', {value: () => {}}); workerRedefine = true; } catch {}
        return !redefine && !workerRedefine && denied === 2;
      };
      const main = await attempt(window);
      const child = document.createElement('iframe');
      child.src = '/child';
      const loaded = new Promise(resolve => child.onload = resolve);
      document.body.append(child);
      await loaded;
      const frame = await attempt(child.contentWindow);
      const workerCookieStore = await new Promise((resolve, reject) => { const worker = new Worker('/worker.js'); worker.onmessage = e => { worker.terminate(); resolve(e.data); }; worker.onerror = reject; });
      return {main, frame, registrations:(await navigator.serviceWorker.getRegistrations()).length,workerCookieStore};
    });
    assert.deepEqual(guarded, {main:true,frame:true,registrations:0,workerCookieStore:'undefined'});
    assert.deepEqual(await context.cookies(), []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
