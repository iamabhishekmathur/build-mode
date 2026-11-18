import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from './types.ts';

export interface TaskContext {
  /** Repo folders by name; `host` is the one with stagecraft.config.ts. */
  repos: Record<string, string>;
  host: string;
  /** Proxy base URL while checks run. */
  base: string;
  /** Visit a route in a forked session after loading a scenario; returns page text and whether all Approve buttons are disabled. */
  visit: (path: string, opts?: { scenario?: string; persona?: string; states?: Record<string, string> }) => Promise<{ text: string; html: string; errors: string[] }>;
  changedFiles: Record<string, string[]>;
  branches: Record<string, string>;
}

export interface EvalTask {
  id: string;
  title: string;
  category: 'setup' | 'state' | 'multi-repo';
  /** Synthetic designer persona (PRD 14.3). v0 sends one prompt; no follow-up turns. */
  persona: string;
  fixture: 'ref-react-vite' | 'ref-next-app' | 'multi-repo';
  /** Remove all Stagecraft files first, then run `stagecraft init` (the product's own step), so the agent must finish setup. */
  strip: boolean;
  prompt: string;
  /** Routes that must render with no errors and no unmocked calls. */
  routes: string[];
  timeoutMin: number;
  checks: { id: string; run: (ctx: TaskContext) => Promise<CheckResult> | CheckResult }[];
}

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

/** Find a persona id / a state by a word in its id or label, from the live catalog. */
async function catalog(base: string) {
  return (await fetch(`${base}/__stagecraft/api/catalog`)).json();
}
function findPersona(cat: any, word: RegExp): string | undefined {
  return Object.entries<any>(cat.personas).find(([id, p]) => word.test(id) || word.test(p.label ?? '') || word.test(p.role ?? ''))?.[0];
}
function findState(cat: any, word: RegExp): { entity: string; state: string } | undefined {
  for (const [entity, def] of Object.entries<any>(cat.states)) {
    for (const [state, st] of Object.entries<any>(def.states)) if (word.test(state) || word.test(st.label ?? '')) return { entity, state };
  }
  return undefined;
}

/** Switch to a persona in a fork and look for evidence in the page. */
async function personaShows(c: TaskContext, id: string, word: RegExp, page: RegExp, path = '/'): Promise<CheckResult> {
  const cat = await catalog(c.base);
  const p = findPersona(cat, word);
  if (!p) return pass(id, false, `no persona like ${word}; have ${Object.keys(cat.personas).join(', ')}`);
  const v = await c.visit(path, { persona: p });
  return pass(id, !v.errors.length && page.test(v.text), `persona ${p}: ${v.errors.join(' ') || v.text.slice(0, 140)}`);
}

/** Switch to a state in a fork and look for evidence in the page. */
async function stateShows(c: TaskContext, id: string, word: RegExp, page: RegExp, path = '/'): Promise<CheckResult> {
  const cat = await catalog(c.base);
  const st = findState(cat, word);
  if (!st) return pass(id, false, `no state like ${word}`);
  const v = await c.visit(path, { states: { [st.entity]: st.state } });
  return pass(id, !v.errors.length && page.test(v.text), `${st.entity}=${st.state}: ${v.errors.join(' ') || v.text.slice(0, 140)}`);
}
const pass = (id: string, ok: boolean, detail?: string): CheckResult => ({ id, pass: ok, detail });

function srcFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

