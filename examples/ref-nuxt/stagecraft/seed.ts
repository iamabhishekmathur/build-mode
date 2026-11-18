// Mock DB for Orbit Support. Fake data only.
export const seed = () => ({
  users: [
    { id: 'u1', name: 'Ines Admin', role: 'admin' as const },
    { id: 'u2', name: 'Theo Agent', role: 'agent' as const },
  ],
  account: { name: 'Lumen Outdoor Gear', plan: 'Scale', status: 'active' as 'active' | 'past_due' | 'suspended', seats: 15 },
  tickets: [
    { id: 't1', subject: 'Tent zipper broke on day one', customer: 'Rhea Park', priority: 'normal', status: 'open' },
    { id: 't2', subject: 'Where is my order #4417?', customer: 'Sam Ito', priority: 'low', status: 'closed' },
  ] as { id: string; subject: string; customer: string; priority: 'low' | 'normal' | 'urgent'; status: 'open' | 'closed' }[],
});
export type DB = ReturnType<typeof seed>;
