// Branch and worktree names (subprojects spec §6.2). Only core-generated keys reach git argv.
// A card worktree is the documented variant: branch `p1b/<rootKey>/c-<6 hex>`, path `.../cards/c-<6 hex>`.

export const SLUG_MAX = 24;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export function slug(name: string): string {
  const s = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX);
  return s || "project";
}

export function hex6(id: string): string {
  return id.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6).padEnd(6, "0");
}

export function projectKey(name: string, id: string): string {
  return `${slug(name)}-${hex6(id)}`;
}

export function rootBranch(key: string): string {
  return `p1b/${key}/main`;
}

export function cardBranch(rootKey: string, cardId: string): string {
  return `p1b/${rootKey}/c-${hex6(cardId)}`;
}

export function assertId(id: string): string {
  if (!ID.test(id)) throw new Error(`unsafe worktree id ${id}`);
  return id;
}