export const TASKS: EvalTask[] = [
  {
    id: 'T-SET-01',
    title: 'Set up a React + Vite app from scratch (Ledgerly)',
    category: 'setup',
    persona: 'SD-1 designer, non-technical',
    fixture: 'ref-react-vite',
    strip: true,
    prompt:
      "Hi! I'm a product designer and I want to prototype in our real app, but I can't run the backend. Stagecraft was just added to this repo. Please get it running so every screen works with realistic fake data: Home, Payments, Onboarding and Agent controls, and the assistant chat. I'd like to be able to switch between an admin and an employee, and to see the account as active or frozen. I can't help with code, so please do it all and check it yourself.",
    routes: ['/', '/payments', '/onboarding', '/settings/agents'],
    timeoutMin: 20,
    checks: [
      { id: 'employee persona shows in the UI', run: (c) => personaShows(c, 'employee persona shows in the UI', /employee/i, /employee/i) },
      { id: 'frozen state changes the UI', run: (c) => stateShows(c, 'frozen state changes the UI', /frozen/i, /frozen/i) },
      {
        id: 'cross-origin API mocked (agents page)',
        run: async (c) => {
          const v = await c.visit('/settings/agents');
          return pass('cross-origin API mocked (agents page)', !/Could not load agents/.test(v.text) && !/Loading agents/.test(v.text), v.text.slice(0, 160));
        },
      },
    ],
  },
  {
    id: 'T-SET-02',
    title: 'Set up a Next.js App Router app from scratch (Acme Billing)',
    category: 'setup',
    persona: 'SD-2 PM',
    fixture: 'ref-next-app',
    strip: true,
    prompt:
      "I'm a PM. I want to try changes to our billing app on fake data before engineering builds them. Stagecraft was just added to this repo. Please finish setting it up so the Invoices page and Settings page work with realistic fake data, including what an account owner and a read-only viewer see. Also make it possible to see a past-due account. Check that it works.",
    routes: ['/', '/settings'],
    timeoutMin: 20,
    checks: [
      {
        id: 'server-rendered data comes from mocks',
        run: async (c) => {
          const v = await c.visit('/');
          return pass('server-rendered data comes from mocks', !/failed with|Application error|Unhandled Runtime Error/i.test(v.text) && /invoice/i.test(v.text), v.text.slice(0, 160));
        },
      },
      { id: 'viewer persona shows in the UI', run: (c) => personaShows(c, 'viewer persona shows in the UI', /viewer|read.?only/i, /viewer|only the account owner/i, '/settings') },
      { id: 'past-due state changes the UI', run: (c) => stateShows(c, 'past-due state changes the UI', /past.?due/i, /payment method|past.?due|overdue/i) },
    ],
  },
  {
    id: 'T-STATE-01',
    title: 'Add a "Payment hold" state (prepared repo)',
    category: 'state',
    persona: 'SD-1 designer, non-technical',
    fixture: 'ref-react-vite',
    strip: false,
    prompt:
      "I'm a product designer. Add a new account state called 'Payment hold': outgoing payments are paused for 48 hours. On the Payments page, show a clear notice and don't let admins approve payments while the hold is on. I want to switch to it from the Stagecraft panel. Save a scenario called 'Payment hold admin' that opens the Payments page. Check that it looks right.",
    routes: ['/', '/payments'],
    timeoutMin: 15,
    checks: [
      {
        id: 'scenario file saved',
        run: (c) => pass('scenario file saved', existsSync(join(c.host, 'stagecraft/scenarios/payment-hold-admin.json'))),
      },
      {
        id: 'notice shown in scenario',
        run: async (c) => {
          const v = await c.visit('/payments', { scenario: 'payment-hold-admin' });
          return pass('notice shown in scenario', !v.errors.length && /hold/i.test(v.text), (v.errors.join(' ') || v.text).slice(0, 200));
        },
      },
      {
        id: 'approve disabled or hidden in scenario',
        run: async (c) => {
          const v = await c.visit('/payments', { scenario: 'payment-hold-admin' });
          const enabledApprove = /<button[^>]*>Approve<\/button>/.test(v.html.replace(/<button[^>]*disabled[^>]*>Approve<\/button>/g, ''));
          const pendingShown = /Waiting for approval/i.test(v.text);
          return pass('approve disabled or hidden in scenario', !v.errors.length && pendingShown && !enabledApprove, v.errors.join(' ') || (pendingShown ? undefined : 'no pending payments shown, so nothing to test'));
        },
      },
      {
        id: 'mock blocks approve during hold',
        run: (c) => pass('mock blocks approve during hold', /hold/i.test(read(join(c.host, 'stagecraft/mocks.ts')))),
      },
    ],
  },
  {
    id: 'T-MULTI-01',
    title: 'Change the design-system repo and use it in the app (4 repos)',
    category: 'multi-repo',
    persona: 'SD-1 designer, non-technical',
    fixture: 'multi-repo',
    strip: false,
    prompt:
      "I'm a designer. In our design system, add a small 'Pill' component (a rounded label) that other teams can reuse. Then use it on the dashboard to show each payment's category, like 'Supplies' or 'Equipment'. Payments don't have a category yet, so add realistic fake ones. Keep it ready for engineering handoff.",
    routes: ['/', '/admin/'],
    timeoutMin: 20,
    checks: [
      {
        id: 'Pill added to the library repo',
        run: (c) => {
          const lib = srcFiles(join(c.repos['acme-ui']!, 'src')).map(read).join('\n');
          return pass('Pill added to the library repo', /export (function|const) Pill\b/.test(lib) || /export \{[^}]*\bPill\b/.test(lib));
        },
      },
      {
        id: 'app imports Pill from @acme/ui (no local copy)',
        run: (c) => {
          const app = srcFiles(join(c.host, 'src')).map(read).join('\n');
          const imports = /import\s*\{[^}]*\bPill\b[^}]*\}\s*from\s*['"]@acme\/ui['"]/.test(app);
          const localCopy = /(function|const)\s+Pill\b/.test(app);
          return pass('app imports Pill from @acme/ui (no local copy)', imports && !localCopy, `imports=${imports} localCopy=${localCopy}`);
        },
      },
      {
        id: 'categories rendered on the dashboard',
        run: async (c) => {
          const v = await c.visit('/');
          return pass('categories rendered on the dashboard', /Supplies|Equipment/i.test(v.text), v.text.slice(0, 200));
        },
      },
      {
        id: 'API repo untouched',
        run: (c) => pass('API repo untouched', (c.changedFiles['acme-api'] ?? []).length === 0, (c.changedFiles['acme-api'] ?? []).join(', ')),
      },
      {
        id: 'changed repos share one branch',
        run: (c) => {
          const changed = Object.entries(c.changedFiles).filter(([, f]) => f.length).map(([n]) => n);
          const br = new Set(changed.map((n) => c.branches[n]));
          return pass('changed repos share one branch', changed.length >= 2 && br.size === 1 && ![...br][0]!.match(/^(main|master)$/), changed.map((n) => `${n}@${c.branches[n]}`).join(', '));
        },
      },
    ],
  },
];
