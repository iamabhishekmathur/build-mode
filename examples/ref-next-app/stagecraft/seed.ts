export const seed = () => ({
  users: [
    { id: 'u1', name: 'Olu Owner', role: 'owner' as const },
    { id: 'u2', name: 'Vic Viewer', role: 'viewer' as const },
  ],
  account: { name: 'Fernwood Studio', plan: 'Growth', status: 'active' as 'active' | 'past_due' | 'suspended', seats: 12 },
  invoices: [
    { id: 'in1', customer: 'Brightline Labs', amount: 4800, status: 'open', due: '2026-12-01' },
    { id: 'in2', customer: 'Kestrel Foods', amount: 1250, status: 'paid', due: '2026-11-01' },
  ] as { id: string; customer: string; amount: number; status: 'open' | 'paid' | 'overdue'; due: string }[],
});
export type DB = ReturnType<typeof seed>;
