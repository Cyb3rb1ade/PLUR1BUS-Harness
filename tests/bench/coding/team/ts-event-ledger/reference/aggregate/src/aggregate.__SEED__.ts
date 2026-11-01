// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (!raw) return '0,0';
  const rows = raw.split(';');
  let total = 0;
  for (const row of rows) {
    const match = /^[A-Za-z0-9_]+:(-?\d+)$/.exec(row);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return 'error';
    total += Number(match[1]);
    if (!Number.isSafeInteger(total)) return 'error';
  }
  return `${rows.length},${total}`;
}
