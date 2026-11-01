// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  let end=0; const result:string[]=[];
  if (raw) for (const part of raw.split(',')) {
    const m=/^(\d+)\.\.(\d+)$/.exec(part);
    if (!m) return 'error';
    const a=Number(m[1]),b=Number(m[2]);
    if (a < end || a >= b || b > 100) return 'error';
    if (a > end) result.push(`${end}..${a}`);
    end=b;
  }
  if (end < 100) result.push(`${end}..100`);
  return result.join(',');
}
