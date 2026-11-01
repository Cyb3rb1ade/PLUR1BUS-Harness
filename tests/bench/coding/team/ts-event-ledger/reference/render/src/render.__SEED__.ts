// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  const match = /^(\d+),(-?\d+)$/.exec(raw);
  return match && match.slice(1).every(value => Number.isSafeInteger(Number(value))) ? `events=${Number(match[1])};total=${Number(match[2])}` : 'error';
}
