import { createContext, Fragment, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StagecraftRuntime } from '@stagecraft/runtime';

/**
 * React adapter for Stagecraft.
 *
 * Every export is a no-op when `window.__STAGECRAFT__` is absent (production, tests),
 * so product code that uses `<Variant>` or `useFlag` ships safely. Mock code never
 * lives here: it lives in `stagecraft/` and is loaded by the dev proxy only.
 */

function runtime(): StagecraftRuntime | undefined {
  return typeof window === 'undefined' ? undefined : window.__STAGECRAFT__;
}

let version = 0;
function subscribe(fn: () => void) {
  const rt = runtime();
  if (!rt) return () => {};
  const offs = [
    rt.on('ui', () => {
      version++;
      fn();
    }),
    rt.on('data', () => {
      version++;
      fn();
    }),
  ];
  return () => offs.forEach((o) => o());
}
const snapshot = () => version;

/** Re-render when flags, variants or other UI state change. */
function useRuntimeVersion() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const DataVersion = createContext(0);

/**
 * Wrap the app (inside your router). On persona, state or scenario changes it remounts
 * its children so data refetches. Without it, Stagecraft falls back to a full page reload.
 */
export function StagecraftRoot({ children }: { children: ReactNode }) {
  const rt = runtime();
  const [dataVersion, setDataVersion] = useState(() => rt?.info.dataVersion ?? 0);
  useEffect(() => {
    if (!rt) return;
    rt.registerAdapter('react');
    return rt.on('data', (info) => setDataVersion(info.dataVersion));
  }, [rt]);
  return (
    <DataVersion.Provider value={dataVersion}>
      <Fragment key={dataVersion}>{children}</Fragment>
    </DataVersion.Provider>
  );
}

/** Value of a feature flag. Returns `fallback` outside Stagecraft. */
export function useFlag<T>(key: string, fallback: T): T {
  useRuntimeVersion();
  const rt = runtime();
  return rt ? (rt.flag(key, fallback as any) as T) : fallback;
}

/** Selected option of a variant. Outside Stagecraft this is `fallback` or the first option. */
export function useVariant<const O extends string>(name: string, options: readonly O[], fallback?: O): O {
  useRuntimeVersion();
  const rt = runtime();
  const opts = useMemo(() => [...options], [options.join('|')]);
  return (rt ? rt.variant(name, opts, fallback) : (fallback ?? options[0])) as O;
}

/**
 * Render one of several design options. Removed at handoff: keep the winner, delete the wrapper.
 *
 * <Variant name="agent-list" options={{ table: <Table/>, cards: <Cards/> }} />
 */
export function Variant<const O extends Record<string, ReactNode>>({ name, options, fallback }: { name: string; options: O; fallback?: keyof O & string }) {
  const keys = Object.keys(options) as (keyof O & string)[];
  const pick = useVariant(name, keys, fallback);
  return <>{options[pick]}</>;
}

/**
 * Bumps when the mock DB changes (a tape step, another tab, an agent seed).
 * Add it to your data hooks' dependencies to refetch without a remount.
 */
export function useMockDbVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => runtime()?.on('db', () => setV((x) => x + 1)), []);
  return v;
}

/** Current persona id, or undefined outside Stagecraft. */
export function usePersona(): string | undefined {
  useRuntimeVersion();
  return runtime()?.info.state.persona;
}

export const isStagecraft = () => !!runtime();
