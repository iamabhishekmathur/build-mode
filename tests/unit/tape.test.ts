import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPosition, parsePosition, pathTo, tapeOutline, validateTape, type Tape } from '@stagecraft/core';
import { EXAMPLE } from '../helpers.ts';

const tape: Tape = JSON.parse(readFileSync(join(EXAMPLE, 'stagecraft/tapes/vendor-payment-approval.json'), 'utf8'));

describe('tape validation', () => {
  it('accepts the reference tapes', () => {
    expect(validateTape(tape)).toEqual([]);
  });

  it('rejects unknown event types with a clear error', () => {
    const bad = { ...tape, events: [{ type: 'sing', text: 'la' }] };
    const issues = validateTape(bad);
    expect(issues[0]!.path).toBe('$.events[0].type');
    expect(issues[0]!.message).toMatch(/Unknown event type "sing"\. Allowed: user_message/);
  });

  it('checks required fields, goto targets, tool ids and branch position', () => {
    const bad = {
      version: 1,
      id: 'x',
      title: 'x',
      events: [
        { type: 'tool_result', id: 'nope' },
        { type: 'delay' },
        { type: 'branch', cases: [{ when: { path: 'a' }, goto: 'missing' }] },
        { type: 'user_message', text: 'after branch' },
      ],
    };
    const msgs = validateTape(bad).map((i) => `${i.path} ${i.message}`);
    expect(msgs.some((m) => m.includes('no earlier tool_call'))).toBe(true);
    expect(msgs.some((m) => m.includes('delay needs "ms"'))).toBe(true);
    expect(msgs.some((m) => m.includes('goto "missing"'))).toBe(true);
    expect(msgs.some((m) => m.includes('branch must be the last event'))).toBe(true);
  });

  it('rejects bad versions and ids', () => {
    expect(validateTape({ version: 2, id: 'has space', title: 't', events: [] }).map((i) => i.path)).toEqual(['$.version', '$.id']);
  });
});

describe('tape positions', () => {
  it('parses and formats positions', () => {
    expect(parsePosition('4')).toEqual({ segment: 'main', index: 4 });
    expect(parsePosition('approved:2')).toEqual({ segment: 'approved', index: 2 });
    expect(formatPosition({ segment: 'approved', index: 2 })).toBe('approved:2');
    expect(() => parsePosition('x:y')).toThrow(/Bad tape position/);
  });

  it('walks into branches with the choice that leads there', () => {
    const p = pathTo(tape, parsePosition('approved:1'));
    expect(p.events).toHaveLength(tape.events.length + 1);
    expect(p.choices).toEqual([{ when: { path: 'payments[id=p9].status', equals: 'approved' }, goto: 'approved' }]);
    expect(() => pathTo(tape, parsePosition('99'))).toThrow(/past the end/);
  });

  it('outlines steps for the timeline', () => {
    const o = tapeOutline(tape);
    expect(o.map((s) => s.segment)).toEqual(['main', 'approved', 'rejected']);
    expect(o[0]!.steps[3]!.label).toBe('Payment service times out');
  });
});
