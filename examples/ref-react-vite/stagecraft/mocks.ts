import { defineHandlers } from '@stagecraft/core';
import type { DB } from './seed';

const me = (db: DB, userId?: string) => db.users.find((u) => u.id === userId)!;

export const handlers = defineHandlers<DB>({
  'GET /api/me': ({ db, persona }) => me(db, persona.userId),
  'GET /api/account': ({ db }) => db.account,
  'GET /api/payments': ({ db }) => [...db.payments].reverse(),
  'POST /api/payments/:id/approve': ({ db, params, persona, reply }) => {
    if (persona.role !== 'admin') return reply(403, { error: 'Only admins can approve payments' });
    const p = db.payments.find((x) => x.id === params.id);
    if (!p) return reply(404, { error: 'No such payment' });
    p.status = 'approved';
    return p;
  },
  'POST /api/payments/:id/reject': ({ db, params, persona, reply }) => {
    if (persona.role !== 'admin') return reply(403, { error: 'Only admins can reject payments' });
    const p = db.payments.find((x) => x.id === params.id);
    if (!p) return reply(404, { error: 'No such payment' });
    p.status = 'rejected';
    return p;
  },
  'POST /api/onboarding/complete-step': ({ db, persona }) => {
    const u = me(db, persona.userId);
    u.onboardingStep = Math.min(4, u.onboardingStep + 1);
    return { onboardingStep: u.onboardingStep };
  },
  'GET /api/agents': ({ db }) => db.agents,
  'PATCH /api/agents/:id': ({ db, params, body, reply }) => {
    const a = db.agents.find((x) => x.id === params.id);
    if (!a) return reply(404, { error: 'No such agent' });
    Object.assign(a, body);
    return a;
  },
});
