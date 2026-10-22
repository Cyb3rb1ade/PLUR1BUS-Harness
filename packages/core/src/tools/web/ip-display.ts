// Text form of an address or range for notices (desktop transport choice, spec §4.5). Pure, no I/O, no node imports: the
// web UI bundles it together with `ip.ts`. Kept out of `ip.ts` so the classifier stays exactly the snapshot the Rust crate
// mirrors. Not `guard.ts`'s `formatAddress`: that one prints IPv6 uncompressed and imports `node:dns`.
import { canonical, type Cidr, type ParsedAddress } from "./ip.ts";

/**
 * The address as a person would write it: dotted quad for IPv4 and for an IPv4-mapped IPv6 address (`::ffff:1.0.0.0`
 * reads as `1.0.0.0`, which is the address the range example is about), otherwise canonical IPv6 text (lower case, the
 * longest run of two or more zero groups, the first on a tie, as `::`).
 *
 * The `::` compression must agree with `formatV6` in `packages/remote-access/src/net-address.ts`, which prints the CIDR
 * of the same list in the Doctor row (that file imports `node:net`, so the web cannot take it, and `remote-access` does
 * not import core, hence the copy). `packages/api/test/net-bridge.test.ts` compares the two.
 */
export function formatWitness(address: ParsedAddress): string {
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

/**
 * The range as the allow-list normalises it (`remote-access` `formatCidr`): host bits cleared, an IPv4-mapped range of
 * `/96` or longer as the IPv4 range it names (`::ffff:8.8.8.0/120` is `8.8.8.0/24`), the address as `formatWitness`
 * prints it. So the Doctor row and the UI notice name a range the same way, whatever was typed.
 */
export function formatRange(range: Cidr): string {
  let { family, bytes, prefix } = range;
  if (family === 6 && prefix >= 96 && canonical({ family, bytes }).family === 4) { family = 4; bytes = bytes.slice(12); prefix -= 96; }
  const masked = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    masked[i] = bytes[i]! & (bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff);
  }
  return `${formatWitness({ family, bytes: masked })}/${prefix}`;
}
