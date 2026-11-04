/** Bound work to the retained prefix and avoid creating a dangling high surrogate at its cut. */
export function wellFormedPrefix(text: string, limit: number): string {
  let end = Math.max(0, limit);
  if (end < text.length && end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return text.slice(0, end).toWellFormed();
}
