import { get, money, type Account, type Invoice, type Me } from '../lib/api';
import { PayButton } from './pay-button';

export const dynamic = 'force-dynamic';

const BANNER: Record<string, string | undefined> = {
  past_due: 'Your payment method failed. Update it to keep sending invoices.',
  suspended: 'This account is suspended. Invoices cannot be sent or paid.',
};

export default async function InvoicesPage() {
  const [account, invoices, me] = await Promise.all([get<Account>('/v1/account'), get<Invoice[]>('/v1/invoices'), get<Me>('/v1/me')]);
  const banner = BANNER[account.status];
  return (
    <>
      <h1 data-testid="account-name">{account.name}</h1>
      <p className="muted" data-testid="plan">
        {account.plan} plan · {account.seats} seats
      </p>
      {banner && (
        <div role="status" className={`banner banner--${account.status}`} data-testid="banner">
          {banner}
        </div>
      )}
      <h2>Invoices</h2>
      {invoices.length === 0 ? (
        <p data-testid="empty">No invoices yet. Create your first invoice to get paid.</p>
      ) : (
        <table className="table" data-testid="invoices">
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.customer}</td>
                <td>{inv.due}</td>
                <td className={`status status--${inv.status}`}>{inv.status}</td>
                <td className="num">{money(inv.amount)}</td>
                <td>{inv.status !== 'paid' && me.role === 'owner' && account.status !== 'suspended' ? <PayButton id={inv.id} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
