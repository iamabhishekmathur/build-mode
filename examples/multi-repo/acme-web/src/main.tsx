import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StagecraftRoot, useMockDbVersion } from '@stagecraft/react';
import { Card, StatusBadge } from '@acme/ui';

const API = 'https://api.acme.example';
type Account = { name: string; status: string };
type Payment = { id: string; vendor: string; amount: number };
type Me = { name: string; role: string };

function useGet<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const v = useMockDbVersion();
  useEffect(() => {
    fetch(API + path).then((r) => r.json()).then(setData);
  }, [path, v]);
  return data;
}

function Dashboard() {
  const me = useGet<Me>('/v1/me');
  const account = useGet<Account>('/v1/account');
  const payments = useGet<Payment[]>('/v1/payments');
  return (
    <main style={{ padding: 24, maxWidth: 880 }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <h1 style={{ margin: 0, flex: 1 }} data-testid="account">
          {account?.name ?? '…'} {account && <StatusBadge status={account.status} />}
        </h1>
        <span data-testid="me">{me ? `${me.name} · ${me.role}` : '…'}</span>
        {me?.role === 'support' && <a href="/admin/">Open admin</a>}
      </header>
      <Card title="Payments">
        <ul data-testid="payments">
          {payments?.map((p) => (
            <li key={p.id}>
              {p.vendor}: ${p.amount}
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StagecraftRoot>
    <Dashboard />
  </StagecraftRoot>,
);
