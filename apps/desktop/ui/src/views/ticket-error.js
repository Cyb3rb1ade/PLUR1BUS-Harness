'use strict';
if (document.documentElement.dataset.theme === 'system') {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const {catalogues} = await import('/__shell/catalogue.js');
const locale = document.documentElement.dataset.locale;
const german = locale === 'de' || (locale !== 'en' && /^de(?:[-_]|$)/i.test(navigator.language));
const t = key => catalogues[german ? 'de' : 'en'][key];
document.documentElement.lang = german ? 'de' : 'en';
for (const id of ['title', 'detail', 'safe', 'copy', 'retry']) document.getElementById(id).textContent = t(`ticket.${id}`);
document.title = t('ticket.documentTitle');
document.getElementById('copy').addEventListener('click', async () => {
  const log = 'desktop.spa.ticket_failed: Single-use ticket redemption failed after one retry. Runtime and data untouched.';
  try { await navigator.clipboard.writeText(log); document.getElementById('copied').textContent = t('ticket.copied'); }
  catch { document.getElementById('copied').textContent = log; }
});
