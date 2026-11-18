import type { Json } from '@stagecraft/core';
import type { StagecraftRuntime } from '@stagecraft/runtime';

/** The injected Stagecraft runtime, or undefined (production, tests, server). */
export function stagecraftRuntime(): StagecraftRuntime | undefined {
  return typeof window === 'undefined' ? undefined : window.__STAGECRAFT__;
}

/** True when the page runs behind the Stagecraft dev proxy. */
export const isStagecraft = () => !!stagecraftRuntime();

/** Keys whose value differs between two flag maps. */
export function changedKeys(prev: Record<string, Json>, next: Record<string, Json>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

/**
 * Call `fn` with the keys of the flags that changed, whenever the panel, an agent (MCP) or a
 * state/persona switch changes this session's effective flags. No-op outside Stagecraft.
 * Returns an unsubscribe function.
 */
export function onStagecraftFlags(fn: (changed: string[], flags: Record<string, Json>) => void): () => void {
  const rt = stagecraftRuntime();
  if (!rt) return () => {};
  let last: Record<string, Json> = { ...rt.info.flags };
  const check = () => {
    const next = { ...rt.info.flags };
    const changed = changedKeys(last, next);
    last = next;
    if (changed.length) fn(changed, next);
  };
  const offs = [rt.on('ui', check), rt.on('data', check)];
  return () => offs.forEach((o) => o());
}
