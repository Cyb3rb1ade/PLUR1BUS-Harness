// Parity vectors (mode V) for the small URL reader of the Rust core (`crates/plur1bus-core/src/config/endpoint.rs`): what
// `new URL` in Node reads from URLs whose host looks like an IPv4 address or nearly does. The reader has to agree on every
// case: an address the constructor refuses is not an address, and one it accepts is the same four numbers. The hosts stay in
// ASCII, since the reader does no IDNA (see the README). Recorded, never edited by hand.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-endpoint.ts [--check]
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

/** Hosts by what they probe. Every host is read in each of `SHAPES`. */
const HOSTS: Record<string, string[]> = {
  "sign in a part before the last": [
    "+1.2.3.4", "+127.0.0.1", "+127.1", "1.+2.3.4", "1.2.+3.4", "127.+0.0.1", "0x+7f.1", "0x+7f.0.0.1", "0X+7F.1", "+0x7f.1", "0+7.1", "0+.1",
    "+0.1", "+.1", "-1.2.3.4", "1.-2.3.4", "0x-1.2.3.4", "0-7.1", "-0.1", "%2b1.2.3.4", "%2B127.0.0.1", "1.%2b2.3.4", "0x%2b7f.1", "%2d1.2.3.4",
  ],
  "sign in the last part": ["1.2.3.+4", "1.2.3.-4", "1.2.3.4+", "1.2.3.+", "1.2.3.0x+4", "+", "-", "+1", "1+", "0x+1"],
  "white space": [" 1.2.3.4", "1.2.3.4 ", "1. 2.3.4", "%201.2.3.4", "1.2.3.4%20", "%091.2.3.4", "1.\t2.3.4", "1.2.3.4\n", "\r1.2.3.4"],
  "empty and malformed parts": [
    "0x", "0x.1", "0x.0x.0x.0x", "0x.", "1..2", "1.2..4", ".1.2.3", "1.2.3.4.", "1.2.3.4..", "..", ".", "1.", ".1", "1.2.3.", "1.2.3.4.5", "1.0x",
    "foo.0x", "a.0x10", "0xg", "0xg.1", "1e3", "1.2.3.4e0", "08", "09.1.1.1", "1.2.3.08", "1.08.3.4", "0x100000000", "4294967296", "256.1.1.1",
    "1.2.3.256", "1.16777216", "1.2.65536", "99999999999999999999.1", "0x10000000000000000.1", "1a.2.3.4", "0x7g.1", "078.1", "1_0.2.3.4",
  ],
  "addresses": [
    "1.2.3.4", "127.0.0.1", "127.1", "127.0.1", "0x7f.1", "0x7F.1", "0X7F.0.0.1", "0177.0.0.1", "017700000001", "2130706433", "01.02.03.04",
    "4294967295", "0xffffffff", "0xFFFFFFFF", "1.16777215", "1.2.65535", "00000000000000000001.2.3.4", "0x00000000000000000000007f.1", "0",
    "00", "0.0.0.0", "255.255.255.255", "0x0.0x0", "%31.2.3.4", "0xa.0XB.014.13",
  ],
  "names": ["example.com", "EXAMPLE.com", "localhost", "a.b.c.d.e", "1.2.3.4.example", "0x7f.example", "[::1]", "[::ffff:1.2.3.4]"],
};
const SHAPES: Array<[string, string]> = [["https://", "/"], ["http://", ":8080/v1"], ["https://user@", "/"]];

/** What `new URL` reads: the five members the reader has, or the refusal. */
function read(url: string): Record<string, unknown> {
  try {
    const u = new URL(url);
    return { ok: true, protocol: u.protocol, username: u.username, password: u.password, hostname: u.hostname, port: u.port };
  } catch {
    return { ok: false };
  }
}

/** `url.json`: every probe with Node's reading. */
export async function buildEndpointVectors(): Promise<Record<string, unknown>> {
  const cases: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const [group, hosts] of Object.entries(HOSTS)) {
    for (const host of hosts) {
      for (const [before, after] of SHAPES) {
        const url = before + host + after;
        if (seen.has(url)) throw new Error(`duplicate probe ${JSON.stringify(url)}`);
        seen.add(url);
        cases.push({ name: `${group} | ${JSON.stringify(url).slice(1, -1)}`, url, ...read(url) });
      }
    }
  }
  return { url: { cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "endpoint", build: buildEndpointVectors }));
}
