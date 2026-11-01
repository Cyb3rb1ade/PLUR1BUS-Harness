// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (!raw) return 'none';
  const rows = raw.split(',');
  if (rows.some(row => !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(row) || !row.split('.').map(Number).every(Number.isSafeInteger))) return 'error';
  return rows.sort((a,b) => { const x=a.split('.').map(Number), y=b.split('.').map(Number); return x[0]!-y[0]! || x[1]!-y[1]! || x[2]!-y[2]!; }).at(-1)!;
}
