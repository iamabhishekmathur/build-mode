import { describe, expect, it } from 'vitest';
import { decodeShareState, encodeShareState, resolveScenario, scenarioSlug, validateScenario, type Scenario } from '@stagecraft/core';

describe('scenarios', () => {
  const all: Record<string, Scenario> = {
    'Bill pay company': { name: 'Bill pay company', persona: 'admin', states: { approvals: 'pending', agents: 'many' }, flags: { a: true }, db: { x: 1 } },
    'Bill pay company – frozen': { name: 'Bill pay company – frozen', extends: 'Bill pay company', states: { account: 'frozen' }, db: { y: 2 } },
  };

  it('resolves extends: child overrides, maps merge, db patches stack', () => {
    const r = resolveScenario('Bill pay company – frozen', all);
    expect(r.persona).toBe('admin');
    expect(r.states).toEqual({ approvals: 'pending', agents: 'many', account: 'frozen' });
    expect(r.flags).toEqual({ a: true });
    expect(r.dbPatches).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it('finds scenarios by slug and detects cycles', () => {
    expect(resolveScenario('bill-pay-company', all).name).toBe('Bill pay company');
    expect(() => resolveScenario('a', { a: { name: 'a', extends: 'b' }, b: { name: 'b', extends: 'a' } })).toThrow(/cycle/);
    expect(scenarioSlug('Bill pay company – frozen')).toBe('bill-pay-company-frozen');
  });

  it('validates shape', () => {
    expect(validateScenario({ name: 'ok', states: {} })).toEqual([]);
    expect(validateScenario({ name: '', states: [] }).map((i) => i.path)).toEqual(['$.name', '$.states']);
  });

  it('round-trips share state and omits defaults', () => {
    const defaults = { persona: 'admin', states: { account: 'active' } };
    const state = { persona: 'employee', states: { account: 'active' }, flags: { f: 'é' }, variants: { v: 'B' }, faults: [] };
    const enc = encodeShareState(state, defaults);
    expect(decodeShareState(enc)).toEqual({ p: 'employee', f: { f: 'é' }, v: { v: 'B' } });
    expect(encodeShareState({ ...state, persona: 'admin', flags: {}, variants: {} }, defaults)).toBe('');
    expect(decodeShareState('%%%')).toEqual({});
  });
});
