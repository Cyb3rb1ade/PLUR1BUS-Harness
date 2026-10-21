// The shared IP classification vectors (spec 2026-10-21-desktop-transport-choice §4.6). The Rust crate
// `plur1bus-desktop-net` reads the same file and must agree on every row; this suite is the TypeScript side.
// The file is hand-committed: a row changes only together with a reviewed change of the classifier.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IANA_SPECIAL_REGISTRY,
  canonical,
  cidrContainsPublic,
  classificationTable,
  classifyAddress,
  parseAddress,
  parseCidr,
  type Cidr,
  type ParsedAddress,
} from "../../../src/tools/web/ip.ts";

interface RegistryRef {
  url: string;
  updated: string;
}
interface Vectors {
  classifier: string;
  registries: { ipv4: RegistryRef; ipv6: RegistryRef };
  table: Array<{ cidr: string; reason: string }>;
  addresses: Array<{ input: string; canonical: string; public: boolean; reason?: string }>;
  parseRejects: Array<{ input: string; strict: boolean }>;
  strictRejects: string[];
  cidrs: Array<{ input: string; firstPublic: string | null }>;
  categories: Array<{ input: string; category: string }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../fixtures/net/ip-classification-vectors.json", import.meta.url), "utf8")) as Vectors;

const REASONS = new Set(["unspecified", "private", "shared-address-space", "loopback", "link-local", "cloud-metadata", "reserved", "multicast"]);
const CATEGORIES = new Set(["loopback", "tailnet", "private", "special", "public", "not-connectable"]);

const parse = (s: string, strict = false): ParsedAddress => {
  const a = parseAddress(s, { strict });
  assert.ok(a, `parseable: ${s}`);
  return a;
};
const hex = (a: ParsedAddress): string => `${a.family}:${Buffer.from(a.bytes).toString("hex")}`;
const toBig = (bytes: Uint8Array): bigint => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
const fromBig = (family: 4 | 6, n: bigint): ParsedAddress => {
  const len = family === 4 ? 4 : 16;
  const bytes = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n >>= 8n) bytes[i] = Number(n & 0xffn);
  return { family, bytes };
};
const maxBits = (family: 4 | 6): bigint => (family === 4 ? 32n : 128n);
const rangeOf = (c: Cidr): { lo: bigint; hi: bigint } => {
  const host = maxBits(c.family) - BigInt(c.prefix);
  const lo = (toBig(c.bytes) >> host) << host;
  return { lo, hi: lo | ((1n << host) - 1n) };
};
const isPublic = (a: ParsedAddress): boolean => classifyAddress(a).public;

/** The result is public, lies in the range and is the lowest such address (the one just below it is not public). */
function assertFirstPublic(c: Cidr, got: ParsedAddress, label: string): void {
  assert.equal(isPublic(got), true, `${label}: result is public`);
  const { lo, hi } = rangeOf(c);
  const n = toBig(got.bytes);
  assert.ok(n >= lo && n <= hi, `${label}: result inside the range`);
  if (n > lo) assert.equal(isPublic(fromBig(c.family, n - 1n)), false, `${label}: nothing public just below the result`);
}

describe("vectors: header", () => {
  it("vectors: classifier id equals IANA_SPECIAL_REGISTRY.id", () => {
    assert.equal(vectors.classifier, IANA_SPECIAL_REGISTRY.id);
    assert.equal(IANA_SPECIAL_REGISTRY.id, "iana-special-2025-10-09");
  });
  it("vectors: registries equal IANA_SPECIAL_REGISTRY", () => {
    assert.deepEqual(vectors.registries.ipv4, IANA_SPECIAL_REGISTRY.ipv4);
    assert.deepEqual(vectors.registries.ipv6, IANA_SPECIAL_REGISTRY.ipv6);
  });
  it("vectors: classificationTable() equals table row by row", () => {
    const code = classificationTable();
    assert.equal(code.length, vectors.table.length);
    code.forEach((row, i) => {
      assert.equal(row.cidr, vectors.table[i]!.cidr, `row ${i} cidr`);
      assert.equal(row.reason, vectors.table[i]!.reason, `row ${i} reason`);
    });
  });
  it("vectors: every table row parses and uses a known reason", () => {
    for (const row of classificationTable()) {
      assert.ok(parseCidr(row.cidr), row.cidr);
      assert.ok(REASONS.has(row.reason), row.reason);
    }
  });
});

