/** Release metadata; `channel` (stable|beta|dev) and `kind` (major|minor|patch) are validated at runtime. Unknown keys (e.g. `native`) are preserved verbatim. */
export interface FeedMetadata {
  version: string;
  channel: string;
  kind: string;
  security: boolean;
  date: string;
  notes: { de: string; en: string };
  minFromVersion: string;
  migrationNote?: { de: string; en: string };
  [key: string]: unknown;
}
export type RenderedFeed = FeedMetadata & { bundle: string; tauri: string };
export function renderFeed(metadata: FeedMetadata, bundle: Buffer, latest: Buffer): RenderedFeed;
