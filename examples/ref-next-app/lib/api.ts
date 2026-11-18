// The billing API lives on another host. In production this is a real service.
export const API = 'https://api.acme-billing.example';

export interface Account { name: string; plan: string; status: 'active' | 'past_due' | 'suspended'; seats: number }
export interface Invoice { id: string; customer: string; amount: number; status: 'open' | 'paid' | 'overdue'; due: string }
export interface Me { id: string; name: string; role: 'owner' | 'viewer' }

/** Server-side data access. Runs in React Server Components. */
export async function get<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
