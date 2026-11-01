// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (!raw) return '';
  const ranges: number[][] = [];
  for (const part of raw.split(',')) {
    const m=/^(\d+)\.\.(\d+)$/.exec(part);
    if (!m) return 'error';
    const a=Number(m[1]), b=Number(m[2]);
    if (a >= b || b > 100) return 'error';
    ranges.push([a,b]);
  }
  const result: number[][]=[];
  for (const [a,b] of ranges.sort((a,b)=>a[0]!-b[0]!)) {
    const last=result.at(-1);
    if (last && a! <= last[1]!) last[1]=Math.max(last[1]!,b!); else result.push([a!,b!]);
  }
  return result.map(r=>r.join('..')).join(',');
}
