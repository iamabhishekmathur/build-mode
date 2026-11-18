import { describe, expect, it } from 'vitest';
import { scrub, scrubText, type PiiKind } from '@stagecraft/core';

// Deterministic generator for a labelled PII test set (NFR-103). Real-looking, checksum-valid values.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
const int = (n: number) => Math.floor(rnd() * n);
const digits = (n: number) => Array.from({ length: n }, () => int(10)).join('');
const pick = <T,>(xs: T[]) => xs[int(xs.length)]!;

function luhnDigit(body: string) {
  for (let d = 0; d < 10; d++) {
    const all = body + d;
    let sum = 0;
    let alt = false;
    for (let i = all.length - 1; i >= 0; i--) {
      let n = Number(all[i]);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    if (sum % 10 === 0) return String(d);
  }
  return '0';
}

function card() {
  const [pre, len] = pick([
    ['4', 16],
    ['51', 16],
    ['55', 16],
    ['2221', 16],
    ['34', 15],
    ['37', 15],
    ['6011', 16],
  ] as [string, number][]);
  const body = pre + digits(len - pre.length - 1);
  const n = body + luhnDigit(body);
  return pick([n, n.replace(/(\d{4})(?=\d)/g, '$1 '), n.replace(/(\d{4})(?=\d)/g, '$1-')]);
}

function iban() {
  const [cc, len] = pick([
    ['DE', 18],
    ['GB', 18],
    ['FR', 23],
    ['NL', 14],
    ['ES', 20],
  ] as [string, number][]);
  const bban = cc === 'GB' || cc === 'NL' ? pick(['NWBK', 'ABNA', 'BARC']) + digits(len - 4) : digits(len);
  const num = (bban + cc + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of num) rem = (rem * 10 + Number(d)) % 97;
  const v = cc + String(98 - rem).padStart(2, '0') + bban;
  return rnd() < 0.5 ? v : v.replace(/(.{4})(?=.)/g, '$1 ');
}

function aba() {
  for (;;) {
    const d = digits(8);
    for (let c = 0; c < 10; c++) {
      const n = (d + c).split('').map(Number);
      if ((3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!)) % 10 === 0) return d + c;
    }
  }
}

function sin() {
  const body = String(1 + int(8)) + digits(7);
  const n = body + luhnDigit(body);
  return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
}

const NAMES = ['maria.lopez', 'j.smith', 'akira_t', 'dev+billing', 'o.connor'];
const DOMAINS = ['gmail.com', 'acme-corp.com', 'outlook.co.uk', 'fastmail.fm', 'company.io'];

const POS: [PiiKind, () => string][] = [
  ['email', () => `Contact ${pick(NAMES)}@${pick(DOMAINS)} about the refund.`],
  ['phone', () => pick([`Call me at (415) ${digits(3)}-${digits(4)}.`, `Phone: +44 20 ${digits(4)} ${digits(4)}`, `mobile +1-212-${digits(3)}-${digits(4)}`, `WhatsApp +4915${digits(9)}`, `tel 020 ${digits(4)} ${digits(4)}`])],
  ['card', () => `Card number ${card()} exp 09/28`],
  ['ssn', () => `SSN ${String(100 + int(565)).padStart(3, '0')}-${String(10 + int(89))}-${String(1000 + int(8999))}`],
  ['iban', () => `Pay to IBAN ${iban()} by Friday`],
  ['routing', () => `routing number ${aba()}`],
  ['bank_account', () => `bank account ${digits(8 + int(6))}`],
  ['sin', () => `Employee SIN ${sin()}`],
  ['nino', () => `NI number ${pick(['AB', 'CE', 'JH', 'TW'])} ${digits(2)} ${digits(2)} ${digits(2)} ${pick(['A', 'B', 'C', 'D'])}`],
];

const NEG = [
  () => `Order #${digits(9)} shipped on 2026-11-${String(1 + int(28)).padStart(2, '0')}`,
  () => `Invoice INV-${digits(6)} total $${int(90000)}.${digits(2)}`,
  () => `id ${'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => int(16).toString(16))}`,
  () => `Version ${int(9)}.${int(20)}.${int(40)} released`,
  () => `Created at ${new Date(1.7e12 + int(1e10)).toISOString()}`,
  () => 'Write to ada@ledgerly.test or ops@example.com',
  () => `ZIP ${digits(5)}, suite ${int(900)}`,
  () => `Quantity ${int(500)} at ${int(99)}.${digits(2)} each`,
  () => `Tracking 1Z${digits(16)}`,
  () => `Timestamp ${1700000000000 + int(1e9)}`,
];

describe('PII scrubber (NFR-103) on a labelled test set', () => {
  const N = 120;
  it('recall per kind ≥ 99% (target); false positives under 2%', () => {
    const report: string[] = [];
    for (const [kind, gen] of POS) {
      let hit = 0;
      let sameKind = 0;
      const missed: string[] = [];
      for (let i = 0; i < N; i++) {
        const t = gen();
        const r = scrubText(t);
        // Recall = the value is gone (NFR-103). Kind accuracy is reported separately:
        // e.g. a 9-digit account number that passes the routing checksum is removed as "routing".
        if (r.findings.length) hit++;
        else missed.push(t);
        if (r.findings.some((f) => f.kind === kind)) sameKind++;
      }
      report.push(`${kind}: removed ${hit}/${N}, labelled ${kind} ${sameKind}/${N}${missed.length ? ` missed e.g. "${missed[0]}"` : ''}`);
      expect(hit / N, `${kind} recall; ${missed.slice(0, 3).join(' | ')}`).toBeGreaterThanOrEqual(0.99);
    }
    const total = (N * NEG.length) / 2;
    const fps: string[] = [];
    for (let i = 0; i < total; i++) {
      const t = pick(NEG)();
      if (scrubText(t).findings.length) fps.push(t);
    }
    report.push(`false positives: ${fps.length}/${total}${fps.length ? ` e.g. "${fps[0]}"` : ''}`);
    console.log(report.join('\n'));
    expect(fps.length / total).toBeLessThan(0.02);
  });

  it('scrubs nested JSON, keeps example/test emails, and never returns the raw value', () => {
    const { value, findings } = scrub({ users: [{ email: 'maria@gmail.com', note: 'card 4111 1111 1111 1111' }, { email: 'ada@ledgerly.test' }] } as any);
    expect((value as any).users[0].email).toBe('person@example.test');
    expect((value as any).users[0].note).not.toContain('4111 1111 1111 1111');
    expect((value as any).users[1].email).toBe('ada@ledgerly.test');
    expect(findings.map((f) => f.path)).toEqual(['$.users[0].email', '$.users[0].note']);
    expect(JSON.stringify(findings)).not.toContain('maria@gmail.com');
  });
});
