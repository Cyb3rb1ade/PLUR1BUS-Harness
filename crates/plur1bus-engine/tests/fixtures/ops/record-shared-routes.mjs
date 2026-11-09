import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, 'v24.21.0');
const source = JSON.parse(readFileSync(new URL('./write-sources.json', import.meta.url), 'utf8'));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) files.push(file); } }
walk(path.join(root, 'engine')); walk(path.join(root, 'lib'));
const hash = createHash('sha256');
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update('\0'); }
assert.equal(hash.digest('hex'), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { SharedMemoryPool } = await load('lib/shared-memory-pool.js');
const { AgentDbPool } = await load('engine/store/agent-db-pool.js');
const { workspacePoolKey, userPoolKey, harnessUserPrincipal } = await load('lib/memory-request-context.js');
const { ensureSharedMemoryColumns } = await load('lib/shared-memory.js');
const context = { workspaceIdentity: 'workspace:v1:shared-routing-fixture', userPrincipal: harnessUserPrincipal('fixture') };
async function record() {
 const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'rx3-shared-routes-')));
 const base = path.join(temp, 'db');
 const pool = new SharedMemoryPool(base, 4, AgentDbPool, null, { mode: 'verified-path' });
 const keys = { workspace: workspacePoolKey(context.workspaceIdentity), user: userPoolKey(context.userPrincipal) };
 const count = async db => { if (db === null) return null; await db.init(); return db.table ? await db.table.countRows() : null; };
 try {
  const absent = await pool.withWorkspaceReadDb(context, count);
  const createdByRead = existsSync(base);
  const created = await pool.withWorkspaceDb(context, count);
  const workspacePath = path.join('.plur1bus-shared', 'workspaces', keys.workspace);
  const workspaceExists = existsSync(path.join(base, workspacePath, 'memories.lance'));
  const userAbsent = await pool.withUserReadDb(context, count);
  await pool.withUserDb(context, count);
  const userPath = path.join('.plur1bus-shared', 'users', keys.user);
  const userExists = existsSync(path.join(base, userPath, 'memories.lance'));
  const otherUser = await pool.withUserReadDb({ ...context, userPrincipal: harnessUserPrincipal('different-fixture') }, count);
  const sameUserOtherWorkspace = await pool.withUserReadDb({ ...context, workspaceIdentity: 'workspace:v1:another' }, count);
  const unbound = await pool.withWorkspaceReadDb({}, count);
  const migration = await pool.withWorkspaceDb(context, async db => {
   await db.init();
   await ensureSharedMemoryColumns(db);
   await db.table.dropColumns(['sourceAgentId', 'shareProvenance']);
   // A newly opened DB represents a restarted migration, not the per-object fulfilled promise cache.
   return (await db.table.schema()).fields.filter(f => ['sourceMemoryId','sourceAgentId','shareIdempotencyKey','shareProvenance'].includes(f.name)).map(f => f.name);
  });
  await pool.shutdown();
  const reopened = new SharedMemoryPool(base, 4, AgentDbPool, null, { mode: 'verified-path' });
  let repaired, partialReadCount;
  try { partialReadCount = await reopened.withWorkspaceReadDb(context, count); repaired = await reopened.withWorkspaceDb(context, async db => { await db.init(); await ensureSharedMemoryColumns(db); return (await db.table.schema()).fields.filter(f => ['sourceMemoryId','sourceAgentId','shareIdempotencyKey','shareProvenance'].includes(f.name)).map(f => f.name); }); } finally { await reopened.shutdown(); }
  const attack = new SharedMemoryPool(base, 4, AgentDbPool, null, { mode: 'verified-path' });
  let firstReplacedRootError, taintedRead, supportAfterReplacement;
  try {
   await attack.withWorkspaceReadDb(context, count);
   renameSync(path.join(base, '.plur1bus-shared'), path.join(base, 'original-shared'));
   mkdirSync(path.join(base, '.plur1bus-shared'), { mode: 0o700 });
   try { await attack.withWorkspaceReadDb(context, count); } catch (error) { firstReplacedRootError = error.code ?? error.reason ?? 'error'; }
   supportAfterReplacement = attack.support();
   taintedRead = await attack.withWorkspaceReadDb(context, count);
  } finally { await attack.shutdown(); }
  const permissions = [];
  for (const cached of [false, true]) {
   const permissionBase = path.join(temp, `permissions-${cached}`);
   const permissionPool = new SharedMemoryPool(permissionBase, 4, AgentDbPool, null, { mode: 'verified-path' });
   try {
    if (cached) await permissionPool.withUserDb(context, count);
    const sharedPath = path.join(permissionBase, '.plur1bus-shared');
    mkdirSync(sharedPath, { recursive: true, mode: 0o700 }); chmodSync(sharedPath, 0o755);
    let writeAllowed = false;
    try { await permissionPool.withUserDb(context, count); writeAllowed = true; } catch { writeAllowed = false; }
    permissions.push({ cached, writeAllowed, support: permissionPool.support() });
   } finally { await permissionPool.shutdown(); }
  }
  return { keys, absent, createdByRead, created, workspacePath, workspaceExists, userAbsent, userPath, userExists, otherUser, sameUserOtherWorkspace, unbound, partialColumns: migration, partialReadCount, repairedColumns: repaired, firstReplacedRootError, supportAfterReplacement, taintedRead, permissions };
 } finally { await pool.shutdown(); rmSync(temp, { recursive: true, force: true }); }
}
const expected = await record(); assert.deepEqual(await record(), expected);
writeFileSync(new URL('./golden/shared-routes.json', import.meta.url), JSON.stringify({ recordedFrom: { source, node: process.version }, context, expected }, null, 2) + '\n');
console.log('Recorded real Node shared routing and resumed schema migration twice');
