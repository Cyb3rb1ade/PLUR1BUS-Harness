// The importer's argv → envelope (docs/import.md §8.1). The Rust CLI spawns `import.js` with already-parsed flags and
// prints the envelope's `value` as the `--json` document (schema inserted there) or its `human` text.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { detect } from "./detect.ts";
import { importOpenclaw } from "./importers/openclaw.ts";
import type { ConflictStrategy } from "./ledger.ts";
import { parseMaps, type Mount } from "./paths.ts";
import { renderDetect, renderOpenclaw, renderRollback, renderSkills } from "./render.ts";
import { rollbackImport } from "./rollback.ts";
import { importSkills, rollback as rollbackSkills, type OnConflict } from "./skills-import.ts";
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
        "on-conflict": { type: "string" }, conflict: { type: "string" }, "max-skill-bytes": { type: "string" }, map: { type: "string", multiple: true },
        "probe-wsl": { type: "boolean" }, "allow-live-copy": { type: "boolean" }, "migrate-secrets": { type: "boolean" }, resume: { type: "string" },
        force: { type: "boolean" },
      },
    }) as { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] });
  } catch (e) {
    return fail("E_INVALID_PARAMS", "bad-arguments", (e as Error).message);
  }
  const sourceType = positionals[0];
  if (positionals.length !== 1 || (sourceType !== "openclaw" && sourceType !== "hermes")) return fail("E_INVALID_PARAMS", "source-type", "expected exactly one source: openclaw or hermes");
  if (typeof values.home !== "string") return fail("E_INVALID_PARAMS", "home-missing", "--home is required");
  const explicitModes = [values.detect ? "detect" : null, values.skills ? "skills" : null, values.rollback !== undefined ? "rollback" : null].filter(Boolean);
  if (explicitModes.length > 1 || (explicitModes.length === 0 && sourceType !== "openclaw")) {
    return fail("E_INVALID_PARAMS", "mode", "choose exactly one of --detect, --skills, --rollback <report>");
  }
  const mode = explicitModes[0] ?? "import";
  if (values.apply && mode === "detect") return fail("E_INVALID_PARAMS", "apply-with-detect", "--detect is read-only; --apply applies to --skills, --rollback, and import");
  if ((values.enable || values["max-skill-bytes"] !== undefined) && mode !== "skills") {
    return fail("E_INVALID_PARAMS", "skills-only-flag", "--enable and --max-skill-bytes apply to --skills only");
  }
  if (values["migrate-secrets"] && mode !== "import") return fail("E_INVALID_PARAMS", "migrate-secrets-flag", "--migrate-secrets applies to import only");
  if (values.resume !== undefined && mode !== "import") return fail("E_INVALID_PARAMS", "resume-import-only", "--resume applies to import only");
  if (values.force && mode !== "rollback") return fail("E_INVALID_PARAMS", "force-rollback-only", "--force applies to rollback only");
  if (mode === "rollback" && (values.source !== undefined || values.profile !== undefined || values.map !== undefined)) return fail("E_INVALID_PARAMS", "rollback-takes-report-only", "--rollback reads everything from the report; drop --source, --profile and --map");
  if ((mode === "detect" || mode === "rollback") && (values["on-conflict"] !== undefined || values.conflict !== undefined)) {
    return fail("E_INVALID_PARAMS", "conflict-mode-invalid", "--on-conflict / --conflict applies to import and --skills only");
  }
  if (values["on-conflict"] !== undefined && values.conflict !== undefined && values["on-conflict"] !== values.conflict) {
    return fail("E_INVALID_PARAMS", "conflicting-conflict-flags", "cannot specify different values for both --on-conflict and --conflict");
  }
  if (values.profile !== undefined && sourceType !== "hermes") return fail("E_INVALID_PARAMS", "profile-not-supported", "--profile applies to Hermes; select an OpenClaw profile with --source <state-dir> or OPENCLAW_PROFILE");
  const onConflict = ((values["on-conflict"] ?? values.conflict) ?? "skip") as string;
  if (!["skip", "rename", "replace"].includes(onConflict)) return fail("E_INVALID_PARAMS", "on-conflict", "--on-conflict / --conflict must be skip, rename or replace");
  let maxBytes = DEFAULT_MAX_SKILL_BYTES;
  if (values["max-skill-bytes"] !== undefined) {
    const n = Number(values["max-skill-bytes"]);
    if (!Number.isSafeInteger(n) || n <= 0) return fail("E_INVALID_PARAMS", "max-skill-bytes", "--max-skill-bytes must be a positive integer");
    maxBytes = n;
  }
  let maps: Mount[] | undefined;
  try { maps = values.map ? parseMaps(values.map as string[]) : undefined; } catch (e) { return fail("E_INVALID_PARAMS", "map", (e as Error).message); }
  const base = {
    sourceType: sourceType as SourceType,
    source: values.source as string | undefined,
    profile: values.profile as string | undefined,
    home: values.home,
    env,
    ...(homedir ? { homedir } : {}),
    maps,
    maxBytes,
    probeWsl: values["probe-wsl"] === true,
    allowLiveCopy: values["allow-live-copy"] === true,
  };
  try {
    if (mode === "import") {
      const r = await importOpenclaw({
        ...base,
        apply: values.apply === true,
        migrateSecrets: values["migrate-secrets"] === true,
        onConflict: onConflict as ConflictStrategy,
        resume: values.resume as string | undefined,
      });
      return { ok: true, schema: "import.openclaw/1", value: r as unknown as Record<string, unknown>, human: renderOpenclaw(r) };
    }
    if (mode === "detect") {
      const r = await detect(base);
      return { ok: true, schema: "import.detect/1", value: r as unknown as Record<string, unknown>, human: renderDetect(r) };
    }
    if (mode === "skills") {
      const r = await importSkills({ ...base, apply: values.apply === true, enable: values.enable === true, onConflict: onConflict as OnConflict }, renderSkills);
      return { ok: true, schema: "import.skills/1", value: r as unknown as Record<string, unknown>, human: renderSkills(r) };
    }

    // Rollback mode: determine if full import report or skills report
    let isFullOpenclawReport = false;
    try {
      const text = readFileSync(values.rollback as string, "utf8");
      const parsed = JSON.parse(text);
      if (parsed.schema === "import.openclaw/1" || (parsed.sourceType === "openclaw" && Array.isArray(parsed.profilesOrAgents))) {
        isFullOpenclawReport = true;
      }
    } catch {
      // Pass through to let rollback handler report specific error
    }

    if (isFullOpenclawReport) {
      const r = await rollbackImport({
        home: values.home,
        reportPath: values.rollback as string,
        apply: values.apply === true,
        force: values.force === true,
        sourceType: sourceType as SourceType,
      });
      return { ok: true, schema: "import.rollback/1", value: r as unknown as Record<string, unknown>, human: renderRollback(r) };
    }

    const r = rollbackSkills({ home: values.home, reportPath: values.rollback as string, apply: values.apply === true, sourceType: sourceType as SourceType });
    return { ok: true, schema: "import.rollback/1", value: r as unknown as Record<string, unknown>, human: renderRollback(r) };
  } catch (e) {
    if (e instanceof ImportError) return fail(e.code, e.reason, e.message, e.exit);
    return fail("E_IMPORT_FAILED", "internal", (e as Error).message ?? String(e), 1);
  }
}
