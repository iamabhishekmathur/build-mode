// Mock DB for Ledgerly. Fake data only.
export const seed = () => ({
  users: [
    { id: 'u1', name: 'Ada Okafor', email: 'ada@ledgerly.test', role: 'admin', onboardingStep: 4 },
    { id: 'u2', name: 'Eli Brandt', email: 'eli@ledgerly.test', role: 'employee', onboardingStep: 1 },
    { id: 'u3', name: 'Bo Lindqvist', email: 'bo@ledgerly.test', role: 'bookkeeper', onboardingStep: 4 },
  ],
  account: {
    id: 'acc1',
    name: 'Northwind Supplies Inc.',
    status: 'active' as 'active' | 'frozen' | 'over_limit' | 'under_review',
    balance: 184_250.12,
    monthlyLimit: 250_000,
    spentThisMonth: 96_400,
  },
  payments: [
    { id: 'p1', vendor: 'Globex Hosting', amount: 1290.0, status: 'paid', requestedBy: 'u2', date: '2026-11-02' },
    { id: 'p2', vendor: 'Initech Office', amount: 640.5, status: 'paid', requestedBy: 'u3', date: '2026-11-08' },
  ] as { id: string; vendor: string; amount: number; status: string; requestedBy: string; date: string }[],
  agents: [
    { id: 'ag1', name: 'Expense assistant', scope: 'Read transactions, draft payments', spendLimit: 5000, status: 'active' },
    { id: 'ag2', name: 'Payroll bot', scope: 'Run payroll on schedule', spendLimit: 120000, status: 'paused' },
  ] as { id: string; name: string; scope: string; spendLimit: number; status: string }[],
});

export type DB = ReturnType<typeof seed>;
