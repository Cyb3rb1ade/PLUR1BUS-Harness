// Offline A2 repair entry point. --home and --agent are always explicit; shares the import/core OS lock.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { layout } from "../packages/core/src/paths.ts";
import { withTargetLock } from "../packages/core/src/import/single-writer.ts";
import { migrateLegacyKnowledge, rollbackKnowledgeMigration } from "../packages/core/src/knowledge/migration.ts";
try {
  const { values } = parseArgs({ options: { home: { type: "string" }, agent: { type: "string" }, rollback: { type: "boolean", default: false } } });
  if (!values.home || !values.agent) throw new Error("home-and-agent-required");
  const l = layout(resolve(values.home));
  const report = await withTargetLock(l, () => values.rollback
    ? rollbackKnowledgeMigration(l.workspaceDir(values.agent), l.home)
    : migrateLegacyKnowledge(l.workspaceDir(values.agent), l.home));
  console.log(JSON.stringify({ schema: "knowledge-migration/1", agentId: values.agent, report }));
} catch (error) {
  const reason = error?.reason ?? error?.message;
  console.error(typeof reason === "string" && /^[a-z0-9-]+$/.test(reason) ? reason : "knowledge-migration-failed");
  process.exitCode = 1;
}
