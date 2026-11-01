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

export function migrate(raw: string): string {
  try {
    const value=JSON.parse(raw) as {version?:unknown;rows?:unknown};
    if (!value || value.version!==1 || !Array.isArray(value.rows)) return 'error';
    const sums=new Map<string,number>();
    for (const row of value.rows) {
      if (!Array.isArray(row) || row.length!==2 || typeof row[0]!=='string' || !/^[A-Za-z0-9_]+$/.test(row[0]) || !Number.isSafeInteger(row[1])) return 'error';
      const id=row[0].toLowerCase(), next=(sums.get(id)??0)+Number(row[1]);
      if (!Number.isSafeInteger(next)) return 'error';
      sums.set(id,next);
    }
    return JSON.stringify({version:2,accounts:[...sums].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,balance])=>({id,balance}))});
  } catch { return 'error'; }
}

export function project(raw: string): string {
  try {
    const value=JSON.parse(raw) as {version?:unknown;accounts?:unknown};
    if (!value || value.version!==2 || !Array.isArray(value.accounts)) return 'error';
    const seen=new Set<string>(); let total=0;
    for (const item of value.accounts) {
      if (!item || typeof item!=='object' || typeof item.id!=='string' || seen.has(item.id) || !Number.isSafeInteger(item.balance)) return 'error';
      seen.add(item.id); total+=Number(item.balance); if (!Number.isSafeInteger(total)) return 'error';
    }
    return `accounts=${seen.size};balance=${total}`;
  } catch { return 'error'; }
}
