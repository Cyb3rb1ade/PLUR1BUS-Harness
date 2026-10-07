// Styles of the chat page. app.css belongs to the shell, so the page ships its own sheet as a constructable stylesheet
// (adoptedStyleSheets): it needs no inline <style> and no extra file, so the strict CSP of ADR-004 stays untouched.
// Follow-up: move these rules to src/styles/app.css when the shell owner allows it, then delete this file.
const CSS = `
.chat-list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.chat-list-head h2 { margin: 0; font-size: 16px; }
.chat-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.chat-row { display: grid; gap: 2px; min-height: var(--nav-h); padding: 8px 12px; border-radius: 10px; text-decoration: none; color: var(--ink); }
.chat-row:hover { background: var(--hover-bg); }
.chat-row[aria-current="page"] { background: var(--active-bg); box-shadow: 0 0 0 1px var(--line); }
.chat-row-title { font-weight: 600; overflow-wrap: anywhere; }
.chat-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--ink-2); font-size: 12.5px; }
.chat-note { margin: 0; color: var(--ink-2); font-size: 13px; }
.chat-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.chat-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.chat-head h2 { margin: 0; font-size: 18px; line-height: 1.3; overflow-wrap: anywhere; }
.chat-log { display: grid; align-content: start; gap: 12px; min-height: 200px; max-height: calc(100dvh - 360px); overflow-y: auto; padding: 4px; }
.chat-empty { margin: 0; color: var(--ink-2); }
.msg { display: grid; gap: 4px; max-width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); }
.msg[data-role="user"] { background: var(--hover-bg); }
.msg[data-role="tool"] { padding: 6px 12px; font-size: 13px; color: var(--ink-2); }
.msg-who { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.msg-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
.msg-text:empty { display: none; }
.msg-detail { margin: 0; font-size: 13px; color: var(--err-ink); overflow-wrap: anywhere; }
.chat-notice { margin: 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--err-border); background: var(--err-bg); color: var(--err-ink); font-size: 13.5px; }
.chat-compose { display: grid; gap: 8px; }
.chat-compose textarea { box-sizing: border-box; width: 100%; min-height: calc(var(--control-h) * 2); padding: 10px 12px; font: inherit; color: var(--ink); background: var(--field-bg); border: 1px solid var(--field-border); border-radius: 10px; resize: vertical; }
.chat-compose-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.chat-hint { margin: 0; color: var(--ink-2); font-size: 12.5px; }
.chat-compose .btn[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.chat-field { display: grid; gap: 6px; }
.chat-field label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.chat-check { display: flex; align-items: center; gap: 10px; min-height: var(--control-h); }
.chat-check input { width: 24px; height: 24px; min-height: 0; padding: 0; margin: 0; flex: none; }
`;

let installed = false;

/** Adds the sheet once. Without constructable-stylesheet support the page still works, just unstyled. */
export function installChatStyles(): void {
  if (installed) return;
  installed = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* unsupported: unstyled but usable */ }
}