describe("vectors: addresses", () => {
  it("vectors: every address row (public, reason, canonical bytes)", () => {
    assert.ok(vectors.addresses.length >= 200, "the file is not hollowed out");
    for (const row of vectors.addresses) {
      const a = parse(row.input);
      const v = classifyAddress(a);
      assert.equal(v.public, row.public, `${row.input}: public`);
      assert.equal(v.reason, row.public ? undefined : row.reason, `${row.input}: reason`);
      if (!row.public) assert.ok(REASONS.has(row.reason ?? ""), `${row.input}: known reason`);
      // `canonical` is compared as bytes (and family), never as text: "::ffff:7f00:1" and "127.0.0.1" are one address.
      assert.equal(hex(canonical(a)), hex(parse(row.canonical)), `${row.input}: canonical bytes`);
    }
  });
  it("vectors: no address row appears twice", () => {
    const seen = new Set<string>();
    for (const row of vectors.addresses) {
      assert.equal(seen.has(row.input), false, `duplicate input ${row.input}`);
      seen.add(row.input);
    }
  });
});

describe("vectors: rejects", () => {
  it("vectors: parse rejects", () => {
    assert.ok(vectors.parseRejects.length >= 30);
    for (const row of vectors.parseRejects) assert.equal(parseAddress(row.input, { strict: row.strict }), null, JSON.stringify(row.input));
  });
  it("vectors: strict rejects (legacy spellings that only the lenient parser takes)", () => {
    assert.ok(vectors.strictRejects.length >= 10);
    for (const input of vectors.strictRejects) {
      assert.equal(parseAddress(input, { strict: true }), null, `${input}: strict`);
      assert.ok(parseAddress(input), `${input}: still a legacy spelling in lenient mode`);
    }
  });
});

