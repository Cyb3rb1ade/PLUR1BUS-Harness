// The importer's argv → envelope (docs/import.md §8.1). The Rust CLI spawns `import.js` with already-parsed flags and
// prints the envelope's `value` as the `--json` document (schema inserted there) or its `human` text.
import { parseArgs } from "node:util";
import { detect } from "./detect.ts";
import { parseMaps, type Mount } from "./paths.ts";
import { renderDetect, renderRollback, renderSkills } from "./render.ts";
import { importSkills, rollback, type OnConflict } from "./skills-import.ts";
import { DEFAULT_MAX_SKILL_BYTES } from "./skills-scan.ts";
import { ImportError, type SourceType } from "./types.ts";

export type Envelope =
  | { ok: true; schema: string; value: Record<string, unknown>; human: string }
  | { ok: false; error: string; message: string; reason: string; exit: number };

const fail = (error: string, reason: string, message: string, exit = 2): Envelope => ({ ok: false, error, message, reason, exit });

export async function runImport(argv: string[], env: NodeJS.ProcessEnv = process.env, homedir?: string): Promise<Envelope> {
  let values: Record<string, string | boolean | string[] | undefined>; let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        home: { type: "string" }, detect: { type: "boolean" }, skills: { type: "boolean" }, rollback: { type: "string" },
        source: { type: "string" }, profile: { type: "string" }, apply: { type: "boolean" }, enable: { type: "boolean" },
        "on-conflict": { type: "string" }, "max-skill-bytes": { type: "string" }, map: { type: "string", multiple: true },
      },
    }) as { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] });
  } catch (e) {
    return fail("E_INVALID_PARAMS", "bad-arguments", (e as Error).message);
  }
  const sourceType = positionals[0];
  if (positionals.length !== 1 || (sourceType !== "openclaw" && sourceType !== "hermes")) return fail("E_INVALID_PARAMS", "source-type", "expected exactly one source: openclaw or hermes");
  if (typeof values.home !== "string") return fail("E_INVALID_PARAMS", "home-missing", "--home is required");
  const modes = [values.detect ? "detect" : null, values.skills ? "skills" : null, values.rollback !== undefined ? "rollback" : null].filter(Boolean);
  if (modes.length !== 1) return fail("E_INVALID_PARAMS", "mode", "choose exactly one of --detect, --skills, --rollback <report>");
  const mode = modes[0];
  if (values.apply && mode === "detect") return fail("E_INVALID_PARAMS", "apply-with-detect", "--detect is read-only; --apply applies to --skills and --rollback");
  if ((values.enable || values["on-conflict"] !== undefined || values["max-skill-bytes"] !== undefined) && mode !== "skills") return fail("E_INVALID_PARAMS", "skills-only-flag", "--enable, --on-conflict and --max-skill-bytes apply to --skills only");
  if (mode === "rollback" && (values.source !== undefined || values.profile !== undefined || values.map !== undefined)) return fail("E_INVALID_PARAMS", "rollback-takes-report-only", "--rollback reads everything from the report; drop --source, --profile and --map");
  if (values.profile !== undefined && sourceType !== "hermes") return fail("E_INVALID_PARAMS", "profile-not-supported", "--profile applies to Hermes; select an OpenClaw profile with --source <state-dir> or OPENCLAW_PROFILE");
  const onConflict = (values["on-conflict"] ?? "skip") as string;
  if (!["skip", "rename", "replace"].includes(onConflict)) return fail("E_INVALID_PARAMS", "on-conflict", "--on-conflict must be skip, rename or replace");
  let maxBytes = DEFAULT_MAX_SKILL_BYTES;
  if (values["max-skill-bytes"] !== undefined) {
    const n = Number(values["max-skill-bytes"]);
    if (!Number.isSafeInteger(n) || n <= 0) return fail("E_INVALID_PARAMS", "max-skill-bytes", "--max-skill-bytes must be a positive integer");
    maxBytes = n;
  }
  let maps: Mount[] | undefined;
  try { maps = values.map ? parseMaps(values.map as string[]) : undefined; } catch (e) { return fail("E_INVALID_PARAMS", "map", (e as Error).message); }
  const base = { sourceType: sourceType as SourceType, source: values.source as string | undefined, profile: values.profile as string | undefined, home: values.home, env, ...(homedir ? { homedir } : {}), maps, maxBytes };
  try {
    if (mode === "detect") {
      const r = await detect(base);
      return { ok: true, schema: "import.detect/1", value: r as unknown as Record<string, unknown>, human: renderDetect(r) };
    }
    if (mode === "skills") {
      const r = await importSkills({ ...base, apply: values.apply === true, enable: values.enable === true, onConflict: onConflict as OnConflict }, renderSkills);
      return { ok: true, schema: "import.skills/1", value: r as unknown as Record<string, unknown>, human: renderSkills(r) };
    }
    const r = rollback({ home: values.home, reportPath: values.rollback as string, apply: values.apply === true, sourceType: sourceType as SourceType });
    return { ok: true, schema: "import.rollback/1", value: r as unknown as Record<string, unknown>, human: renderRollback(r) };
  } catch (e) {
    if (e instanceof ImportError) return fail(e.code, e.reason, e.message, e.exit);
    return fail("E_IMPORT_FAILED", "internal", (e as Error).message ?? String(e), 1);
  }
}
