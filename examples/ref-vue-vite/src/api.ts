import { onMounted, ref, watch } from 'vue';
import { useMockDbVersion } from '@stagecraft/vue';

/** Projects live on a separate API host in this app, to show cross-origin mocking. */
export const PROJECTS_API = 'https://api.fieldnote.example';

export interface User { id: string; name: string; email: string; role: 'owner' | 'member'; statusMessage: string }
export interface Workspace { id: string; name: string; plan: string; status: 'active' | 'trial_expired' | 'read_only'; seats: number }
export interface Project { id: string; name: string; lead: string; health: string; due: string }

export async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `Request failed (${r.status})`);
  return data as T;
}

/** Fetch on mount, and again when the mock DB changes (another tab, a tape, an agent). */
export function useApi<T>(url: string) {
  const data = ref<T | null>(null);
  const error = ref<string | null>(null);
  const load = async () => {
    try {
      data.value = await send<T>('GET', url);
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    }
  };
  onMounted(load);
  watch(useMockDbVersion(), load);
  return { data, error, reload: load };
}
