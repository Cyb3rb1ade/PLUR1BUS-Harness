export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function append(parent: HTMLElement, ...children: (Node | null | undefined)[]): void {
  for (const child of children) if (child) parent.append(child);
}

export function restoreFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected) { opener.focus(); return; }
  // Shell rerenders replace controls while an overlay is open. Resolve the new
  // node by its stable key rather than trying to focus the detached old node.
  const key = opener?.dataset.focusKey;
  if (key) Array.from(document.querySelectorAll<HTMLElement>("[data-focus-key]"))
    .find(node => node.dataset.focusKey === key)?.focus();
}
