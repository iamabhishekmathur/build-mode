import type { ReactNode } from 'react';
import Link from 'next/link';
import { Providers } from './providers';
import { get, type Me } from '../lib/api';
import './globals.css';

export const metadata = { title: 'Acme Billing' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await get<Me>('/v1/me');
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <strong>Acme Billing</strong>
          <Link href="/">Invoices</Link>
          <Link href="/settings">Settings</Link>
          <span className="spacer" />
          <span data-testid="me">
            {me.name} · {me.role}
          </span>
        </nav>
        <main className="main">
          <Providers>{children}</Providers>
        </main>
      </body>
    </html>
  );
}
