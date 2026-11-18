export const seed = () => ({
  users: [
    { id: 'u1', name: 'Cora Customer', role: 'owner' },
    { id: 'u2', name: 'Sam Support', role: 'support' },
  ],
  account: { name: 'Larkspur Coffee', status: 'active' },
  payments: [
    { id: 'p1', vendor: 'Bean Brokers', amount: 820 },
    { id: 'p2', vendor: 'Mill & Co', amount: 145 },
  ],
});
export type DB = ReturnType<typeof seed>;
