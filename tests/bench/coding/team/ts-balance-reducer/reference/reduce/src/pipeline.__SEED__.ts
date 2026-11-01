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

export function reduce(raw: string): string {
  try {
    const events:unknown=JSON.parse(raw);
    if (!Array.isArray(events)) return 'error';
    let balance=0,accepted=0,rejected=0;
    for (const event of events) {
      if (!Array.isArray(event) || event.length!==2 || !['add','sub'].includes(event[0]) || !Number.isSafeInteger(event[1]) || Number(event[1])<=0) return 'error';
      const amount=Number(event[1]);
      if (event[0]==='sub' && amount>balance) { rejected++; continue; }
      balance+=event[0]==='add'?amount:-amount;
      if (!Number.isSafeInteger(balance)) return 'error';
      accepted++;
    }
    return JSON.stringify({balance,accepted,rejected});
  } catch { return 'error'; }
}

export function report(_raw: string): string { return "unimplemented"; }
