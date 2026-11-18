import type { FaultRule, Json, SessionState } from './types.ts';

/** Compact, linkable form of the panel state (the `__sc` URL param). */
export interface ShareState {
  p?: string;
  s?: Record<string, string>;
  f?: Record<string, Json>;
  v?: Record<string, string>;
  x?: FaultRule[];
  t?: 'light' | 'dark';
  /** clock */
  c?: string;
}

function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeShareState(state: SessionState, defaults: { persona: string; states: Record<string, string> }): string {
  const out: ShareState = {};
  if (state.persona !== defaults.persona) out.p = state.persona;
  const s: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.states)) if (defaults.states[k] !== v) s[k] = v;
  if (Object.keys(s).length) out.s = s;
  if (Object.keys(state.flags).length) out.f = state.flags;
  if (Object.keys(state.variants).length) out.v = state.variants;
  if (state.faults.length) out.x = state.faults;
  if (state.theme) out.t = state.theme;
  if (state.clock) out.c = state.clock;
  return Object.keys(out).length ? b64urlEncode(JSON.stringify(out)) : '';
}

export function decodeShareState(param: string): ShareState {
  try {
    const v = JSON.parse(b64urlDecode(param));
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}
