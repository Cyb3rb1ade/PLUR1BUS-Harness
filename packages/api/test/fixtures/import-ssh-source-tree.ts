/** Known-home source trees for actual read-only SSH import acceptance. Foreign family names come from the Core catalog. */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SOURCE_CATALOG, type SourceType } from "../../../core/src/import/types.ts";

export interface SshSourceFixture {
  family: SourceType;
  localPath: string;
  remotePath: string;
  skill: string;
  agentId: string;
  knowledge: string;
}
/** Contains no key material. The synthetic credential canary belongs only to the input trees. */
export async function createSshSources(root: string): Promise<{ canary: string; sources: SshSourceFixture[] }> {
  if (SOURCE_CATALOG.length !== 2) throw new Error("review SSH source fixtures for the changed source catalog");
  const canary = `SSH_SOURCE_CREDENTIAL_${randomBytes(24).toString("hex")}`;
  const sources: SshSourceFixture[] = [];
  for (const [index, entry] of SOURCE_CATALOG.entries()) {
    const user = index === 0 ? "alice" : "bob";
    const remotePath = `/home/${user}/.${entry.id}`;
    const localPath = resolve(root, ...remotePath.split("/").filter(Boolean));
    const workspace = index === 0 ? join(localPath, "workspace") : localPath;
    const skill = `ssh-proof-${index === 0 ? "a" : "b"}`;
    const knowledge =
      index === 0
        ? "The Amber Birch review window is Monday after the SSH source import is verified."
        : "The Silver Maple review window is Friday after the SSH source import is verified.";
    await mkdir(join(workspace, "skills", skill), { recursive: true });
    await writeFile(
      join(workspace, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Read-only SSH source acceptance\n---\nA source skill imported only after explicit maintenance consent.\n`,
    );
    await writeFile(join(workspace, "SOUL.md"), "# Import persona\nUse the reviewed source knowledge.\n");
    if (index === 0) {
      await writeFile(join(workspace, "MEMORY.md"), `# Amber Birch review\n\n${knowledge}\n`);
      await writeFile(
        join(localPath, `${entry.id}.json`),
        JSON.stringify({
          meta: { lastTouchedVersion: "2026.9.5" },
          agents: { defaults: { workspace: "./workspace" } },
          mcp: { servers: { search: { url: "https://tools.example/mcp", headers: { Authorization: canary } } } },
          plugins: { entries: { example: { enabled: true } } },
        }),
      );
    } else {
      await mkdir(join(workspace, "memories"), { recursive: true });
      await writeFile(join(workspace, "memories", "MEMORY.md"), `# Silver Maple review\n\n${knowledge}\n`);
      await writeFile(
        join(localPath, "config.yaml"),
        `_config_version: 45\nmcp_servers:\n  search:\n    url: https://tools.example/mcp\n    headers:\n      Authorization: ${canary}\nplugins: ["example"]\n`,
      );
    }
    sources.push({
      family: entry.id,
      localPath,
      remotePath,
      skill,
      agentId: index === 0 ? "main" : "default",
      knowledge,
    });
  }
  return { canary, sources };
}
