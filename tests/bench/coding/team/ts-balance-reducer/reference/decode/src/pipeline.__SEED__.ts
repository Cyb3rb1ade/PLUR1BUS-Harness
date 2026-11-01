// SPDX-License-Identifier: MIT
export function decode(raw: string): string {
  const events:[string,number][]=[];
  if (raw) for (const part of raw.split(';')) {
    const match=/^(add|sub)=(\d+)$/.exec(part);
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2])<=0) return 'error';
    events.push([match[1]!,Number(match[2])]);
  }
  return JSON.stringify(events);
}

export function reduce(_raw: string): string { return "unimplemented"; }

export function report(_raw: string): string { return "unimplemented"; }
