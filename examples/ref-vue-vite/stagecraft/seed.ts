// Mock DB for Fieldnote. Fake data only.
export const seed = () => ({
  users: [
    { id: 'u1', name: 'Olivia Ortiz', email: 'olivia@fieldnote.test', role: 'owner', statusMessage: '' },
    { id: 'u2', name: 'Milo Meyer', email: 'milo@fieldnote.test', role: 'member', statusMessage: '' },
  ],
  workspace: {
    id: 'w1',
    name: 'Harbor Design Co.',
    plan: 'Team',
    status: 'active' as 'active' | 'trial_expired' | 'read_only',
    seats: 8,
  },
  projects: [
    { id: 'pr1', name: 'Website refresh', lead: 'Olivia Ortiz', health: 'on_track', due: '2026-12-04' },
    { id: 'pr2', name: 'Brand guidelines', lead: 'Milo Meyer', health: 'at_risk', due: '2026-11-28' },
  ] as { id: string; name: string; lead: string; health: string; due: string }[],
});

export type DB = ReturnType<typeof seed>;
