import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine, UserError, type TapeClient, type WireEvent } from '@stagecraft/server';
import { fixture, until } from '../helpers.ts';

let engine: Engine;
let root: string;
beforeEach(async () => {
  const fx = fixture('engine');
  root = fx.root;
  engine = await new Engine(fx.config, { log: () => {}, tapeSpeed: 0.02 }).init();
});

const db = (id = 'main') => engine.getSession(id).dbRef.db as any;

describe('state system', () => {
  it('starts with default persona, states and flags', () => {
    const s = engine.getSession();
    expect(s.state.persona).toBe('admin');
    expect(s.state.states).toEqual({ account: 'active', approvals: 'none', agents: 'some' });
    expect(engine.effectiveFlags(s)).toEqual({ 'new-nav': false, 'limit-display': 'bar' });
  });

  it('applies a state DB patch and rejects unknown names', () => {
    const s = engine.getSession();
    engine.patch(s, { states: { account: 'frozen' } });
    expect(db().account.status).toBe('frozen');
    expect(() => engine.patch(s, { states: { account: 'melted' } })).toThrow(UserError);
    expect(() => engine.patch(s, { persona: 'ceo' })).toThrow(/Unknown persona/);
    expect(() => engine.patch(s, { flags: { 'limit-display': 'pie' } })).toThrow(/must be one of/);
  });

  it('FR-503: persona switches keep mock DB writes', () => {
    const s = engine.getSession();
    engine.patch(s, { persona: 'employee' });
    db().users.find((u: any) => u.id === 'u2').onboardingStep = 2; // a write by the app
    engine.patch(s, { persona: 'admin' });
    engine.patch(s, { persona: 'employee' });
    expect(db().users.find((u: any) => u.id === 'u2').onboardingStep).toBe(2);
  });

  it('re-selecting the current state is a no-op (reloads keep writes)', () => {
    const s = engine.getSession();
    db().account.balance = 1;
    const v = s.dataVersion;
    engine.patch(s, { states: { account: 'active' } });
    expect(db().account.balance).toBe(1);
    expect(s.dataVersion).toBe(v);
  });

  it('forks copy state and DB; writes do not cross (FR-504)', () => {
    engine.patch(engine.getSession(), { states: { account: 'frozen' } });
    const f = engine.fork('main');
    expect(f.state.states.account).toBe('frozen');
    (f.dbRef.db as any).account.balance = 7;
    expect(db().account.balance).not.toBe(7);
  });

  it('state flags override defaults; overrides win', () => {
    const s = engine.getSession();
    engine.patch(s, { flags: { 'new-nav': true } });
    expect(engine.effectiveFlags(s)['new-nav']).toBe(true);
    engine.patch(s, { flags: { 'new-nav': null } });
    expect(engine.effectiveFlags(s)['new-nav']).toBe(false);
  });

  it('resets the DB to seed + selected states', () => {
    const s = engine.getSession();
    engine.patch(s, { states: { agents: 'none' } });
    db().account.balance = 0;
    engine.resetDb(s);
    expect(db().agents).toEqual([]);
    expect(db().account.balance).toBe(184250.12);
  });
});

describe('scenarios', () => {
  it('loads scenarios with extends', () => {
    const s = engine.getSession();
    const out = engine.loadScenario(s, 'Bill pay company – frozen');
    expect(out.url).toBe('/');
    expect(s.state.states).toMatchObject({ account: 'frozen', agents: 'many', approvals: 'pending' });
    expect(db().agents).toHaveLength(14);
    expect(s.state.scenario).toBe('Bill pay company – frozen');
  });

  it('FR-601/602: saves a scenario file with a DB snapshot and reproduces it', () => {
    const s = engine.getSession();
    engine.patch(s, { persona: 'employee', states: { account: 'under_review' }, variants: { layout: 'cards' } });
    db().account.balance = 42;
    const { file } = engine.saveScenario(s, { name: 'Review employee', url: '/payments' });
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ name: 'Review employee', persona: 'employee', states: { account: 'under_review' }, variants: { layout: 'cards' }, url: '/payments' });
    expect(saved.dbSnapshot.account.balance).toBe(42);
    const t = engine.fork('main');
    engine.resetDb(t);
    engine.loadScenario(t, 'review-employee');
    expect((t.dbRef.db as any).account.balance).toBe(42);
    expect(t.state.persona).toBe('employee');
  });

  it('reports stale scenarios clearly', () => {
    engine.scenarios['Old'] = { name: 'Old', states: { account: 'deleted_state' } };
    expect(() => engine.loadScenario(engine.getSession(), 'Old')).toThrow(/unknown state account=deleted_state/);
  });
});

function collector() {
  const events: WireEvent[] = [];
  let closed = false;
  const client: TapeClient = { send: (e) => events.push(e), close: () => (closed = true) };
  return { client, events, isClosed: () => closed, types: () => events.map((e) => e.type) };
}

