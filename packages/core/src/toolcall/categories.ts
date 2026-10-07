/** Stable two-level taxonomy. Labels form a cacheable classifier prefix; installations only change index rows. */
const TREE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  web: ['browse', 'research', 'search', 'fetch', 'monitor', 'extract'],
  docs: ['create', 'convert', 'read', 'edit', 'summarise', 'publish'],
  code: ['edit', 'review', 'debug', 'test', 'build', 'navigate'],
  data: ['analyse', 'query', 'visualise', 'transform', 'validate', 'export'],
  comm: ['email', 'chat', 'calendar', 'contacts', 'post', 'notify'],
  files: ['manage', 'read', 'search', 'archive', 'sync', 'share'],
  ops: ['system', 'process', 'package', 'network', 'service', 'diagnose'],
  memory: ['manage', 'recall', 'capture', 'correct', 'share', 'dream'],
  media: ['image', 'audio', 'video', 'design', 'transcribe', 'convert'],
  life: ['cooking', 'travel', 'shopping', 'planning', 'learning', 'fitness'],
  finance: ['research', 'budget', 'accounting', 'purchase', 'invoice'],
  project: ['plan', 'track', 'delegate', 'review', 'document'],
  os: ['apps', 'shortcuts', 'script', 'permissions', 'screen'],
  browser: ['navigate', 'read', 'interact', 'download', 'session'],
  plur1bus: ['admin', 'configure', 'diagnose', 'import', 'extensions'],
  general: ['chat', 'explain', 'translate', 'rewrite', 'calculate'],
});
export const CATEGORIES: readonly Readonly<{ id: string; description: string }>[] = Object.freeze(Object.entries(TREE).flatMap(([group, children]) => children.map(child => Object.freeze({ id: `${group}.${child}`, description: `${group}: ${child}` }))));
export const CATEGORY_PREFIX = JSON.stringify(CATEGORIES);
