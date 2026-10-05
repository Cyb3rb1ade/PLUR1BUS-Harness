// OpenClaw agent scaffolding and curated file migration (docs/import.md §2.2, D14, D15).
// Places persona (SOUL.md) and D15 files in `l.workspaceDir(id)` (packages/core/src/paths.ts:35).
// Idempotent: existing identical files are classified as `matched-existing` with zero writes.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scaffoldFiles } from "../../agents.ts";
import type { Layout } from "../../paths.ts";
import { isDir, isFile } from "../readonly.ts";
import type { AgentInfo } from "../types.ts";

export interface MigratedFileReport {
  sourceFile: string;
  targetFile: string;
  targetPath: string;
  action: "created" | "matched-existing" | "skipped";
  bytes: number;
}

export interface AgentImportReport {
  sourceId: string;
  harnessAgentId: string;
  action: "created" | "matched-existing";
  workspaceDir: string;
  files: MigratedFileReport[];
  counts: {
    filesCreated: number;
    filesMatched: number;
    filesSkipped: number;
  };
}

interface CuratedCandidate {
  targetFileName: string;
  sourceCandidates: string[];
}

function findFirstFile(candidates: string[]): string | null {
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

export function planAndMigrateAgent(
  agent: AgentInfo,
  sourceRoot: string,
  l: Layout,
  existingAgentIds: Set<string>,
  apply: boolean,
): { report: AgentImportReport; isNewAgent: boolean } {
  const agentId = agent.agentId;
  const isNewAgent = !existingAgentIds.has(agentId);
  const agentAction = isNewAgent ? "created" : "matched-existing";
  const wsTarget = l.workspaceDir(agentId);
  const srcWs = agent.workspace;

  const fileReports: MigratedFileReport[] = [];

  if (srcWs && isDir(srcWs)) {
    const candidates: CuratedCandidate[] = [
      {
        targetFileName: "SOUL.md",
        sourceCandidates: [
          join(srcWs, "SOUL.md"),
          join(srcWs, "soul.md"),
          ...(agent.agentDir ? [join(agent.agentDir, "SOUL.md")] : []),
        ],
      },
      {
        targetFileName: "memories.md",
        sourceCandidates: [join(srcWs, "MEMORY.md"), join(srcWs, "memory.md")],
      },
      {
        targetFileName: "USER.md",
        sourceCandidates: [join(srcWs, "USER.md"), join(srcWs, "user.md")],
      },
      {
        targetFileName: "knowledgepool.md",
        sourceCandidates: [
          join(srcWs, "KNOWLEDGE.md"),
          join(srcWs, "knowledge.md"),
          join(sourceRoot, "KNOWLEDGE.md"),
          join(sourceRoot, "knowledge.md"),
        ],
      },
      {
        targetFileName: "dreaming.md",
        sourceCandidates: [join(srcWs, "DREAMS.md"), join(srcWs, "dreams.md")],
      },
    ];

    // Single curated files
    for (const c of candidates) {
      const src = findFirstFile(c.sourceCandidates);
      if (!src) continue;
      const targetPath = join(wsTarget, c.targetFileName);
      const srcContent = readFileSync(src, "utf8");
      const targetExists = isFile(targetPath);
      let action: "created" | "matched-existing" = "created";

      if (targetExists) {
        const targetContent = readFileSync(targetPath, "utf8");
        if (targetContent === srcContent) {
          action = "matched-existing";
        }
      }

      if (apply && action === "created") {
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        writeFileSync(targetPath, srcContent, { mode: 0o600 });
      }

      fileReports.push({
        sourceFile: src,
        targetFile: c.targetFileName,
        targetPath,
        action,
        bytes: Buffer.byteLength(srcContent, "utf8"),
      });
    }

    // Daily notes in ws/memory/
    const memoryDir = join(srcWs, "memory");
    if (isDir(memoryDir)) {
      try {
        const entries = readdirSync(memoryDir).sort();
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          const srcPath = join(memoryDir, entry);
          if (!isFile(srcPath)) continue;
          const match = entry.match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{6}))?\.md$/);
          const targetName = match
            ? `DailyNote_${match[1]}_${match[2] ?? "000000"}.md`
            : (entry.startsWith("DailyNote_") ? entry : `DailyNote_${entry}`);
          const targetPath = join(wsTarget, targetName);
          const srcContent = readFileSync(srcPath, "utf8");
          const targetExists = isFile(targetPath);
          let action: "created" | "matched-existing" = "created";

          if (targetExists) {
            const targetContent = readFileSync(targetPath, "utf8");
            if (targetContent === srcContent) {
              action = "matched-existing";
            }
          }

          if (apply && action === "created") {
            mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
            writeFileSync(targetPath, srcContent, { mode: 0o600 });
          }

          fileReports.push({
            sourceFile: srcPath,
            targetFile: targetName,
            targetPath,
            action,
            bytes: Buffer.byteLength(srcContent, "utf8"),
          });
        }
      } catch {
        // Unreadable memory dir ignored
      }
    }
  }

  if (apply) {
    // Scaffold template files if missing (SOUL.md, USER.md, persona-voice.md)
    scaffoldFiles(l, agentId);
  }

  const filesCreated = fileReports.filter((f) => f.action === "created").length;
  const filesMatched = fileReports.filter((f) => f.action === "matched-existing").length;
  const filesSkipped = fileReports.filter((f) => f.action === "skipped").length;

  return {
    report: {
      sourceId: agentId,
      harnessAgentId: agentId,
      action: agentAction,
      workspaceDir: wsTarget,
      files: fileReports,
      counts: {
        filesCreated,
        filesMatched,
        filesSkipped,
      },
    },
    isNewAgent,
  };
}
