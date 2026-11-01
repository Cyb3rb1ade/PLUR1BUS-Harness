// SPDX-License-Identifier: MIT
export function decode(raw: string): string {
  const rows: [string,number][]=[];
  if (raw) for (const token of raw.split(';')) {
    const match=/^([A-Za-z0-9_]+):(-?\d+)$/.exec(token);
    if (!match || !Number.isSafeInteger(Number(match[2]))) return 'error';
    rows.push([match[1]!,Number(match[2])]);
  }
  return JSON.stringify({version:1,rows});
}

export function migrate(_raw: string): string { return "unimplemented"; }

export function project(_raw: string): string { return "unimplemented"; }
