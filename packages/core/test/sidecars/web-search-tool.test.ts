// web.search as a registered tool: it exists only when a search backend is wired, it is a D109 network read
// (`net.fetch`), and its failures reach the dispatcher as typed tool failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeTools, ToolAdapterError } from '../../src/composition/tools.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { CAPABILITIES } from '../../src/policy/index.ts';
import { WebFailure } from '../../src/tools/web/failure.ts';
import type { WebSearch } from '../../src/tools/web/search.ts';
import type { ChatRequest } from '../../src/session/provider.ts';

const req = (): ChatRequest => ({ agentId: 'a1', principal: 'p1', sessionId: 's1', signal: new AbortController().signal, messages: [] } as unknown as ChatRequest);
const base = (home: string) => ({ home, roots: [], grants: { get: () => undefined, list: () => [] }, audit: memoryAuditSink() });
const ctx = () => ({ signal: new AbortController().signal, agentId: 'a1', principal: 'p1' });

test('web.search is not offered without a search backend', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ws-tool-'));
  try { assert.equal((await composeTools(base(home), req())).get('web.search'), undefined); } finally { await rm(home, { recursive: true, force: true }); }
});

test('web.search is a first-party D109 network read (net.fetch) and returns the normalised answer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ws-tool-'));
  const seen: unknown[] = [];
  const search: WebSearch = { search: async (args) => { seen.push(args); return { results: [], provider: 'searxng', skipped: [], provenance: { source: 'web.search', provider: 'searxng', retrievedAt: 'now', trust: 'untrusted' } }; } };
  try {
    const tool = (await composeTools({ ...base(home), webSearch: search }, req())).get('web.search')!;
    assert.ok(tool);
    assert.equal(tool.capability, 'net.fetch');
    assert.equal(tool.effect, CAPABILITIES.get('net.fetch')!.intrinsicEffect);
    assert.equal(tool.trust, 'first-party');
    assert.equal(tool.risk, 'low');
    assert.equal(tool.inputSchema.additionalProperties, false);
    const out = await tool.execute({ query: 'harness' }, ctx()) as { provider: string };
    assert.equal(out.provider, 'searxng');
    assert.deepEqual(seen, [{ query: 'harness' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a search failure becomes a typed tool failure with the web failure code and hint, not a stack', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ws-tool-'));
  const search: WebSearch = { search: async () => { throw new WebFailure('network-error', 'the SearXNG sidecar is unreachable at 10.0.0.2:8080'); } };
  try {
    const tool = (await composeTools({ ...base(home), webSearch: search }, req())).get('web.search')!;
    await assert.rejects(tool.execute({ query: 'q' }, ctx()), (e: unknown) => {
      assert.ok(e instanceof ToolAdapterError);
      assert.equal(e.code, 'tool-failed');
      const detail = e.detail as { isError: boolean; error: { code: string; hint: string } };
      assert.equal(detail.error.code, 'network-error');
      assert.ok(detail.error.hint.length > 0);
      return true;
    });
    const boom: WebSearch = { search: async () => { throw new Error('secret-token-123 leaked'); } };
    const tool2 = (await composeTools({ ...base(home), webSearch: boom }, req())).get('web.search')!;
    await assert.rejects(tool2.execute({ query: 'q' }, ctx()), (e: unknown) => e instanceof ToolAdapterError && !JSON.stringify(e.detail).includes('secret-token'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
