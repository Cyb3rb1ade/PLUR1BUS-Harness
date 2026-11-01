// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (!raw) return '';
  const versions: number[][] = [];
  for (const token of raw.split(',')) {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(token)) return 'error';
    const values = token.replace(/^v/, '').split('.').map(Number);
    if (!values.every(Number.isSafeInteger)) return 'error';
    versions.push(values);
  }
  return [...new Set(versions.sort((a,b) => a[0]!-b[0]! || a[1]!-b[1]! || a[2]!-b[2]!).map(v => v.join('.')))].join(',');
}
