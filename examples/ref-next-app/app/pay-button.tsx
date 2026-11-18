'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API } from '../lib/api';

/** A client-side write: the browser calls the API directly, then refreshes server components. */
export function PayButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`${API}/v1/invoices/${id}/pay`, { method: 'POST' });
        router.refresh();
        setBusy(false);
      }}
    >
      Mark paid
    </button>
  );
}
