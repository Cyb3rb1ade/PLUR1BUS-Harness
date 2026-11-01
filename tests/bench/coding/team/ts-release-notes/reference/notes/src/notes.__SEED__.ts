// SPDX-License-Identifier: MIT
export function solve(raw: string): string {
  if (raw === 'none') return 'No releases\n';
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(raw) ? `## Release ${raw}\n` : 'error';
}
