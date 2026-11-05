void (async () => {
  if (location.pathname !== '/__shell/ticket-error') return;
  // The page's module sets the localized title after its catalogue import resolves.
  await import('/__shell/error.js');
  const controls = ['copy', 'retry'].map(id => document.getElementById(id));
  document.title = 'ERR:' + JSON.stringify({
    savedTheme: document.documentElement.dataset.theme,
    savedLocale: document.documentElement.lang,
    terminalError: location.pathname === '/__shell/ticket-error',
    fragmentGone: !location.hash,
    controls44: controls.every(control => {
      const rect = control?.getBoundingClientRect();
      return rect && rect.width >= 44 && rect.height >= 44;
    }),
    honestError: document.getElementById('detail').textContent.length > 20 &&
      document.getElementById('safe').textContent.length > 10,
  });
})()
