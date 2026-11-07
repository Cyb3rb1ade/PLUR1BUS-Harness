// Shared helper of the parity vector exporters (P4-02, parity mode V). See scripts/parity/README.md.
//
// An exporter runs the TypeScript implementation over a list of inputs and hands this helper the result. The helper
// writes `fixtures/parity/<area>/<name>.json` deterministically: object keys sorted at every depth, two-space indent,
// one trailing newline. Vectors are recorded by an exporter and never edited by hand; `--check` proves it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/parity/", import.meta.url));
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** Copies `value` with the keys of every object sorted by UTF-16 code unit (the order of `Array.prototype.sort`). */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, sortKeysDeep(value[k])]));
  }
  return value;
}

/** The exact bytes of a fixture file. */
export function fixtureText(data) {
  return `${JSON.stringify(sortKeysDeep(data), null, 2)}\n`;
}

export function fixturePath(area, name, root = FIXTURE_ROOT) {
  if (!SEGMENT.test(area)) throw new Error(`parity area must match ${SEGMENT}, got ${JSON.stringify(area)}`);
  if (!SEGMENT.test(name)) throw new Error(`parity fixture name must match ${SEGMENT}, got ${JSON.stringify(name)}`);
  return join(root, area, `${name}.json`);
}

/** Writes one fixture, or with `check: true` only compares. Returns `{ path, changed }` (`changed`: the file differs from
 *  what the exporter produces, or does not exist). */
export function writeFixture(area, name, data, { check = false, root = FIXTURE_ROOT } = {}) {
  const path = fixturePath(area, name, root);
  const text = fixtureText(data);
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== text;
  if (changed && !check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { path, changed };
}

/** The `main` of an exporter: writes every fixture of `build()` (`{ <name>: data }`) under `area`; with `--check`
 *  writes nothing and exits 1 when a fixture is missing or differs. */
export async function exporterMain({ area, build, argv = process.argv.slice(2), root = FIXTURE_ROOT, log = console.log }) {
  const check = argv.includes("--check");
  const stale = [];
  for (const [name, data] of Object.entries(await build())) {
    const { path, changed } = writeFixture(area, name, data, { check, root });
    if (changed) stale.push(path);
    log(`${check ? (changed ? "STALE" : "ok   ") : (changed ? "wrote" : "same ")} ${path}`);
  }
  if (check && stale.length) {
    log(`parity fixtures under fixtures/parity/${area}/ differ from the exporter's output; re-run the exporter, never edit them by hand`);
    return 1;
  }
  return 0;
}
