// Ed25519 edge cases for the parity exporters (P4-K review B, RB-1). Shared by `export-approvals.ts` (decision signatures)
// and `export-openai-auth.ts` (EdDSA id tokens): both sides must give Node's verdict for every case, and the Rust side
// must never accept what Node (OpenSSL) refuses.
//
// The cases are built here, never copied: keys and nonces come from fixed seeds, and the adversarial ones need a little
// curve arithmetic (decoding a point, adding a point of small order), done with BigInt. That arithmetic only builds test
// input; nothing here verifies a signature, the product verifier under test does.
//
// What the groups probe (A is the public key, R and S the two halves of the signature, h = SHA-512(R || A || M) mod L):
//   - `small-a`: every encoding of the eight points of small order as the key, canonical and not (sign bit on x = 0,
//     y >= p). With such a key [h]A is the neutral point whenever the order of A divides h, so a signature nobody needed
//     a private key for satisfies the verification equation.
//   - `small-r`: the same encodings as R under an honest key.
//   - `mixed-a`, `mixed-r`: an honest point plus a point of small order.
//   - `s-range`: S = 0, S >= L.
//   - `noncanonical`: y in [p, 2^255) for points that are not of small order.
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (n: bigint, m: bigint = P): bigint => ((n % m) + m) % m;
const pow = (base: bigint, exp: bigint): bigint => {
  let r = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; }
  return r;
};
const inv = (n: bigint): bigint => pow(n, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint];
const add = ([x1, y1]: Point, [x2, y2]: Point): Point => {
  const t = mod(D * mod(x1 * x2) * mod(y1 * y2));
  return [mod((x1 * y2 + x2 * y1) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(mod(1n - t)))];
};
const neg = ([x, y]: Point): Point => [mod(-x), y];
const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
const le = (b: Uint8Array): bigint => BigInt(`0x${Buffer.from(b).reverse().toString("hex")}`);
const toLe = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const encode = ([x, y]: Point): Buffer => { const b = toLe(y); b[31] = b[31]! | (Number(x & 1n) << 7); return b; };
/** The lenient decoding of the reference implementation: y is reduced, a sign bit on x = 0 is ignored. */
const decode = (b: Uint8Array): Point | null => {
  const y = mod(le(b) & ((1n << 255n) - 1n));
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = pow(u * inv(v), (P + 3n) / 8n);
  if (mod(v * x * x - u) !== 0n) { x = mod(x * SQRT_M1); if (mod(v * x * x - u) !== 0n) return null; }
  if (Number(x & 1n) !== b[31]! >> 7) x = mod(-x);
  return [x, y];
};

const hex = (s: string): Buffer => Buffer.from(s, "hex");
const T8 = decode(hex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"))!;
/** The eight points of small order: `TORSION[k]` is k times a point of order 8. */
const TORSION: Point[] = [[0n, 1n]];
for (let k = 1; k < 8; k++) TORSION.push(add(TORSION[k - 1]!, T8));
const times = (t: Point, h: bigint): Point => { let r: Point = TORSION[0]!; for (let i = 0n; i < h % 8n; i++) r = add(r, t); return r; };
const ORDER = [1, 8, 4, 8, 2, 8, 4, 8];

/** Every encoding of a point of small order: the eight canonical ones and the six that are not canonical. */
export const SMALL_ORDER_ENCODINGS: { name: string; bytes: Buffer }[] = [
  ...TORSION.map((t, k) => ({ name: `order ${ORDER[k]} (${k} x T8)`, bytes: encode(t) })),
  { name: "neutral, sign bit set", bytes: hex(`01${"00".repeat(30)}80`) },
  { name: "neutral, y = p + 1", bytes: hex(`ee${"ff".repeat(30)}7f`) },
  { name: "neutral, y = p + 1, sign bit set", bytes: hex(`ee${"ff".repeat(31)}`) },
  { name: "order 2, sign bit set", bytes: hex(`ec${"ff".repeat(31)}`) },
  { name: "order 4, y = p", bytes: hex(`ed${"ff".repeat(30)}7f`) },
  { name: "order 4, y = p, sign bit set", bytes: hex(`ed${"ff".repeat(31)}`) },
];

const PKCS8_V1 = hex("302e020100300506032b657004220420");
const sha512 = (...b: Uint8Array[]): Buffer => { const h = createHash("sha512"); for (const x of b) h.update(x); return h.digest(); };
const keyOf = (seed: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_V1, seed]), type: "pkcs8", format: "der" });
const rawPublic = (seed: Buffer): Buffer => Buffer.from((createPublicKey(keyOf(seed)).export({ type: "spki", format: "der" }) as Buffer).subarray(12));
/** The secret scalar of a seed (RFC 8032 §5.1.5), not reduced. */
const scalarOf = (seed: Buffer): bigint => { const a = Buffer.from(sha512(seed).subarray(0, 32)); a[0] = a[0]! & 248; a[31] = (a[31]! & 127) | 64; return le(a); };
const challenge = (r: Uint8Array, a: Uint8Array, m: Uint8Array): bigint => le(sha512(r, a, m)) % L;