describe("vectors: cidrs", () => {
  it("vectors: cidrContainsPublic for every cidr row", () => {
    assert.ok(vectors.cidrs.length >= 40);
    for (const row of vectors.cidrs) {
      const c = parseCidr(row.input);
      assert.ok(c, `parseable cidr: ${row.input}`);
      const got = cidrContainsPublic(c);
      if (row.firstPublic === null) {
        assert.equal(got, null, `${row.input}: no public address`);
      } else {
        assert.ok(got, `${row.input}: has a public address`);
        assert.equal(hex(got), hex(parse(row.firstPublic)), `${row.input}: lowest public address`);
        assertFirstPublic(c, got, row.input);
      }
    }
  });

  it("cidrContainsPublic never returns a non-public address: every IPv4 /8", () => {
    const rows = classificationTable().filter((r) => !r.cidr.includes(":"));
    const v4Blocks = [...rows.map((r) => rangeOf(parseCidr(r.cidr)!)), { lo: 0xffffffffn, hi: 0xffffffffn }];
    for (let o = 0; o < 256; o++) {
      const c: Cidr = { family: 4, bytes: Uint8Array.of(o, 0, 0, 0), prefix: 8 };
      const got = cidrContainsPublic(c);
      // Independent oracle: the lowest public address is the range start or the address right after a non-public block.
      const { lo, hi } = rangeOf(c);
      const candidates = [lo, ...v4Blocks.map((b) => b.hi + 1n).filter((n) => n > lo && n <= hi)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const expected = candidates.find((n) => isPublic(fromBig(4, n)));
      if (expected === undefined) {
        assert.equal(got, null, `${o}.0.0.0/8`);
      } else {
        assert.ok(got, `${o}.0.0.0/8`);
        assert.equal(toBig(got.bytes), expected, `${o}.0.0.0/8: lowest public`);
        assert.equal(got.family, 4);
        assertFirstPublic(c, got, `${o}.0.0.0/8`);
      }
    }
  });

  it("cidrContainsPublic never returns a non-public address: 4096 random IPv6 /32 and every IPv6 /16", () => {
    let state = 0x9e3779b9;
    const next = (): number => {
      // mulberry32, deterministic
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const check = (c: Cidr): void => {
      const got = cidrContainsPublic(c);
      if (got === null) return;
      assert.equal(got.family, 6);
      assertFirstPublic(c, got, `${Buffer.from(c.bytes).toString("hex")}/${c.prefix}`);
    };
    let hits = 0;
    for (let i = 0; i < 4096; i++) {
      const bytes = new Uint8Array(16);
      // Half of the samples are forced into 2000::/3, where the answers are not trivially "none".
      for (let k = 0; k < 4; k++) bytes[k] = Math.floor(next() * 256);
      if (i % 2 === 0) bytes[0] = (bytes[0]! & 0x1f) | 0x20;
      const c: Cidr = { family: 6, bytes, prefix: 32 };
      if (cidrContainsPublic(c)) hits++;
      check(c);
    }
    assert.ok(hits > 1500, `the sweep reaches public space (${hits})`);
    for (let n = 0; n < 65536; n++) check({ family: 6, bytes: Uint8Array.of(n >> 8, n & 0xff, ...new Array<number>(14).fill(0)), prefix: 16 });
  });

  it("vectors: a range inside one non-public row has no public address, for every table row", () => {
    for (const row of classificationTable()) {
      const c = parseCidr(row.cidr)!;
      const got = cidrContainsPublic(c);
      // ::/96 is the one row that contains no IPv4-mapped block; 64:ff9b:1::/48 and the others are plain blocks too.
      assert.equal(got, null, row.cidr);
    }
  });
});

describe("vectors: categories (read by the Rust crate; shape and spec 4.3 here)", () => {
  const TAILNET_V4 = parseCidr("100.64.0.0/10")!;
  const TAILNET_V6 = parseCidr("fd7a:115c:a1e0::/48")!;
  const inside = (a: ParsedAddress, c: Cidr): boolean => {
    if (a.family !== c.family) return false;
    const { lo, hi } = rangeOf(c);
    const n = toBig(a.bytes);
    return n >= lo && n <= hi;
  };
  // Spec 4.3, in order. Not used by any product code: this keeps the hand-written rows honest.
  const category = (input: string): string => {
    const a = canonical(parse(input));
    const v = classifyAddress(a);
    if (v.reason === "unspecified" || v.reason === "multicast" || hex(a) === hex(parse("255.255.255.255"))) return "not-connectable";
    if (inside(a, TAILNET_V4) || inside(a, TAILNET_V6)) return "tailnet";
    if (v.reason === "loopback") return "loopback";
    if (v.reason === "private" || v.reason === "link-local") return "private";
    if (v.reason === "reserved" || v.reason === "cloud-metadata") return "special";
    assert.equal(v.public, true);
    return "public";
  };

  it("vectors: category rows have a parseable input and a known category", () => {
    assert.ok(vectors.categories.length >= 30);
    const seen = new Set<string>();
    for (const row of vectors.categories) {
      assert.deepEqual(Object.keys(row).sort(), ["category", "input"]);
      assert.ok(parseAddress(row.input), `parseable: ${row.input}`);
      assert.ok(CATEGORIES.has(row.category), `${row.input}: ${row.category}`);
      assert.equal(seen.has(row.input), false, `duplicate ${row.input}`);
      seen.add(row.input);
    }
    for (const c of CATEGORIES) assert.ok(vectors.categories.some((r) => r.category === c), `every category is exercised: ${c}`);
  });
  it("vectors: category rows agree with spec 4.3 applied to classifyAddress", () => {
    for (const row of vectors.categories) assert.equal(category(row.input), row.category, row.input);
  });
});

describe("vectors: required rows are present", () => {
  const have = new Set(vectors.addresses.map((r) => r.input));
  const must = [
    // outside neighbours
    "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "192.167.255.255", "192.169.0.0",
    // Globally Reachable = True and public
    "192.31.196.1", "192.52.193.1", "192.175.48.1", "2620:4f:8000::1",
    // True inside a False block, kept non-public on purpose
    "192.0.0.9", "192.0.0.10", "2001:1::1", "2001:3::1", "2001:20::1",
    "5f00::1", "100:0:0:1::1", "3fff::1", "64:ff9b:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "64:ff9b::808:808", "2002:808:808::1", "2002:a00:1::1",
    "100.100.100.100", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "fd7a:115c:a1e1::1",
  ];
  it("vectors: the rows the brief names are all in the file", () => {
    for (const m of must) assert.ok(have.has(m), m);
  });
  it("vectors: first and last address of every table row, and both neighbours, are in the file", () => {
    for (const row of classificationTable()) {
      const c = parseCidr(row.cidr)!;
      const { lo, hi } = rangeOf(c);
      const max = (1n << maxBits(c.family)) - 1n;
      const wanted = [lo, hi, ...(lo > 0n ? [lo - 1n] : []), ...(hi < max ? [hi + 1n] : [])].map((n) => fromBig(c.family, n));
      const known = new Set(vectors.addresses.map((r) => hex(canonical(parse(r.input)))));
      const knownRaw = new Set(vectors.addresses.map((r) => hex(parse(r.input))));
      for (const w of wanted) {
        // IPv4 is judged by its dotted form; an IPv6 row matches by its own bytes.
        assert.ok(known.has(hex(w)) || knownRaw.has(hex(w)), `${row.cidr}: ${hex(w)} missing`);
      }
    }
  });
});
