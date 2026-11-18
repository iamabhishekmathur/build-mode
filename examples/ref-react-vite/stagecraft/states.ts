import { defineStates } from '@stagecraft/core';

const manyAgents = Array.from({ length: 14 }, (_, i) => ({
  id: `agx${i + 1}`,
  name: `Agent ${i + 1} — ${['Invoices', 'Receipts', 'Vendor onboarding', 'Card controls'][i % 4]}`,
  scope: 'Read transactions',
  spendLimit: 1000 * (i + 1),
  status: i % 3 === 0 ? 'paused' : 'active',
}));

export const states = defineStates({
  account: {
    label: 'Account',
    default: 'active',
    states: {
      active: { label: 'Active', db: { 'account.status': 'active', 'account.spentThisMonth': 96400 } },
      frozen: { label: 'Frozen', description: 'Compliance froze the account', db: { 'account.status': 'frozen' } },
      over_limit: { label: 'Over limit', db: { 'account.status': 'over_limit', 'account.spentThisMonth': 262_900 } },
      under_review: { label: 'Under review', db: { 'account.status': 'under_review' } },
    },
  },
  approvals: {
    label: 'Approvals',
    default: 'none',
    states: {
      none: { label: 'None pending', db: {} },
      pending: {
        label: 'Two pending',
        db: {
          payments: {
            $set: [
              { id: 'p1', vendor: 'Globex Hosting', amount: 1290.0, status: 'paid', requestedBy: 'u2', date: '2026-11-02' },
              { id: 'p3', vendor: 'Umbrella Logistics', amount: 12850, status: 'pending_approval', requestedBy: 'u2', date: '2026-11-15' },
              { id: 'p4', vendor: 'Soylent Catering', amount: 2380, status: 'pending_approval', requestedBy: 'u3', date: '2026-11-16' },
            ],
          },
        },
      },
    },
  },
  agents: {
    label: 'Agents',
    default: 'some',
    states: {
      none: { label: 'None connected', db: { agents: { $set: [] } } },
      some: { label: 'Two connected', db: {} },
      many: { label: '14 connected', db: { agents: { $set: manyAgents } } },
    },
  },
});
