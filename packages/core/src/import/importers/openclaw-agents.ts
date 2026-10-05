// OpenClaw agents & workspace migration (docs/import.md §1, §2.2, M7 Batch 2 & Batch 4).
// Migrates persona files (SOUL.md), curated workspace files, and daily notes
// into `l.workspaceDir(agentId)` (agents/<id>/workspace/).
// Scaffolds template files for new agents and records idempotent mutations to the ledger.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { scaffoldFiles } from "../../agents.ts";
import type { Layout } from "../../paths.ts";
import { isDir, isFile } from "../readonly.ts";
import {
  agentIdempotencyKey,
  fileIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { isInsideDir, writeAtomicSync } from "../fs-atomic.ts";
import type { AgentInfo } from "../types.ts";

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB per file

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FORBIDDEN_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface ImportedFileReport {
  sourceFile: string;
  targetFile: string;
  targetPath: string;
  action: "created" | "matched-existing" | "conflict" | "rename" | "replace" | "skipped";
  reason?: string | undefined;
  backupPath?: string | undefined;
  bytes: number;
}

export interface AgentImportReport {
  sourceId: string;
  harnessAgentId: string;
  action: "created" | "matched-existing" | "rejected";
  reason?: string | undefined;
  workspaceDir: string;
  files: ImportedFileReport[];
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
      if (ent === `${base}.openclaw${ext}` || ent.startsWith(`${base}.openclaw-`)) {
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
    const candidateName = i === 1 ? `${base}.openclaw${ext}` : `${base}.openclaw-${i}${ext}`;
    const candidatePath = join(wsTarget, candidateName);
    if (!existsSync(candidatePath) && (!usedNames || !usedNames.has(candidateName))) {
      usedNames?.add(candidateName);
      return { name: candidateName, path: candidatePath };
    }
  }
  const fallback = `${base}.openclaw-${Date.now()}${ext}`;
  usedNames?.add(fallback);
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

  const wsTarget = l.workspaceDir(agentId);
  const isNewAgent = !existingAgentIds.has(agentId);
  const agentAction: "created" | "matched-existing" = isNewAgent ? "created" : "matched-existing";

  const fileReports: ImportedFileReport[] = [];
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
    } catch {
      return;
    }

    let srcBuffer: Buffer;
    try {
      srcBuffer = readFileSync(src);
    } catch {
      fileReports.push({
        sourceFile: src,
        targetFile: targetFileName,
        targetPath: join(wsTarget, targetFileName),
        action: "skipped",
        reason: "source-unreadable",
        bytes: 0,
      });
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
        targetFile: prev.targetRef ? basename(prev.targetRef) : targetFileName,
        targetPath: join(wsTarget, prev.targetRef ? basename(prev.targetRef) : targetFileName),
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
            const existingMatch = findExistingRenamedMatch(targetFileName, wsTarget, srcBuffer);
            if (existingMatch) {
              targetFileName = existingMatch;
              targetPath = join(wsTarget, existingMatch);
              action = "matched-existing";
              reason = "matched-renamed-existing";
            } else {
              const renamed = generateRenameTarget(targetFileName, wsTarget, usedTargetNames);
              targetFileName = renamed.name;
              targetPath = renamed.path;
              action = "rename";
              reason = "renamed-on-conflict";
            }
          } else if (onConflict === "replace") {
            action = "replace";
            reason = "replaced-on-conflict";
            if (apply && replacedBackupDir) {
              const bkp = join(replacedBackupDir, agentId, targetFileName);
              writeAtomicSync(bkp, targetBuffer, 0o600);
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
      if (action === "created" || action === "rename" || action === "replace") {
        writeAtomicSync(targetPath, srcBuffer, 0o600);
      }

      if (ledger) {
        const relTargetRef = relative(l.home, targetPath).replaceAll("\\", "/");
        ledger.record({
          entity: "file",
          idempotencyKey: idKey,
          action: action === "conflict" ? "conflict-skip" : action,
          sourceRef: src,
          targetRef: relTargetRef,
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
      reason,
      bytes: srcBuffer.length,
      backupPath,
    });
  };

  // Curated files from workspace (D15)
  const srcWs = agent.workspace;
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

    // Record template files created for a new agent into the ledger
    if (isNewAgent && ledger) {
      const templates = ["SOUL.md", "USER.md", "persona-voice.md"];
      for (const t of templates) {
        const full = join(l.agentDir(agentId), t);
        if (existsSync(full)) {
          const rel = relative(l.home, full).replaceAll("\\", "/");
          const tSha = createHash("sha256").update(readFileSync(full)).digest("hex");
          const tKey = fileIdempotencyKey(agentId, t, tSha);
          if (!ledger.has(tKey)) {
            ledger.record({
              entity: "file",
              idempotencyKey: tKey,
              action: "created",
              sourceRef: "template",
              targetRef: rel,
              sha256: tSha,
              reason: "scaffolded-template",
            });
          }
        }
      }
    }

    if (ledger) {
      ledger.record({
        entity: "agent",
        idempotencyKey: agentIdempotencyKey("openclaw", agentId),
        action: agentAction,
        sourceRef: agent.workspace ?? agentId,
        targetRef: relative(l.home, wsTarget).replaceAll("\\", "/"),
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
