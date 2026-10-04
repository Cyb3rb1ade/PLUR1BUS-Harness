// Runs before page scripts in every WebView2 document/frame. Session cookies belong
// exclusively to the Rust proxy jar. Do not replace this with post-hoc deletion.
(() => {
  'use strict';
  const previous = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  const descriptor = previous?.configurable === false ? previous
    : {get: () => '', set: () => {}, enumerable: true, configurable: false};
  // Chromium can retain the guarded prototype between the initial about:blank
  // document and the frame's first navigation. Reuse its exact accessors then.
  Object.defineProperty(Document.prototype, 'cookie', descriptor);
  // Prevent per-document shadowing and prototype replacement from undoing the guard.
  Object.defineProperty(document, 'cookie', descriptor);
})();

// Cookie Store is an independent native-cookie writer. A fresh owned profile has
// no service workers; deny registration so a worker cannot obtain an unguarded
// Cookie Store realm. Ordinary dedicated/shared workers remain available.
(() => {
  'use strict';
  const lock = (object, name, value) => {
    if (!object) return;
    const existing = Object.getOwnPropertyDescriptor(object, name);
    if (existing?.configurable === false) return;
    Object.defineProperty(object, name, {value, writable:false, configurable:false});
  };
  if (typeof CookieStore !== 'undefined') {
    lock(CookieStore.prototype, 'set', () => Promise.resolve());
    lock(CookieStore.prototype, 'delete', () => Promise.resolve());
  }
  if (typeof ServiceWorkerContainer !== 'undefined') {
    lock(ServiceWorkerContainer.prototype, 'register', () =>
      Promise.reject(new DOMException('Service workers are unavailable in the SPA window', 'SecurityError')));
  }
})();
