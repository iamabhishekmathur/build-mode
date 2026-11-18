import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card, StatusBadge } from '@acme/ui';

const API = 'https://api.acme.example';
type Account = { name: string; status: string };

function Admin() {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => fetch(`${API}/v1/account`).then((r) => r.json()).then(setAccount);
  useEffect(() => void load(), []);
  const unfreeze = async () => {
    const r = await fetch(`${API}/v1/account/unfreeze`, { method: 'POST' });
    if (!r.ok) setError((await r.json()).error);
    else load();
  };
  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>Acme Admin</h1>
      <Card title="Customer account">
        <p data-testid="admin-account">
          {account ? account.name : '…'} {account && <StatusBadge status={account.status} />}
        </p>
        {account?.status === 'frozen' && <Button onClick={unfreeze}>Unfreeze account</Button>}
        {error && <p role="alert">{error}</p>}
      </Card>
      <a href="/">Back to dashboard</a>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Admin />);
