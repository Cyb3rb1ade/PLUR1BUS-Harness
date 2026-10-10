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

/** Keep keyboard traversal inside native modal dialogs, including dynamically disabled actions. */
export function trapDialogFocus(dialog: HTMLDialogElement): void {
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,[tabindex]"))
      .filter(node => !node.matches(":disabled") && node.tabIndex >= 0 && node.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
