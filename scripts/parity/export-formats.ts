// Parity vectors (mode V) for the string formats the RPC schema uses (`date`, `date-time`, `uri`, `uuid`): what ajv-formats,
// configured exactly as `packages/rpc-schema/src/index.ts` configures it, says about edge-case strings. The Rust validators
// (`crates/plur1bus-rpc`, feature `server`) must agree on every case (P4-03 review F6). Recorded, never edited by hand.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-formats.ts [--check]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";

// The validator stack of packages/rpc-schema (its own dependencies, resolved from there): Ajv 2020 in strict mode plus
// ajv-formats with its defaults, the same options as `packages/rpc-schema/src/index.ts`.
const require = createRequire(new URL("../../packages/rpc-schema/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default ?? require("ajv-formats");
const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false, allowUnionTypes: true });
addFormats(ajv);

const probes: Record<string, string[]> = {
  date: [
    "2026-11-07", "2024-02-29", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31",
    "+2026-11-07", "2026-1-07", "20261107", "２０２６-11-07", "2026-11-07T00:00:00Z", "",
  ],
  "date-time": [
    "2026-11-07T12:00:00Z", "2026-11-07 12:00:00Z", "2026-11-07t12:00:00z", "2026-11-07T12:00:00.123456+01:00",
    "2026-02-30T12:00:00Z", "2026-11-07T12:00:00", "2026-11-07T24:00:00Z", "2026-11-07T23:59:60Z",
    "2026-11-07T12:00Z", "",
  ],
  uri: [
    "https://example.org/a?b=c#d", "http://", "//host/path", "a:b", "mailto:someone@example.org", "urn:isbn:0451450523",
    "http://[::1]:8080/", "http://example.org:99999/", "http://exa mple.org/", "http://example.org/%zz", "http://example.org/%20",
    "javascript:void(0)", "file:///tmp/x", "relative/path", "/absolute/path", "http://exämple.org/", "HTTP://EXAMPLE.ORG",
    "x-custom+scheme.1:rest", "1http://example.org", "http://user:pass@example.org/", "",
  ],
  uuid: [
    "123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000",
    "urn:uuid:123e4567-e89b-12d3-a456-426614174000", "123e4567e89b12d3a456426614174000",
  ],
};

/** `ajv-formats.json`: every probe with ajv-formats' verdict. */
export async function buildFormatVectors(): Promise<Record<string, unknown>> {
  const cases = Object.entries(probes).flatMap(([format, values]) => {
    const check = ajv.compile({ type: "string", format });
    return values.map((value) => ({ format, value, valid: check(value) === true }));
  });
  return { "ajv-formats": { cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "formats", build: buildFormatVectors }));
}
