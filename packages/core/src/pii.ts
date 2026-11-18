import type { Json } from './types.ts';

/**
 * PII scrubber (NFR-103) for recorded traffic, tapes, scenarios and feedback text.
 * Finds emails, phone numbers, payment card numbers (Luhn), US SSNs, IBANs (mod 97),
 * US bank routing numbers (ABA checksum) and account numbers next to a bank word,
 * Canadian SINs (Luhn) and UK National Insurance numbers. Replaces them with
 * clearly fake values of the same kind. Test/example addresses are left alone.
 */
export type PiiKind = 'email' | 'phone' | 'card' | 'ssn' | 'iban' | 'routing' | 'bank_account' | 'sin' | 'nino';

export interface PiiFinding {
  kind: PiiKind;
  path: string;
  /** Masked sample, never the full value. */
  sample: string;
}

const SAFE_EMAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:test|example|invalid|localhost))$/i;

function luhn(digits: string) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string) {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function abaOk(d: string) {
  if (!/^\d{9}$/.test(d)) return false;
  const n = d.split('').map(Number);
  return (3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!)) % 10 === 0;
}

const mask = (v: string) => (v.length <= 4 ? '****' : `${'*'.repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`);

interface Rule {
  kind: PiiKind;
  re: RegExp;
  ok?: (m: string, full: string, index: number) => boolean;
  fake: (m: string) => string;
}

const BANK_WORDS = /(account|acct|a\/c|routing|aba|bank|iban|sort code|kontonummer)[^\n]{0,24}$/i;

const RULES: Rule[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ok: (m) => !SAFE_EMAIL.test(m), fake: () => 'person@example.test' },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, ok: (m) => ibanOk(m), fake: () => 'GB00TEST00000000000000' },
  {
    kind: 'card',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    ok: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d) && /^[2-6]/.test(d);
    },
    fake: (m) => (m.replace(/\D/g, '').startsWith('3') ? '3782 822463 10005' : '4242 4242 4242 4242'),
  },
  { kind: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, fake: () => '000-00-0000' },
  {
    kind: 'sin',
    re: /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g,
    ok: (m, full, i) => luhn(m.replace(/\D/g, '')) && !/^0/.test(m) && /\b(sin|social insurance)\b/i.test(full.slice(Math.max(0, i - 40), i)),
    fake: () => '000 000 000',
  },
  { kind: 'nino', re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g, fake: () => 'QQ 12 34 56 C' },
  { kind: 'routing', re: /\b\d{9}\b/g, ok: (m, full, i) => abaOk(m) && BANK_WORDS.test(full.slice(Math.max(0, i - 40), i)), fake: () => '000000000' },
  { kind: 'bank_account', re: /\b\d{8,17}\b/g, ok: (_m, full, i) => BANK_WORDS.test(full.slice(Math.max(0, i - 40), i)), fake: (m) => '0'.repeat(m.length) },
  {
    kind: 'phone',
    re: /(?<![\w.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w|\.\d)|(?<![\w.-])\+\d{9,14}(?!\w|\.\d)/g,
    ok: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 9 && d.length <= 15 && !/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(m.trim()) && !/^(\d)\1+$/.test(d);
    },
    fake: () => '+1 555 0100',
  },
];

/** Scrub one string. Returns the new string and what was found. */
export function scrubText(text: string, path = '$'): { text: string; findings: PiiFinding[] } {
  const findings: PiiFinding[] = [];
  const fakes: string[] = [];
  // Matches become letter-only placeholders, so later rules never re-scan a replacement.
  const token = (i: number) => `\u0001${i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)]!)}\u0001`;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (m: string, ...rest: unknown[]) => {
      const index = rest.find((x) => typeof x === 'number') as number;
      const whole = rest.find((x) => typeof x === 'string' && (x as string).length >= m.length) as string;
      if (r.ok && !r.ok(m, whole ?? out, index ?? 0)) return m;
      if (/^(?:person@example\.test|4242 4242 4242 4242|3782 822463 10005|GB00TEST0+|000-00-0000|\+1 555 0100|QQ 12 34 56 C)$/.test(m)) return m;
      findings.push({ kind: r.kind, path, sample: mask(m) });
      fakes.push(r.fake(m));
      return token(fakes.length - 1);
    });
  }
  out = out.replace(/\u0001([a-z]+)\u0001/g, (_m, t: string) => fakes[parseInt(t.replace(/[q-z]/g, (c) => String('qrstuvwxyz'.indexOf(c))), 26)]!);
  return { text: out, findings };
}

/** Scrub every string in a JSON value (keys included in paths). */
export function scrub<T extends Json>(value: T, path = '$'): { value: T; findings: PiiFinding[] } {
  const findings: PiiFinding[] = [];
  const walk = (v: Json, p: string): Json => {
    if (typeof v === 'string') {
      const r = scrubText(v, p);
      findings.push(...r.findings);
      return r.text;
    }
    if (typeof v === 'number' && Number.isInteger(v) && String(v).length >= 13) {
      const r = scrubText(String(v), p);
      if (r.findings.length) {
        findings.push(...r.findings);
        return 0;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${p}.${k}`)]));
    return v;
  };
  return { value: walk(value, path) as T, findings };
}
