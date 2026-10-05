// OpenClaw agent scaffolding and curated file migration (docs/import.md §2.2, D14, D15, Batch 4).
// Places persona (SOUL.md) and D15 files in `l.workspaceDir(id)` (packages/core/src/paths.ts:35).
// Idempotent: existing identical files are classified as `matched-existing` with zero writes.
// Conflict-safe: supports skip (default), rename, and replace conflict strategies.
// Ledger-tracked: records every entity mutation into ImportLedger with idempotency keys.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { scaffoldFiles } from "../../agents.ts";
import type { Layout } from "../../paths.ts";
import {
  agentIdempotencyKey,
  fileIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { isDir, isFile } from "../readonly.ts";
import type { AgentInfo } from "../types.ts";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const FORBIDDEN_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB size cap

export interface MigratedFileReport {
  sourceFile: string;
  targetFile: string;
  targetPath: string;
  action: "created" | "matched-existing" | "conflict" | "rename" | "replace" | "skipped";
  reason?: string;
  bytes: number;
  backupPath?: string;
}

export interface AgentImportReport {
  sourceId: string;
  harnessAgentId: string;
  action: "created" | "matched-existing" | "conflict" | "rejected";
  reason?: string;
  workspaceDir: string;
  files: MigratedFileReport[];
  counts: {
    filesCreated: number;
    filesMatched: number;
    filesConflicted: number;
    filesRenamed: number;
    filesReplaced: number;
    filesSkipped: number;
  };
}

export function validateAgentId(id: string): { ok: true } | { ok: false; reason: string } {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return { ok: false, reason: "invalid-agent-id" };
  }
  if (!AGENT_ID_RE.test(id)) {
    return { ok: false, reason: "invalid-agent-id" };
  }
  if (FORBIDDEN_PROPERTIES.has(id.toLowerCase())) {
    return { ok: false, reason: "invalid-agent-id" };
  }
  if (RESERVED_NAMES.test(id)) {
    return { ok: false, reason: "invalid-agent-id" };
  }
  return { ok: true };
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

function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function generateRenameTarget(targetFileName: string, wsTarget: string): { name: string; path: string } {
  const dotIdx = targetFileName.lastIndexOf(".");
  const base = dotIdx !== -1 ? targetFileName.slice(0, dotIdx) : targetFileName;
  const ext = dotIdx !== -1 ? targetFileName.slice(dotIdx) : "";

  for (let i = 1; i <= 1000; i++) {
    const candidateName = i === 1 ? `${base}.openclaw${ext}` : `${base}.openclaw-${i}${ext}`;
    const candidatePath = join(wsTarget, candidateName);
    if (!existsSync(candidatePath)) {
      return { name: candidateName, path: candidatePath };
    }
  }
  const fallback = `${base}.openclaw-${Date.now()}${ext}`;
  return { name: fallback, path: join(wsTarget, fallback) };
}

export function planAndMigrateAgent(
  agent: AgentInfo,
  sourceRoot: string,
  l: Layout,
  existingAgentIds: Set<string>,
  apply: boolean,
  onConflict: ConflictStrategy = "skip",
  ledger?: ImportLedger,
  replacedBackupDir?: string,
): { report: AgentImportReport; isNewAgent: boolean } {
  const agentId = agent.agentId;

  // C3: Validate untrusted agentId before any path or config use
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

  const isNewAgent = !existingAgentIds.has(agentId);
  const agentAction = isNewAgent ? "created" : "matched-existing";
  const wsTarget = l.workspaceDir(agentId);
  const srcWs = agent.workspace;

  const fileReports: MigratedFileReport[] = [];
  const usedTargetNames = new Set<string>();

  const processFile = (src: string, initialTargetFileName: string) => {
    let targetFileName = initialTargetFileName;

    // Check if target name already used by another file in this migration run
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

    // I2: Check symlink traversal escaping sourceRoot
    try {
      const st = lstatSync(src);
      if (st.isSymbolicLink()) {
        const real = realpathSync(src);
        if (!isInsideDir(sourceRoot, real)) {
          fileReports.push({
            sourceFile: src,
            targetFile: targetFileName,
            targetPath: join(wsTarget, targetFileName),
            action: "skipped",
            reason: "symlink-escape",
            bytes: 0,
          });
          return;
        }
      }
      if (st.size > MAX_FILE_BYTES) {
        fileReports.push({
          sourceFile: src,
          targetFile: targetFileName,
          targetPath: join(wsTarget, targetFileName),
          action: "skipped",
          reason: "file-too-large",
          bytes: st.size,
        });
        return;
      }
    } catch {
      return;
    }

    // Read byte-exact Buffer (no UTF-8 transcoding)
    let srcBuffer: Buffer;
    try {
      srcBuffer = readFileSync(src);
    } catch {
      return;
    }

    if (srcBuffer.length > MAX_FILE_BYTES) {
      fileReports.push({
        sourceFile: src,
        targetFile: targetFileName,
        targetPath: join(wsTarget, targetFileName),
        action: "skipped",
        reason: "file-too-large",
        bytes: srcBuffer.length,
      });
      return;
    }

    const sha256 = createHash("sha256").update(srcBuffer).digest("hex");
    const idKey = fileIdempotencyKey(agentId, targetFileName, sha256);

    // Consult ledger for resumability / idempotency
    if (ledger && ledger.has(idKey)) {
      const prev = ledger.get(idKey)!;
      fileReports.push({
        sourceFile: src,
        targetFile: prev.targetRef ?? targetFileName,
        targetPath: join(wsTarget, prev.targetRef ?? targetFileName),
        action: "matched-existing",
        bytes: srcBuffer.length,
      });
      return;
    }

    let targetPath = join(wsTarget, targetFileName);
    const targetExists = existsSync(targetPath);
    let action: "created" | "matched-existing" | "conflict" | "rename" | "replace" = "created";
    let reason: string | undefined = undefined;
    let backupPath: string | undefined = undefined;

    if (targetExists) {
      try {
        const targetBuffer = readFileSync(targetPath);
        if (targetBuffer.equals(srcBuffer)) {
          action = "matched-existing";
        } else {
          // Differing content: apply conflict strategy
          if (onConflict === "rename") {
            const renamed = generateRenameTarget(targetFileName, wsTarget);
            targetFileName = renamed.name;
            targetPath = renamed.path;
            action = "rename";
            reason = "renamed-on-conflict";
          } else if (onConflict === "replace") {
            action = "replace";
            reason = "replaced-on-conflict";
            if (apply && replacedBackupDir) {
              const bkp = join(replacedBackupDir, agentId, targetFileName);
              mkdirSync(dirname(bkp), { recursive: true, mode: 0o700 });
              writeFileSync(bkp, targetBuffer);
              backupPath = bkp;
            }
          } else {
            action = "conflict";
            reason = "content-differs";
          }
        }
      } catch {
        action = "conflict";
        reason = "target-unreadable";
      }
    }

    if (apply) {
      if (action === "created") {
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        writeFileSync(targetPath, srcBuffer, { flag: "wx", mode: 0o600 });
      } else if (action === "rename") {
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        writeFileSync(targetPath, srcBuffer, { flag: "wx", mode: 0o600 });
      } else if (action === "replace") {
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        writeFileSync(targetPath, srcBuffer, { mode: 0o600 });
      }

      if (ledger) {
        ledger.record({
          entity: "file",
          idempotencyKey: idKey,
          action: action === "conflict" ? "conflict-skip" : action,
          sourceRef: src,
          targetRef: targetFileName,
          sha256,
          reason: reason ?? null,
          details: backupPath ? { backupPath } : undefined,
        });
      }
    }

    fileReports.push({
      sourceFile: src,
      targetFile: targetFileName,
      targetPath,
      action,
      ...(reason ? { reason } : {}),
      ...(backupPath ? { backupPath } : {}),
      bytes: srcBuffer.length,
    });
  };

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
      processFile(src, c.targetFileName);
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
          processFile(srcPath, targetName);
        }
      } catch {
        // Unreadable memory dir ignored
      }
    }
  }

  if (apply) {
    // Scaffold template files if missing (SOUL.md, USER.md, persona-voice.md in agentDir)
    scaffoldFiles(l, agentId);

    if (ledger) {
      ledger.record({
        entity: "agent",
        idempotencyKey: agentIdempotencyKey("openclaw", agentId),
        action: agentAction,
        sourceRef: agent.workspace ?? agentId,
        targetRef: wsTarget,
      });
    }
  }

  const filesCreated = fileReports.filter((f) => f.action === "created").length;
  const filesMatched = fileReports.filter((f) => f.action === "matched-existing").length;
  const filesConflicted = fileReports.filter((f) => f.action === "conflict").length;
  const filesRenamed = fileReports.filter((f) => f.action === "rename").length;
  const filesReplaced = fileReports.filter((f) => f.action === "replace").length;
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
        filesConflicted,
        filesRenamed,
        filesReplaced,
        filesSkipped,
      },
    },
    isNewAgent,
  };
}
