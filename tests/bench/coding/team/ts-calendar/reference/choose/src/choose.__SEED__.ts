// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (!raw) return 'none';
  const ranges:number[][]=[];
  for (const part of raw.split(',')) {
    const m=/^(\d+)\.\.(\d+)$/.exec(part);
    if (!m || Number(m[1]) >= Number(m[2]) || Number(m[2]) > 100) return 'error';
    ranges.push([Number(m[1]),Number(m[2])]);
  }
  ranges.sort((a,b)=>(b[1]!-b[0]!)-(a[1]!-a[0]!) || a[0]!-b[0]!);
  return ranges[0]!.join('..');
}
