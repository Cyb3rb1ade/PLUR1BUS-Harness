import { describe, it, expect } from 'vitest';
import { FsFailure } from '../../core/src/tools/fs/failure.ts';
import { HostctlError, fail, failure, string, integer } from '../src/errors.ts';

describe('HostctlError and fail()', () => {
  it('carries the code and uses the hint as its message', () => {
    const e = new HostctlError('EXAMPLE', 'Example hint.');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('EXAMPLE');
    expect(e.message).toBe('Example hint.');
  });
  it('fail() throws a HostctlError with the given code', () => {
    expect(() => fail('DENIED', 'Nope.')).toThrow(HostctlError);
    try { fail('DENIED', 'Nope.'); } catch (e) { expect((e as HostctlError).code).toBe('DENIED'); }
  });
});

describe('failure() maps errors to typed results', () => {
  it('passes HostctlError codes and hints through', () => {
    expect(failure(new HostctlError('UNAVAILABLE', 'Install the helper.'))).toEqual({
      ok: false, error: { code: 'UNAVAILABLE', hint: 'Install the helper.' },
    });
  });

  it.each([
    ['binary-content', 'BINARY'],
    ['too-large', 'TOO_LARGE'],
    ['aborted', 'ABORTED'],
    ['not-found', 'NOT_FOUND'],
    ['not-a-directory', 'IO_ERROR'],
    ['not-a-file', 'IO_ERROR'],
    ['io-error', 'IO_ERROR'],
    ['internal-error', 'IO_ERROR'],
  ] as const)('maps FsFailure %s to %s and keeps its hint', (fsCode, expected) => {
    const f = new FsFailure(fsCode, 'internal message with /host/path');
    const result = failure(f);
    expect(result.error.code).toBe(expected);
    expect(result.error.hint).toBe(f.hint);
    expect(JSON.stringify(result)).not.toContain('/host/path');
  });

  it('maps a deny-listed path refusal to DENIED and any other refusal to OUTSIDE_ROOT', () => {
    expect(failure(new FsFailure('path-refused', 'x', 'deny-listed')).error.code).toBe('DENIED');
    expect(failure(new FsFailure('path-refused', 'x', 'outside-root')).error.code).toBe('OUTSIDE_ROOT');
    expect(failure(new FsFailure('path-refused', 'x')).error.code).toBe('OUTSIDE_ROOT');
  });

  it('maps an AbortError-named object to ABORTED', () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(failure(abort)).toEqual({ ok: false, error: { code: 'ABORTED', hint: 'Check the target and permissions; retry only after reviewing the request.' } });
  });

  it.each([
    ['plain Error', new Error('EACCES: /secret/location')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
  ] as const)('maps %s to IO_ERROR with the generic hint only', (_label, value) => {
    const result = failure(value);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('IO_ERROR');
    expect(result.error.hint).toBe('Check the target and permissions; retry only after reviewing the request.');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  // UNKLAR: soll FsFailure 'exists' auf EXISTS abgebildet werden (HostctlError nutzt EXISTS), oder ist IO_ERROR gewollt?
  it.skip('UNKLAR: maps FsFailure exists to EXISTS', () => {
    expect(failure(new FsFailure('exists', 'x')).error.code).toBe('EXISTS');
  });
  // UNKLAR: soll FsFailure 'changed' auf CHANGED abgebildet werden (HostctlError nutzt CHANGED), oder ist IO_ERROR gewollt?
  it.skip('UNKLAR: maps FsFailure changed to CHANGED', () => {
    expect(failure(new FsFailure('changed', 'x')).error.code).toBe('CHANGED');
  });
  // UNKLAR: soll FsFailure 'invalid-arguments' auf INVALID_ARGUMENT abgebildet werden, oder ist IO_ERROR gewollt?
  it.skip('UNKLAR: maps FsFailure invalid-arguments to INVALID_ARGUMENT', () => {
    expect(failure(new FsFailure('invalid-arguments', 'x')).error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('string()', () => {
  it('returns valid strings, including the empty string and Unicode', () => {
    expect(string({ k: '' }, 'k')).toBe('');
    expect(string({ k: 'plain' }, 'k')).toBe('plain');
    expect(string({ k: 'Grüße 👋 日本語' }, 'k')).toBe('Grüße 👋 日本語');
  });

  it.each([
    ['missing key', {}],
    ['number', { k: 1 }],
    ['null', { k: null }],
    ['array', { k: ['a'] }],
    ['embedded NUL', { k: 'a\0b' }],
    ['trailing NUL', { k: 'a\0' }],
    ['lone high surrogate', { k: '\uD800' }],
    ['lone low surrogate', { k: 'x\uDC00' }],
  ])('rejects %s with INVALID_ARGUMENT', (_label, args) => {
    try { string(args as Record<string, unknown>, 'k'); throw new Error('expected a throw'); }
    catch (e) {
      expect(e).toBeInstanceOf(HostctlError);
      expect((e as HostctlError).code).toBe('INVALID_ARGUMENT');
      expect((e as HostctlError).message).toBe('k must be a string without NUL bytes.');
    }
  });
});

describe('integer()', () => {
  it('returns the fallback for undefined only', () => {
    expect(integer(undefined, 7, 10)).toBe(7);
    expect(integer(undefined, 0, 0)).toBe(0);
  });

  it.each([0, 1, 5, 10])('accepts %i within 0..10', value => {
    expect(integer(value, 99, 10)).toBe(value);
  });

  it.each([
    ['above max', 11],
    ['negative', -1],
    ['float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['numeric string', '5'],
    ['null', null],
    ['boolean', true],
  ])('rejects %s with INVALID_ARGUMENT', (_label, value) => {
    try { integer(value, 0, 10); throw new Error('expected a throw'); }
    catch (e) {
      expect((e as HostctlError).code).toBe('INVALID_ARGUMENT');
      expect((e as HostctlError).message).toBe('Use an integer between 0 and 10.');
    }
  });

  it('accepts the largest safe integer when the max allows it', () => {
    expect(integer(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
