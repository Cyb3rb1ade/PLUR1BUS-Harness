/** Shared file planning has no target-write implementation; the offline wrapper alone supplies mutation authority. */
import type { AgentMutations } from "../agent-plan-ports.ts";
import { SourceReader } from "../source-reader.ts";
// Hermes agents & workspace migration (docs/import.md §3.1, M7 Batch 3).
// Migrates persona files (SOUL.md) and USER.md into l.workspaceDir(agentId).
// Scaffolds template files for new agents and records idempotent mutations to the ledger.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Layout } from "../../paths.ts";
import {
  agentIdempotencyKey,
  fileIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { isInsideDir } from "../fs-atomic.ts";
import { ImportError } from "../types.ts";
import {
  validateAgentId,
  type ImportedFileReport,
  type AgentImportReport,
  MAX_FILE_BYTES,
} from "./openclaw-agent-plan.ts";

function parseBaseExt(fileName: string): { base: string; ext: string } {
  if (fileName.startsWith(".") && fileName.indexOf(".", 1) === -1) {
    return { base: fileName, ext: "" };
  }
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx > 0) {
    return { base: fileName.slice(0, dotIdx), ext: fileName.slice(dotIdx) };
  }
  return { base: fileName, ext: "" };
}

function findExistingRenamedMatch(fileName: string, wsTarget: string, srcBuf: Buffer): string | null {
  if (!existsSync(wsTarget)) return null;
  const { base, ext } = parseBaseExt(fileName);
  try {
    const entries = readdirSync(wsTarget);
    for (const ent of entries) {
      if (ent === `${base}.hermes${ext}` || ent.startsWith(`${base}.hermes-`)) {
        const p = join(wsTarget, ent);
        try {
          const buf = readFileSync(p);
          if (buf.equals(srcBuf)) {
            return ent;
          }
        } catch {
          // ignore unreadable
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function generateRenameTarget(fileName: string, wsTarget: string, usedNames?: Set<string>): { name: string; path: string } {
  const { base, ext } = parseBaseExt(fileName);

  for (let i = 1; i <= 1000; i++) {
    const candidateName = i === 1 ? `${base}.hermes${ext}` : `${base}.hermes-${i}${ext}`;
    const candidatePath = join(wsTarget, candidateName);
    if (!existsSync(candidatePath) && (!usedNames || !usedNames.has(candidateName))) {
      usedNames?.add(candidateName);
      return { name: candidateName, path: candidatePath };
    }
  }
  const fallback = `${base}.hermes-${Date.now()}${ext}`;
  usedNames?.add(fallback);
  return { name: fallback, path: join(wsTarget, fallback) };
}

export async function planHermesAgent(
  agentId: string,
  profileDir: string,
  hermesRoot: string,
  l: Layout,
  existingAgentIds: Set<string>,
  mutations: AgentMutations | undefined,
  defaultConflict: ConflictStrategy = "skip",
  ledger?: ImportLedger,
  replacedBackupDir?: string,
  userBound = false,
  sourceReader?: SourceReader,
  chooseConflict?: (targetFile: string) => ConflictStrategy,
): Promise<{ report: AgentImportReport; isNewAgent: boolean }> {
  const reader = sourceReader ?? await SourceReader.local();
  // Validate agentId
  const validation = validateAgentId(agentId);
  if (!validation.ok) {
    return {
      report: {
        sourceId: agentId,
        harnessAgentId: agentId,
        action: "rejected",
        reason: validation.reason,
        workspaceDir: "",
        files: [],
        counts: {
          filesCreated: 0,
          filesMatched: 0,
          filesConflicted: 0,
          filesRenamed: 0,
          filesReplaced: 0,
          filesSkipped: 0,
        },
      },
      isNewAgent: false,
    };
  }

  const wsTarget = l.workspaceDir(agentId);
  const isNewAgent = !existingAgentIds.has(agentId);
  const fileReports: ImportedFileReport[] = [];
  const usedTargetNames = new Set<string>();

  const processFile = async (src: string, initialTargetFileName: string) => {
    const onConflict = chooseConflict?.(initialTargetFileName) ?? defaultConflict;
    let targetFileName = initialTargetFileName;

    if (usedTargetNames.has(targetFileName)) {
      fileReports.push({
        sourceFile: src,
        targetFile: targetFileName,
        targetPath: join(wsTarget, targetFileName),
        action: "conflict",
        reason: "target-name-collision",
        bytes: 0,
      });
      return;
    }
    usedTargetNames.add(targetFileName);

    let srcBuffer: Buffer;
    try {
      srcBuffer = await reader.read(src, MAX_FILE_BYTES);
    } catch (error) {
      SourceReader.refuseFatal(error);
      fileReports.push({
        sourceFile: src,
        targetFile: targetFileName,
        targetPath: join(wsTarget, targetFileName),
        action: "skipped",
        reason: error instanceof ImportError ? error.reason : "source-unreadable",
        bytes: 0,
      });
      return;
    }

    const srcSha = createHash("sha256").update(srcBuffer).digest("hex");
    let targetFilePath = join(wsTarget, targetFileName);

    if (existsSync(targetFilePath)) {
      let targetBuffer: Buffer | null = null;
      try {
        targetBuffer = readFileSync(targetFilePath);
      } catch {
        targetBuffer = null;
      }

      if (targetBuffer && targetBuffer.equals(srcBuffer)) {
        fileReports.push({
          sourceFile: src,
          targetFile: targetFileName,
          targetPath: targetFilePath,
          action: "matched-existing",
          bytes: srcBuffer.length,
        });
        if (mutations && ledger) {
          const key = fileIdempotencyKey(agentId, targetFileName, srcSha);
          if (!ledger.has(key)) {
            ledger.record({
              entity: "file",
              idempotencyKey: key,
              action: "matched-existing",
              sourceRef: src,
              targetRef: relative(l.home, targetFilePath).replaceAll("\\", "/"),
              sha256: srcSha,
            });
          }
        }
        return;
      }

      // Existing file has DIFFERENT content: conflict strategy
      if (onConflict === "skip") {
        fileReports.push({
          sourceFile: src,
          targetFile: targetFileName,
          targetPath: targetFilePath,
          action: "conflict",
          reason: "file-already-exists-different-content",
          bytes: srcBuffer.length,
        });
        if (mutations && ledger) {
          const key = fileIdempotencyKey(agentId, targetFileName, srcSha);
          if (!ledger.has(key)) {
            ledger.record({
              entity: "file",
              idempotencyKey: key,
              action: "conflict-skip",
              sourceRef: src,
              targetRef: relative(l.home, targetFilePath).replaceAll("\\", "/"),
              sha256: srcSha,
            });
          }
        }
        return;
      }

      if (onConflict === "rename") {
        const existingRenamed = findExistingRenamedMatch(targetFileName, wsTarget, srcBuffer);
        if (existingRenamed) {
          const existingRenamedPath = join(wsTarget, existingRenamed);
          fileReports.push({
            sourceFile: src,
            targetFile: existingRenamed,
            targetPath: existingRenamedPath,
            action: "matched-existing",
            bytes: srcBuffer.length,
          });
          if (mutations && ledger) {
            const key = fileIdempotencyKey(agentId, existingRenamed, srcSha);
            if (!ledger.has(key)) {
              ledger.record({
                entity: "file",
                idempotencyKey: key,
                action: "matched-existing",
                sourceRef: src,
                targetRef: relative(l.home, existingRenamedPath).replaceAll("\\", "/"),
                sha256: srcSha,
              });
            }
          }
          return;
        }

        const renamed = generateRenameTarget(targetFileName, wsTarget, usedTargetNames);
        targetFileName = renamed.name;
        targetFilePath = renamed.path;

        if (mutations) {
          mutations.writeAtomic(targetFilePath, srcBuffer, 0o600);
        }

        fileReports.push({
          sourceFile: src,
          targetFile: targetFileName,
          targetPath: targetFilePath,
          action: "rename",
          bytes: srcBuffer.length,
        });

        if (mutations && ledger) {
          ledger.record({
            entity: "file",
            idempotencyKey: fileIdempotencyKey(agentId, targetFileName, srcSha),
            action: "rename",
            sourceRef: src,
            targetRef: relative(l.home, targetFilePath).replaceAll("\\", "/"),
            sha256: srcSha,
          });
        }
        return;
      }

      if (onConflict === "replace") {
        let backupPath: string | undefined = undefined;
        if (mutations && replacedBackupDir) {
          mutations.mkdir(replacedBackupDir, { recursive: true, mode: 0o700 });
          const relFromHome = relative(l.home, targetFilePath).replaceAll("\\", "/");
          backupPath = join(replacedBackupDir, relFromHome);
          mutations.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
          mutations.writeAtomic(backupPath, targetBuffer!, 0o600);
        }

        if (mutations) {
          mutations.writeAtomic(targetFilePath, srcBuffer, 0o600);
        }

        fileReports.push({
          sourceFile: src,
          targetFile: targetFileName,
          targetPath: targetFilePath,
          action: "replace",
          backupPath,
          bytes: srcBuffer.length,
        });

        if (mutations && ledger) {
          ledger.record({
            entity: "file",
            idempotencyKey: fileIdempotencyKey(agentId, targetFileName, srcSha),
            action: "replace",
            sourceRef: src,
            targetRef: relative(l.home, targetFilePath).replaceAll("\\", "/"),
            sha256: srcSha,
            details: backupPath ? { backupPath } : undefined,
          });
        }
        return;
      }
    }

    // Target file does not exist: create it
    if (mutations) {
      mutations.writeAtomic(targetFilePath, srcBuffer, 0o600);
    }

    fileReports.push({
      sourceFile: src,
      targetFile: targetFileName,
      targetPath: targetFilePath,
      action: "created",
      bytes: srcBuffer.length,
    });

    if (mutations && ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, targetFileName, srcSha),
        action: "created",
        sourceRef: src,
        targetRef: relative(l.home, targetFilePath).replaceAll("\\", "/"),
        sha256: srcSha,
      });
    }
  };

  // If applying: ensure workspace directory exists and scaffold default files for new agents
  if (mutations) {
    mutations.mkdir(wsTarget, { recursive: true, mode: 0o700 });
    if (isNewAgent) {
      mutations.scaffold(l, agentId);
    }
  }

  // 1. Process SOUL.md if present
  // existsNoFollow, not isFile: a symlink or FIFO is reported, never skipped silently.
  const soulPath = reader.paths.join(profileDir, "SOUL.md");
  if (await reader.exists(soulPath)) {
    await processFile(soulPath, "SOUL.md");
  }

  // 2. A profile-root USER.md is user-scoped content (ADR-007 Q4): copied only with an unambiguous user binding.
  // Without one it is reported and not copied, exactly like the memories/USER.md cards (unresolved-user-scope).
  const rootUserPath = reader.paths.join(profileDir, "USER.md");
  if (await reader.exists(rootUserPath)) {
    if (userBound) {
      await processFile(rootUserPath, "USER.md");
    } else {
      fileReports.push({
        sourceFile: rootUserPath,
        targetFile: "USER.md",
        targetPath: join(wsTarget, "USER.md"),
        action: "skipped",
        reason: "unresolved-user-scope",
        bytes: 0,
      });
    }
  }

  const filesCreated = fileReports.filter((f) => f.action === "created").length;
  const filesMatched = fileReports.filter((f) => f.action === "matched-existing").length;
  const filesConflicted = fileReports.filter((f) => f.action === "conflict").length;
  const filesRenamed = fileReports.filter((f) => f.action === "rename").length;
  const filesReplaced = fileReports.filter((f) => f.action === "replace").length;
  const filesSkipped = fileReports.filter((f) => f.action === "skipped").length;

  if (mutations && isNewAgent && ledger) {
    ledger.record({
      entity: "agent",
      idempotencyKey: agentIdempotencyKey("hermes", agentId),
      action: "created",
      sourceRef: profileDir,
      targetRef: `agents/${agentId}`,
    });
  }

  return {
    report: {
      sourceId: agentId,
      harnessAgentId: agentId,
      action: isNewAgent ? "created" : "matched-existing",
      workspaceDir: wsTarget,
      files: fileReports,
      counts: {
        filesCreated,
        filesMatched,
        filesConflicted,
        filesRenamed,
        filesReplaced,
        filesSkipped,
      },
    },
    isNewAgent,
  };
}
