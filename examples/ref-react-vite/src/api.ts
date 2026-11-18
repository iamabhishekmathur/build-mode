import { useCallback, useEffect, useState } from 'react';
import { useMockDbVersion } from '@stagecraft/react';

/** Agents live on a separate API host in this app, to show cross-origin mocking. */
export const AGENTS_API = 'https://api.ledgerly.example';

export interface User { id: string; name: string; email: string; role: string; onboardingStep: number }
export interface Account { id: string; name: string; status: 'active' | 'frozen' | 'over_limit' | 'under_review'; balance: number; monthlyLimit: number; spentThisMonth: number }
export interface Payment { id: string; vendor: string; amount: number; status: string; requestedBy: string; date: string }
export interface Agent { id: string; name: string; scope: string; spendLimit: number; status: string }

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dbVersion = useMockDbVersion();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(url)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        return body as T;
      })
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [url, dbVersion, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `Request failed (${r.status})`);
  return data as T;
}

export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
