/** Shared file planning has no target-write implementation; the offline wrapper alone supplies mutation authority. */
import type { AgentMutations } from "../agent-plan-ports.ts";
import { SourceReader } from "../source-reader.ts";
// OpenClaw agents & workspace migration (docs/import.md §1, §2.2, M7 Batch 2 & Batch 4).
// Migrates persona files (SOUL.md), curated workspace files, and daily notes
// into `l.workspaceDir(agentId)` (agents/<id>/workspace/).
// Scaffolds template files for new agents and records idempotent mutations to the ledger.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertKnowledgeTarget, formatImportedKnowledge } from "../../knowledge/file.ts";
import { KNOWLEDGE_RELATIVE_PATH } from "../../paths.ts";
import type { Layout } from "../../paths.ts";
import { isDir } from "../readonly.ts";
import { decodeSourceText } from "../fs-safe.ts";
import {
  agentIdempotencyKey,
  fileIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { isInsideDir } from "../fs-atomic.ts";
import { ImportError, type AgentInfo } from "../types.ts";

export const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB per file

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
  action: "created" | "matched-existing" | "rejected" | "merged";
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

async function findFirstFile(candidates: string[], reader: SourceReader): Promise<string | null> {
  for (const c of candidates) {
    try { if (await reader.exists(c)) return c; } catch (error) { SourceReader.refuseFatal(error); /* missing candidate */ }
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

export async function planOpenclawAgent(
  agent: AgentInfo,
  sourceRoot: string,
  l: Layout,
  existingAgentIds: Set<string>,
  mutations: AgentMutations | undefined,
  defaultConflict: ConflictStrategy = "skip",
  ledger?: ImportLedger,
  replacedBackupDir?: string,
  sourceReader?: SourceReader,
  chooseConflict?: (targetFile: string) => ConflictStrategy,
): Promise<{ report: AgentImportReport; isNewAgent: boolean }> {
  const reader = sourceReader ?? await SourceReader.local();
  const S = reader.paths;
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

  const processFile = async (src: string, initialTargetFileName: string, additionalSources: string[] = []) => {
    const onConflict = chooseConflict?.(initialTargetFileName) ?? defaultConflict;
    let targetFileName = initialTargetFileName;
    const canonicalKnowledge = initialTargetFileName === KNOWLEDGE_RELATIVE_PATH;
    if (canonicalKnowledge) assertKnowledgeTarget(wsTarget, l.home);

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

    let srcBuffer: Buffer;
    try {
      const buffers: Buffer[] = [];
      for (const source of [src, ...additionalSources]) {
        // O_NOFOLLOW only protects the leaf; reject linked directories within the source tree too.
        const root = S.resolve([sourceRoot, agent.workspace, agent.agentDir].find((candidate) => {
          if (!candidate) return false;
          const rel = S.relative(candidate, source);
          return !S.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${S.sep}`);
        }) ?? S.dirname(source));
        for (let dir = S.resolve(S.dirname(source)); ; dir = S.dirname(dir)) {
          if ((await reader.stat(dir, false))?.type === "symlink") {
            throw new ImportError("E_IMPORT_FAILED", "unsafe-symlink", `${relative(root, dir) || "."}: unsafe-symlink`);
          }
          if (dir === root || S.dirname(dir) === dir) break;
        }
        buffers.push(await reader.read(source, MAX_FILE_BYTES));
      }
      srcBuffer = buffers.length === 1 ? buffers[0]! : Buffer.from(buffers.map(decodeSourceText).join("\n\n"));
      if (canonicalKnowledge) srcBuffer = Buffer.from(formatImportedKnowledge(decodeSourceText(srcBuffer), "agent-curated-import"));
      if (srcBuffer.length > MAX_FILE_BYTES) throw new ImportError("E_IMPORT_FAILED", "file-too-large", "Combined knowledge exceeds the file size limit");
    } catch (error) {
      SourceReader.refuseFatal(error);
      let reason = error instanceof ImportError ? error.reason : "source-unreadable";
      if (reason === "unsafe-symlink") {
        try {
          if (!reader.contains(await reader.fs.realpath(sourceRoot), await reader.fs.realpath(src))) reason = "symlink-escape";
        } catch { /* dangling or changing symlink: keep unsafe-symlink */ }
      }
      fileReports.push({
        sourceFile: src,
        targetFile: targetFileName,
        targetPath: join(wsTarget, targetFileName),
        action: "skipped",
        reason,
        bytes: 0,
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
        targetFile: prev.targetRef ? join(dirname(initialTargetFileName), basename(prev.targetRef)) : targetFileName,
        targetPath: join(wsTarget, dirname(initialTargetFileName), prev.targetRef ? basename(prev.targetRef) : basename(targetFileName)),
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
          // Differing content: use the selected conflict strategy
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
            if (mutations && replacedBackupDir) {
              const bkp = join(replacedBackupDir, agentId, targetFileName);
              mutations.writeAtomic(bkp, targetBuffer, 0o600);
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

    if (mutations) {
      if (action === "created" || action === "rename" || action === "replace") {
        if (canonicalKnowledge && targetFileName === KNOWLEDGE_RELATIVE_PATH) mutations.writeKnowledge(wsTarget, srcBuffer, l.home);
        else {
          if (canonicalKnowledge) assertKnowledgeTarget(wsTarget, l.home);
          mutations.writeAtomic(targetPath, srcBuffer, 0o600);
        }
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
  if (srcWs && await reader.isDir(srcWs)) {
    const candidates: CuratedCandidate[] = [
      {
        targetFileName: "SOUL.md",
        sourceCandidates: [
          S.join(srcWs, "SOUL.md"),
          S.join(srcWs, "soul.md"),
          ...(agent.agentDir ? [S.join(agent.agentDir, "SOUL.md")] : []),
        ],
      },
      {
        targetFileName: "USER.md",
        sourceCandidates: [S.join(srcWs, "USER.md"), S.join(srcWs, "user.md")],
      },
      {
        targetFileName: "DREAMS.md",
        sourceCandidates: [S.join(srcWs, "DREAMS.md"), S.join(srcWs, "dreams.md")],
      },
    ];

    // Both curated sources share one canonical target and one conflict decision.
    // Read every selected source through the same source-tree/symlink checks.
    const memorySource = await findFirstFile([S.join(srcWs, "MEMORY.md"), S.join(srcWs, "memory.md")], reader);
    const knowledgeSource = await findFirstFile([
      S.join(srcWs, "memory", "KNOWLEDGE.md"), S.join(srcWs, "KNOWLEDGE.md"), S.join(srcWs, "knowledge.md"),
      S.join(sourceRoot, "KNOWLEDGE.md"), S.join(sourceRoot, "knowledge.md"),
    ], reader);
    const curatedSources = [...new Set([memorySource, knowledgeSource].filter((s): s is string => s !== null))];
    if (curatedSources.length > 0) await processFile(curatedSources[0]!, "memory/KNOWLEDGE.md", curatedSources.slice(1));

    for (const c of candidates) {
      const src = await findFirstFile(c.sourceCandidates, reader);
      if (!src) continue;
      await processFile(src, c.targetFileName);
    }

    // Daily notes in ws/memory/
    const memoryDir = S.join(srcWs, "memory");
    if (await reader.isDir(memoryDir)) {
      try {
        const entries = await reader.names(memoryDir);
        for (const entry of entries) {
          if (!entry.endsWith(".md") || entry.toLowerCase() === "knowledge.md") continue;
          const srcPath = S.join(memoryDir, entry);
          const match = entry.match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{6}))?\.md$/);
          const targetName = match
            ? `DailyNote_${match[1]}_${match[2] ?? "000000"}.md`
            : (entry.startsWith("DailyNote_") ? entry : `DailyNote_${entry}`);
          await processFile(srcPath, targetName);
        }
      } catch (error) {
        SourceReader.refuseFatal(error);
        // Unreadable memory dir ignored
      }
    }
  }

  if (mutations) {
    // Scaffold template files if missing (SOUL.md, USER.md, persona-voice.md in agentDir)
    mutations.scaffold(l, agentId);

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
