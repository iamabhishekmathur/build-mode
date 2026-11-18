import type { CSSProperties, ReactNode } from 'react';

/** Design tokens. Apps use these, not raw values. */
export const tokens = {
  color: { text: '#1c1c1e', muted: '#6a6a6f', line: '#e3e3e0', surface: '#ffffff', brand: '#4338ca', ok: '#166534', okBg: '#dcfce7', bad: '#991b1b', badBg: '#fee2e2', warn: '#854d0e', warnBg: '#fef9c3' },
  space: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  radius: 10,
} as const;

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={{ background: tokens.color.surface, border: `1px solid ${tokens.color.line}`, borderRadius: tokens.radius, padding: tokens.space[4], marginBottom: tokens.space[4] }}>
      {title && <h2 style={{ fontSize: 14, color: tokens.color.muted, margin: `0 0 ${tokens.space[2]}px` }}>{title}</h2>}
      {children}
    </section>
  );
}

export function Button({ children, onClick, variant = 'primary', disabled }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary'; disabled?: boolean }) {
  const style: CSSProperties =
    variant === 'primary'
      ? { background: tokens.color.brand, color: '#fff', border: `1px solid ${tokens.color.brand}` }
      : { background: 'transparent', color: tokens.color.text, border: `1px solid ${tokens.color.line}` };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...style, font: 'inherit', padding: `${tokens.space[1] + 2}px ${tokens.space[3]}px`, borderRadius: 8, cursor: 'pointer', opacity: disabled ? 0.6 : 1 }}>
      {children}
    </button>
  );
}

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  active: { label: 'Active', fg: tokens.color.ok, bg: tokens.color.okBg },
  frozen: { label: 'Frozen', fg: tokens.color.bad, bg: tokens.color.badBg },
  review: { label: 'In review', fg: tokens.color.warn, bg: tokens.color.warnBg },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, fg: tokens.color.muted, bg: tokens.color.line };
  return (
    <span data-ui="status-badge" style={{ color: s.fg, background: s.bg, borderRadius: 99, padding: `2px ${tokens.space[2]}px`, fontSize: 12, fontWeight: 600 }}>
      {s.label}
    </span>
  );
}
