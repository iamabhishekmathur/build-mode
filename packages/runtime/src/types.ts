import type { Json, SessionState } from '@stagecraft/core';

export interface SessionInfo {
  id: string;
  state: SessionState;
  flags: Record<string, Json>;
  dataVersion: number;
  uiVersion: number;
  tape: TapeStatus | null;
}

export interface TapeStatus {
  id: string;
  title: string;
  at: string;
  segment: string;
  index: number;
  total: number;
  playing: boolean;
  waiting: null | 'branch' | 'retry';
  done: boolean;
}

export type RuntimeEvent = 'data' | 'ui' | 'db' | 'tape' | 'navigate' | 'catalog';

/** The API at `window.__STAGECRAFT__`. Adapters and the panel use it. */
export interface StagecraftRuntime {
  readonly sessionId: string;
  readonly info: SessionInfo;
  readonly catalog: any;
  flag<T extends Json>(key: string, fallback: T): T;
  /** Selected option of a variant. Registers the variant with the panel. */
  variant(name: string, options: string[], fallback?: string): string;
  set(patch: Record<string, unknown>): Promise<SessionInfo>;
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  navigate(url: string): void;
  on(event: RuntimeEvent, fn: (detail: any) => void): () => void;
  /** Adapters call this so state changes re-render instead of reloading the page. */
  registerAdapter(name: string): void;
}

declare global {
  interface Window {
    __STAGECRAFT__?: StagecraftRuntime;
    __STAGECRAFT_BOOT__?: any;
  }
}