describe('tape player', () => {
  it('plays, times out, resumes on retry, waits at the branch and follows the viewer action', async () => {
    const s = engine.getSession();
    engine.loadTape(s, 'vendor-payment-approval');
    const a = collector();
    s.player!.attach(a.client);
    await until(() => a.isClosed(), 3000);
    expect(a.types()).toContain('timeout');
    expect(s.player!.status().waiting).toBe('retry');
    // Retry = reconnect.
    const b = collector();
    s.player!.attach(b.client);
    await until(() => s.player!.status().waiting === 'branch', 3000);
    expect(b.events[0]!.type).toBe('hello');
    expect(b.events.find((e) => e.type === 'timeout')!.replay).toBe(true);
    expect(db().payments.find((p: any) => p.id === 'p9').status).toBe('pending_approval');
    // The viewer approves in the real UI → mock handler writes the DB.
    db().payments.find((p: any) => p.id === 'p9').status = 'approved';
    engine.dbChanged(s);
    await until(() => s.player!.status().done, 3000);
    expect(s.player!.status().segment).toBe('approved');
    const text = b.events.filter((e) => e.type === 'token').map((e) => e.text).join('');
    expect(text).toContain('Approved and scheduled');
  });

  it('FR-704: a deep link equals playback (same history, same DB)', async () => {
    const live = engine.getSession('live');
    engine.loadTape(live, 'vendor-payment-approval');
    const a = collector();
    live.player!.attach(a.client);
    await until(() => live.player!.status().waiting === 'retry', 3000);
    const b = collector();
    live.player!.attach(b.client);
    await until(() => live.player!.status().waiting === 'branch', 3000);

    const deep = engine.getSession('deep');
    engine.loadTape(deep, 'vendor-payment-approval', '9');
    const c = collector();
    deep.player!.attach(c.client);
    const norm = (evs: WireEvent[]) => {
      const out = evs.filter((e) => e.type !== 'hello').map(({ replay: _r, ...e }) => e);
      // Collapse streamed tokens into one per message for comparison.
      const merged: any[] = [];
      for (const e of out) {
        const last = merged[merged.length - 1];
        if (e.type === 'token' && last?.type === 'token' && last.id === e.id) last.text += e.text;
        else merged.push({ ...e });
      }
      return merged;
    };
    expect(norm(c.events)).toEqual(norm(b.events));
    expect(deep.dbRef.db).toEqual(live.dbRef.db);
    expect(deep.player!.status().waiting).toBe('branch');
  });

  it('deep link into a branch applies the choice', () => {
    const s = engine.getSession();
    engine.loadTape(s, 'vendor-payment-approval', 'rejected:1');
    expect(db().payments.find((p: any) => p.id === 'p9').status).toBe('rejected');
    expect(s.player!.status()).toMatchObject({ segment: 'rejected', index: 1, done: false });
  });

  it('steps one event at a time and supports partial streams + errors', async () => {
    const s = engine.getSession();
    engine.loadTape(s, 'assistant-stream-error', '0', false);
    const a = collector();
    s.player!.attach(a.client);
    await s.player!.stepOnce();
    await s.player!.stepOnce();
    expect(a.types()).toEqual(['hello', 'user_message', 'message_start', 'token', 'message_end']);
    expect(a.events[4]!.partial).toBe(true);
    expect((a.events[3]!.text as string).length).toBe(70);
    await s.player!.stepOnce();
    expect(a.events[5]).toMatchObject({ type: 'error', code: 'upstream_unavailable' });
  });

  it('rejects unknown tapes and bad positions', () => {
    const s = engine.getSession();
    expect(() => engine.loadTape(s, 'nope')).toThrow(/Unknown tape/);
    expect(() => engine.loadTape(s, 'vendor-payment-approval', 'ghost:1')).toThrow(/Branch "ghost" is not reachable/);
  });

  it('saves valid tapes and refuses invalid ones', () => {
    const { file } = engine.saveTape({ version: 1, id: 'tiny', title: 'Tiny', events: [{ type: 'user_message', text: 'hi' }] });
    expect(file).toBe(join(root, 'stagecraft/tapes/tiny.json'));
    expect(() => engine.saveTape({ version: 1, id: 'bad', title: 'Bad', events: [{ type: 'nope' }] })).toThrow(/Unknown event type/);
  });
});

describe('PII scrubbing on save (NFR-103)', () => {
  it('scrubs tapes and scenario snapshots before they reach the repo', () => {
    const t = engine.saveTape({ version: 1, id: 'pii', title: 'PII', events: [{ type: 'user_message', text: 'Refund maria@gmail.com to card 4111 1111 1111 1111' }] });
    expect(t.piiRemoved).toEqual(['email at $.events[0].text', 'card at $.events[0].text']);
    expect(readFileSync(t.file, 'utf8')).not.toMatch(/maria@gmail|4111 1111/);
    const s = engine.getSession();
    (s.dbRef.db as any).users[0].email = 'real.person@gmail.com';
    const sc = engine.saveScenario(s, { name: 'With PII' });
    expect(sc.piiRemoved).toEqual(['email at $.users[0].email']);
    expect(readFileSync(sc.file, 'utf8')).not.toContain('real.person@gmail.com');
    expect(readFileSync(sc.file, 'utf8')).toContain('ledgerly.test'); // fake test-domain data stays
  });
});
