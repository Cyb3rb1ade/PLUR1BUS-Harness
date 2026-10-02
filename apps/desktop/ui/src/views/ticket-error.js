'use strict';
const locale = document.documentElement.dataset.locale;
const german = locale === 'de' || (locale !== 'en' && navigator.language.toLowerCase().startsWith('de'));
if (german) {
  document.documentElement.lang = 'de';
  const strings = {title:'Anmeldung fehlgeschlagen', detail:'Das einmalige Anmeldeticket konnte auch nach einem erneuten Versuch nicht eingelöst werden.', safe:'Deine Laufzeitumgebung und Daten sind unverändert.', copy:'Log kopieren', retry:'Erneut versuchen'};
  for (const [id, text] of Object.entries(strings)) document.getElementById(id).textContent = text;
}
document.getElementById('copy').addEventListener('click', async () => {
  const log = 'desktop.spa.ticket_failed: Single-use ticket redemption failed after one retry. Runtime and data untouched.';
  try { await navigator.clipboard.writeText(log); document.getElementById('copied').textContent = german ? 'Log kopiert.' : 'Log copied.'; }
  catch { document.getElementById('copied').textContent = log; }
});
