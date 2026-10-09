import { it, expect } from 'vitest';
import { defaults, validate, restartClassOf, tierOf } from '../../config-schema/src/index.ts';
import { DEFAULT_CONFIG } from '../src/index.ts';
it('schema defaults match executor defaults and every hostctl key restarts core in advanced tier', () => {
  expect(defaults().tools.hostctl).toEqual(DEFAULT_CONFIG);
  for (const key of ['enabled', 'shell.allowed', 'shell.default', 'exec.timeoutMs', 'output.maxBytes', 'env.allow', 'denyPatterns', 'search.maxResults']) {
    expect(restartClassOf(`tools.hostctl.${key}`)).toBe('core'); expect(tierOf(`tools.hostctl.${key}`)).toBe('advanced');
  }
  for (const patch of [{ exec: { timeoutMs: 0 } }, { output: { maxBytes: 1048577 } }, { shell: { default: 'cmd' } }, { search: { maxResults: 1001 } }, { remote: true }]) {
    expect(validate({ schemaVersion: 1, tools: { hostctl: patch } }).ok).toBe(false);
  }
});
