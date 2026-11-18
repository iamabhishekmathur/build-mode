import { describe, expect, it } from 'vitest';
import { applyPatch, getPath, matches, parsePath, PathError } from '@stagecraft/core';

describe('path', () => {
  const db = () => ({ account: { status: 'active' }, users: [{ id: 'u1', step: 1 }, { id: 'u2', step: 2 }], tags: ['a'] });

  it('parses keys, indexes and matchers', () => {
    expect(parsePath('users[id=u2].step')).toEqual([
      { kind: 'key', key: 'users' },
      { kind: 'match', field: 'id', value: 'u2' },
      { kind: 'key', key: 'step' },
    ]);
    expect(parsePath('tags[0]')).toEqual([{ kind: 'key', key: 'tags' }, { kind: 'index', index: 0 }]);
    expect(() => parsePath('')).toThrow(PathError);
  });

  it('gets values', () => {
    expect(getPath(db(), 'users[id=u2].step')).toBe(2);
    expect(getPath(db(), 'users[1].id')).toBe('u2');
    expect(getPath(db(), 'missing.deep')).toBeUndefined();
  });

  it('applies set, merge, push, inc, remove', () => {
    const d = db();
    applyPatch(d, {
      'account.status': 'frozen',
      'account.meta': { $merge: { reason: 'x' } },
      tags: { $push: 'b' },
      'users[id=u1].step': { $inc: 2 },
      'users[id=u2]': { $remove: true },
      'new.nested.key': 1,
    });
    expect(d.account).toEqual({ status: 'frozen', meta: { reason: 'x' } });
    expect(d.tags).toEqual(['a', 'b']);
    expect(d.users).toEqual([{ id: 'u1', step: 3 }]);
    expect((d as any).new.nested.key).toBe(1);
  });

  it('copies values so later writes do not leak into the patch', () => {
    const patch = { list: { $set: [{ a: 1 }] } };
    const d1: any = applyPatch({}, patch);
    d1.list[0].a = 99;
    const d2: any = applyPatch({}, patch);
    expect(d2.list[0].a).toBe(1);
  });

  it('names the failing path', () => {
    expect(() => applyPatch(db(), { 'users[id=nope].step': 1 })).toThrow(/users\[id=nope\]\.step/);
  });

  it('matches conditions', () => {
    expect(matches(db(), { path: 'account.status', equals: 'active' })).toBe(true);
    expect(matches(db(), { path: 'users[id=u3]', exists: false })).toBe(true);
    expect(matches(db(), { path: 'users[id=u1].step', in: [1, 5] })).toBe(true);
  });
});
