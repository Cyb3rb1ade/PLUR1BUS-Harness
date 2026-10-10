// Per-chunk stylesheet attachment without FOUC (ADR-004 CSP).
const applied = new Set<string>();

/**
 * Attaches a chunk stylesheet once into the document.
 * Uses CSSStyleSheet and adoptedStyleSheets when available (strictly CSP compliant under style-src 'self'),
 * falling back to a <style> tag.
 */
export function registerChunkCss(name: string, cssText: string): void {
  if (typeof document === "undefined" || applied.has(name)) return;
  applied.add(name);
  if ("adoptedStyleSheets" in document && typeof CSSStyleSheet !== "undefined") {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    } catch {
      // fallback if constructable stylesheets fail
    }
  }
  const tag = document.createElement("style");
  tag.setAttribute("data-chunk-css", name);
  tag.textContent = cssText;
  document.head.appendChild(tag);
}