export interface Ed25519Case {
  name: string;
  group: string;
  /** Whether the cofactorless equation [S]B = R + [h]A holds for the points the lenient decoding gives (built to). */
  equation: boolean;
  message: Buffer;
  key: Buffer;
  signature: Buffer;
}

/**
 * The cases under one label (the seed of every key and nonce). `message(n)` is the n-th candidate message of the caller's
 * shape (a MAC, the signing input of a token); a case that needs h in a residue class tries candidates until one fits.
 */
export function ed25519Cases(label: string, message: (n: number) => Buffer): Ed25519Case[] {
  const seedOf = (what: string): Buffer => createHash("sha256").update(`${label}: ${what}`).digest();
  const out: Ed25519Case[] = [];
  let n = 0;
  const fresh = (): Buffer => message(n++);
  const grind = <T>(pick: (m: Buffer) => T | null): [Buffer, T] => { for (;;) { const m = fresh(); const v = pick(m); if (v !== null) return [m, v]; } };
  const push = (group: string, name: string, equation: boolean, m: Buffer, key: Uint8Array, signature: Uint8Array): void => {
    out.push({ group, name, equation, message: m, key: Buffer.from(key), signature: Buffer.from(signature) });
  };
  const sig = (r: Uint8Array, s: bigint): Buffer => Buffer.concat([r, toLe(s)]);

  const seed = seedOf("key");
  const key = keyOf(seed);
  const a = scalarOf(seed);
  const A0 = rawPublic(seed);
  const A0p = decode(A0)!;
  const rSeed = seedOf("nonce");
  const r = scalarOf(rSeed);
  const R0 = rawPublic(rSeed);
  const R0p = decode(R0)!;

  // Honest signatures and the plain ways to spoil one.
  const m0 = fresh();
  const s0 = sign(null, m0, key);
  push("honest", "valid", true, m0, A0, s0);
  { const m = fresh(); push("honest", "valid, second message", true, m, A0, sign(null, m, key)); }
  { const [m, h] = grind((x) => challenge(R0, A0, x)); push("honest", "valid, built from the scalars", true, m, A0, sig(R0, mod(r + h * a, L))); }
  push("honest", "another message", false, fresh(), A0, s0);
  push("honest", "another key", false, m0, rawPublic(seedOf("other key")), s0);
  for (const bit of [0, 7, 255, 256, 300, 511]) { const s = Buffer.from(s0); s[bit >> 3] = s[bit >> 3]! ^ (1 << (bit & 7)); push("honest", `signature bit ${bit} flipped`, false, m0, A0, s); }
  for (const bit of [0, 100, 255]) { const k = Buffer.from(A0); k[bit >> 3] = k[bit >> 3]! ^ (1 << (bit & 7)); push("honest", `key bit ${bit} flipped`, false, m0, k, s0); }
  push("honest", "signature of 63 bytes", false, m0, A0, s0.subarray(0, 63));
  push("honest", "signature of 65 bytes", false, m0, A0, Buffer.concat([s0, Buffer.alloc(1)]));
  push("honest", "signature empty", false, m0, A0, Buffer.alloc(0));
  push("honest", "signature twice", false, m0, A0, Buffer.concat([s0, s0]));

  // A key of small order.
  for (const e of SMALL_ORDER_ENCODINGS) {
    const t = decode(e.bytes)!;
    // [h]A is neutral, so R = [S]B for any S: no private key is involved.
    { const [m] = grind((x) => (challenge(R0, e.bytes, x) % 8n === 0n ? true : null)); push("small-a", `key ${e.name}: h a multiple of 8`, true, m, e.bytes, sig(R0, r % L)); }
    for (let i = 0; i < 2; i++) { const m = fresh(); push("small-a", `key ${e.name}: any h (${i})`, same(times(t, challenge(R0, e.bytes, m)), TORSION[0]!), m, e.bytes, sig(R0, r % L)); }
    // S = 0: the equation asks for R = -[h]A, itself a point of small order.
    const small = (x: Buffer): Buffer | null => {
      for (let c = 7; c >= 0; c--) {
        if (c === 0 && !same(t, TORSION[0]!)) continue;
        const rc = encode(TORSION[c]!);
        if (same(neg(times(t, challenge(rc, e.bytes, x))), TORSION[c]!)) return rc;
      }
      return null;
    };
    { const [m, rc] = grind(small); push("small-a", `key ${e.name}: R of small order, S = 0`, true, m, e.bytes, sig(rc, 0n)); push("s-range", `key ${e.name}: R of small order, S = L`, false, m, e.bytes, sig(rc, L)); }
  }

  // R of small order under an honest key: S = h * a makes [S]B - [h]A neutral, so only the canonical neutral point fits.
  for (const e of SMALL_ORDER_ENCODINGS) {
    const m = fresh();
    push("small-r", `R ${e.name}, S = h * a`, e.bytes.equals(encode(TORSION[0]!)), m, A0, sig(e.bytes, mod(challenge(e.bytes, A0, m) * a, L)));
  }
  { const m = fresh(); push("small-r", "R neutral, S = 0", false, m, A0, sig(encode(TORSION[0]!), 0n)); }

  // An honest key plus a point of small order.
  for (let k = 1; k < 8; k++) {
    const tk = TORSION[k]!;
    const ak = encode(add(A0p, tk));
    { const [m, h] = grind((x) => { const c = challenge(R0, ak, x); return c % 8n === 0n ? c : null; }); push("mixed-a", `key + ${k} x T8: h a multiple of 8`, true, m, ak, sig(R0, mod(r + h * a, L))); }
    { const [m, h] = grind((x) => { const c = challenge(R0, ak, x); return c % 2n === 1n ? c : null; }); push("mixed-a", `key + ${k} x T8: h odd`, false, m, ak, sig(R0, mod(r + h * a, L))); }
    {
      const [m, [rc, h]] = grind((x): [Buffer, bigint] | null => {
        for (let c = 7; c >= 1; c--) { const rc = encode(TORSION[c]!); const h = challenge(rc, ak, x); if (same(neg(times(tk, h)), TORSION[c]!)) return [rc, h]; }
        return null;
      });
      push("mixed-a", `key + ${k} x T8: R of small order`, true, m, ak, sig(rc, mod(h * a, L)));
    }
    {
      const [m, [rc, h]] = grind((x): [Buffer, bigint] | null => {
        for (let c = 7; c >= 1; c--) { const rc = encode(add(R0p, TORSION[c]!)); const h = challenge(rc, ak, x); if (same(neg(times(tk, h)), TORSION[c]!)) return [rc, h]; }
        return null;
      });
      push("mixed-a", `key + ${k} x T8: R of mixed order`, true, m, ak, sig(rc, mod(r + h * a, L)));
    }
  }
  // An honest key, R plus a point of small order: holds only after multiplying by the cofactor.
  for (let k = 1; k < 8; k++) {
    const m = fresh();
    const rk = encode(add(R0p, TORSION[k]!));
    push("mixed-r", `R + ${k} x T8`, false, m, A0, sig(rk, mod(r + challenge(rk, A0, m) * a, L)));
  }

  // S out of range, and S = 0.
  {
    const R = s0.subarray(0, 32);
    const S = le(s0.subarray(32));
    for (const k of [1n, 2n, 8n, 14n, 15n]) if (S + k * L < 1n << 256n) push("s-range", `honest signature, S + ${k} x L`, false, m0, A0, sig(R, S + k * L));
    push("s-range", "honest signature, S = 0", false, m0, A0, sig(R, 0n));
    push("s-range", "honest signature, S = L - 1", false, m0, A0, sig(R, L - 1n));
    push("s-range", "honest signature, S all ones", false, m0, A0, Buffer.concat([R, Buffer.alloc(32, 0xff)]));
    const m = fresh();
    const id = encode(TORSION[0]!);
    const h = challenge(id, A0, m);
    push("s-range", "R neutral, S = h * a + L", false, m, A0, sig(id, mod(h * a, L) + L));
    push("s-range", "R neutral, S = L under the honest key", false, m, A0, sig(id, L));
  }

  // y in [p, 2^255) for the residues that are no point of small order: nobody holds a private key for these.
  for (let k = 2n; k <= 18n; k++) {
    for (const signBit of [0, 1]) {
      const b = toLe(P + k);
      b[31] = b[31]! | (signBit << 7);
      const m = fresh();
      push("noncanonical", `key y = p + ${k}${signBit ? ", sign bit set" : ""}${decode(b) ? "" : " (no point)"}`, false, m, b, sig(R0, r % L));
      if (signBit === 0) push("noncanonical", `R y = p + ${k}${decode(b) ? "" : " (no point)"}`, false, m, A0, sig(b, mod(r + challenge(b, A0, m) * a, L)));
    }
  }
  // A canonical y that is no point at all.
  for (let y = 2n; ; y++) { if (decode(toLe(y)) === null) { push("noncanonical", `key y = ${y} (no point)`, false, fresh(), toLe(y), sig(R0, r % L)); break; } }
  return out;
}
