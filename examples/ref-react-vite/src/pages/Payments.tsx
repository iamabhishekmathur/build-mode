import { useState } from 'react';
import { money, send, useApi, type Payment, type User } from '../api';

export function Payments({ me }: { me: User | null }) {
  const { data, error, loading } = useApi<Payment[]>('/api/payments');
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (id: string, verb: 'approve' | 'reject') => {
    setActionError(null);
    try {
      await send('POST', `/api/payments/${id}/${verb}`);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  if (error) return <p className="error" data-testid="payments-error">Payments are unavailable: {error}</p>;
  if (loading && !data) return <p className="muted">Loading payments…</p>;
  const pending = data?.filter((p) => p.status === 'pending_approval') ?? [];
  return (
    <>
      <h1>Payments</h1>
      {actionError && <p className="error">{actionError}</p>}
      {pending.length > 0 && (
        <section className="card" data-testid="approvals">
          <h2>Waiting for approval ({pending.length})</h2>
          <ul className="list">
            {pending.map((p) => (
              <li key={p.id}>
                <span>{p.vendor}</span>
                <span className="num">{money(p.amount)}</span>
                {me?.role === 'admin' ? (
                  <span className="actions">
                    <button className="btn" onClick={() => act(p.id, 'approve')}>Approve</button>
                    <button className="btn btn--ghost" onClick={() => act(p.id, 'reject')}>Reject</button>
                  </span>
                ) : (
                  <span className="muted">Waiting for an admin</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <h2>All payments</h2>
        <ul className="list" data-testid="payments">
          {data?.map((p) => (
            <li key={p.id}>
              <span>{p.vendor}</span>
              <span className="muted">{p.date}</span>
              <span className={`pill pill--${p.status}`}>{p.status.replace('_', ' ')}</span>
              <span className="num">{money(p.amount)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
