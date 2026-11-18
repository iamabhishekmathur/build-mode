import { useFlag } from '@stagecraft/react';
import { money, useApi, type Account, type Payment } from '../api';

export function Dashboard() {
  const account = useApi<Account>('/api/account');
  const payments = useApi<Payment[]>('/api/payments');
  const limitDisplay = useFlag('limit-display', 'bar');
  if (account.error) return <p className="error">Could not load your account: {account.error}</p>;
  const a = account.data;
  if (!a) return <p className="muted">Loading…</p>;
  const pct = Math.min(100, Math.round((a.spentThisMonth / a.monthlyLimit) * 100));
  return (
    <>
      <h1>{a.name}</h1>
      <div className="grid">
        <section className="card">
          <h2>Balance</h2>
          <p className="big" data-testid="balance">{money(a.balance)}</p>
        </section>
        <section className="card">
          <h2>Monthly limit</h2>
          {limitDisplay === 'bar' ? (
            <div className="meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly limit used">
              <div className={`meter__fill ${pct >= 100 ? 'meter__fill--over' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <p data-testid="limit">
            {money(a.spentThisMonth)} of {money(a.monthlyLimit)} ({pct}%)
          </p>
        </section>
      </div>
      <section className="card">
        <h2>Recent payments</h2>
        {payments.data?.length ? (
          <ul className="list">
            {payments.data.slice(0, 5).map((p) => (
              <li key={p.id}>
                <span>{p.vendor}</span>
                <span className={`pill pill--${p.status}`}>{p.status.replace('_', ' ')}</span>
                <span className="num">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No payments yet.</p>
        )}
      </section>
    </>
  );
}
