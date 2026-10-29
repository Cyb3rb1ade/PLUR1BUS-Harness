import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { isSecretFileName } from "../../../../core/src/import/secret-file-names.ts";
import type { McpToolContext, McpToolDef } from "../types.ts";
import type { McpToolGroup } from "./group.ts";

export const MAX_SKILL_FILE_BYTES = 64 * 1024;

export interface SkillDescriptor {
  name: string;
  description: string;
  instructions?: string;
  digest?: string;
  files?: string[];
  path?: string;
}

export interface SkillsToolGroupOptions {
  home?: string | undefined;
  skills?: SkillDescriptor[] | undefined;
  agentSkills?: ((agentId: string) => SkillDescriptor[]) | undefined;
}

export class SkillSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillSecurityError";
    this.code = code;
  }
}

function parseSkillUri(uri: string): { skillName: string; relativePath: string } {
  if (uri.startsWith("skill://") || uri.startsWith("skills://")) {
    const raw = uri.replace(/^skills?:\/\//, "");
    const slashIdx = raw.indexOf("/");
    if (slashIdx === -1) {
      return { skillName: raw, relativePath: "SKILL.md" };
    }
    return {
      skillName: raw.slice(0, slashIdx),
      relativePath: raw.slice(slashIdx + 1),
    };
  }
  throw new SkillSecurityError("invalid-uri", "Skill URI must use skill:// scheme");
}

function relativeParts(path: string): string[] {
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new SkillSecurityError("unsafe-path", "Invalid or unsafe resource path");
  }
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) {
    throw new SkillSecurityError("unsafe-path", "Path traversal forbidden");
  }
  return parts;
}

export class SkillsToolGroup implements McpToolGroup {
  readonly name = "skills";
  private readonly home?: string | undefined;
  private readonly defaultSkills: SkillDescriptor[];
  private readonly agentSkillsProvider?: ((agentId: string) => SkillDescriptor[]) | undefined;

  constructor(options: SkillsToolGroupOptions = {}) {
    this.home = options.home;
    this.defaultSkills = options.skills ?? [];
    this.agentSkillsProvider = options.agentSkills;
  }

  private getSkillsForAgent(agentId: string): SkillDescriptor[] {
    if (this.agentSkillsProvider) {
      return this.agentSkillsProvider(agentId);
    }
    return this.defaultSkills;
  }

  buildTools(ctx: McpToolContext): readonly McpToolDef[] {
    const listTool: McpToolDef = {
      name: "skills/list",
      description: "Lists approved skills available to the bound agent with SHA-256 digests.",
      group: "skills",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args, toolCtx) => {
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const skills = this.getSkillsForAgent(agentId);
        return {
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            digest: s.digest ?? createHash("sha256").update(s.name).digest("hex"),
          })),
        };
      },
    };

    const getTool: McpToolDef = {
      name: "skills/get",
      description: "Retrieves metadata and instructions for a specific skill.",
      group: "skills",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "The name of the skill." },
        },
      },
      handler: async (args, toolCtx) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("name is required");
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const skills = this.getSkillsForAgent(agentId);
        const skill = skills.find((s) => s.name === name);
        if (!skill) {
          throw new SkillSecurityError("skill-unavailable", `Skill not found or not permitted for agent: ${name}`);
        }
        return {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions ?? `Instructions for ${skill.name}`,
          digest: skill.digest ?? createHash("sha256").update(skill.name).digest("hex"),
          files: skill.files ?? ["SKILL.md"],
        };
      },
    };

    const readTool: McpToolDef = {
      name: "resources/read",
      description: "Reads a skill resource file subject to size and secret-exclusion boundaries.",
      group: "skills",
      inputSchema: {
        type: "object",
        required: ["uri"],
        properties: {
          uri: { type: "string", description: "The skill resource URI (e.g. skill://skill-name/path)." },
        },
      },
      handler: async (args, toolCtx) => {
        const uri = typeof args.uri === "string" ? args.uri.trim() : "";
        if (!uri) throw new Error("uri is required");
        const { skillName, relativePath } = parseSkillUri(uri);
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const skills = this.getSkillsForAgent(agentId);
        const skill = skills.find((s) => s.name === skillName);
        if (!skill) {
          throw new SkillSecurityError("skill-unavailable", `Skill unavailable: ${skillName}`);
        }

        const parts = relativeParts(relativePath);
        // Exclude secret files per N (#808) conventions
        for (const part of parts) {
          if (isSecretFileName(part)) {
            throw new SkillSecurityError("secret-file", `Access to secret or credential file denied: ${part}`);
          }
        }

        if (this.home && skill.path) {
          const fullPath = join(skill.path, ...parts);
          const stat = await lstat(fullPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new SkillSecurityError("unsafe-path", "Invalid file resource");
          }
          if (stat.size > MAX_SKILL_FILE_BYTES) {
            throw new SkillSecurityError("too-large", `Resource exceeds ${MAX_SKILL_FILE_BYTES} bytes limit`);
          }
          const fh = await open(fullPath, "r");
          try {
            const buf = await fh.readFile();
            return {
              contents: [{ uri, mimeType: "text/plain", text: buf.toString("utf8") }],
            };
          } finally {
            await fh.close();
          }
        }

        // Return simulated / inline resource if no disk path
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: skill.instructions ?? `# Skill: ${skill.name}\n\n${skill.description}`,
            },
          ],
        };
      },
    };

    return [listTool, getTool, readTool];
  }
}
