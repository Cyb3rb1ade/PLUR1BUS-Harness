// Text form of an address for notices (desktop transport choice, spec §4.5). Pure, no I/O, no node imports: the web UI
// bundles it together with `ip.ts`. Kept out of `ip.ts` so the classifier stays exactly the snapshot the Rust crate mirrors.
import { canonical, type ParsedAddress } from "./ip.ts";

/**
 * The address as a person would write it: dotted quad for IPv4 and for an IPv4-mapped IPv6 address (`::ffff:1.0.0.0`
 * reads as `1.0.0.0`, which is the address the range example is about), otherwise canonical IPv6 text (lower case, the
 * longest run of two or more zero groups, the first on a tie, as `::`).
 */
export function formatAddress(address: ParsedAddress): string {
  const a = canonical(address);
  if (a.family === 4) return Array.from(a.bytes).join(".");
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((a.bytes[i]! << 8) | a.bytes[i + 1]!);
  let start = -1;
  let length = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > length) { start = i; length = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (length < 2) return hex.join(":");
  return `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}`;
}
