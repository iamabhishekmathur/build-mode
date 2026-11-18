import { createHash } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkComponents, checkFast, checkHandoff, checkVisual, describePr, launch, openCell, renderMatrix, VIEWPORTS } from '@stagecraft/checks';
import { startServer, type StagecraftServer } from '@stagecraft/server';
import { fixture, REPO as REPO_ROOT } from '../helpers.ts';

/** Seeded visual bugs (PRD GD-4, small): one planted bug per page + a clean control page. */
const PAGES: Record<string, { html: string; expect: string | null }> = {
  '/clean': { html: '<main style="padding:24px;max-width:600px"><h1>Invoices</h1><p>Everything fits and reads well on every size.</p><button>Pay</button></main>', expect: null },
  '/overflow': { html: '<main style="padding:24px"><h1>Wide</h1><div style="width:2000px;background:#eee">Table that does not wrap</div></main>', expect: 'page-overflow' },
  '/cutoff': { html: '<main style="padding:24px"><h1>Name</h1><div style="width:80px;height:20px;overflow:hidden;white-space:nowrap">Bartholomew Montgomery-Smythe</div></main>', expect: 'text-cut-off' },
  '/overlap': { html: '<main style="padding:24px;position:relative"><h1>Actions</h1><button style="position:absolute;left:24px;top:80px;width:120px">Approve</button><button style="position:absolute;left:40px;top:84px;width:120px">Reject</button></main>', expect: 'overlap' },
  '/image': { html: '<main style="padding:24px"><h1>Logo</h1><img src="/missing.png" width="80" height="80" alt="logo"></main>', expect: 'broken-image' },
  '/undefined': { html: '<main style="padding:24px"><h1>Balance</h1><p>Total: $undefined</p></main>', expect: 'bad-value' },
  '/empty': { html: '<main></main>', expect: 'empty-page' },
  '/contrast': { html: '<main style="padding:24px;background:#fff"><h1>Notice</h1><p style="color:#ddd">Payments are paused until Monday.</p></main>', expect: 'low-contrast' },
  '/crash': { html: '<main style="padding:24px"><h1>Report</h1><p>Loading report…</p></main><script>setTimeout(()=>{throw new Error("Cannot read properties of undefined (reading \'map\')")},0)</script>', expect: 'runtime-error' },
  '/clock': { html: '<main style="padding:24px"><h1>Now</h1><p id="t"></p><p id="r"></p></main><script>document.getElementById("t").textContent=new Date().toISOString();document.getElementById("r").textContent=String(Math.random())</script>', expect: null },
};

let upstream: http.Server;
let server: StagecraftServer;
let base: string;
let root: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const p = PAGES[new URL(req.url!, 'http://x').pathname];
    if (!p) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;font:16px sans-serif;color:#111;background:#fff">${p.html}</body></html>`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const fx = fixture('checks');
  root = fx.root;
  const s = await startServer(fx.config, { port: 0, devUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, watch: false, log: () => {} });
  server = s.server;
  base = s.url;
});
afterAll(async () => {
  await server?.close();
  upstream?.close();
});

describe('check visual (FR-1001) on a seeded-bug set', () => {
  it('catches the planted bugs and stays quiet on the clean page', async () => {
    const routes = Object.keys(PAGES).filter((r) => r !== '/clock');
    const r = await checkVisual({ base, root, routes, cells: [{ viewport: VIEWPORTS.desktop }] });
    const byRoute = (route: string) => r.findings.filter((f) => f.where?.startsWith(route + ' @'));
    const seeded = routes.filter((x) => PAGES[x]!.expect);
    const caught = seeded.filter((x) => byRoute(x).some((f) => f.rule === PAGES[x]!.expect));
    const missed = seeded.filter((x) => !caught.includes(x));
    // PRD target ≥ 70%. Report the real rate.
    console.log(`visual catch rate: ${caught.length}/${seeded.length}${missed.length ? ` (missed ${missed.join(', ')})` : ''}`);
    expect(caught.length / seeded.length).toBeGreaterThanOrEqual(0.7);
    expect(byRoute('/clean')).toEqual([]);
    expect(r.cells).toHaveLength(routes.length);
    expect(existsSync(r.cells[0]!.screenshot)).toBe(true);
  }, 120000);

  it('FR-1007: same input → same screenshot, 10 of 10', async () => {
    const browser = await launch();
    const hashes = new Set<string>();
    try {
      for (let i = 0; i < 10; i++) {
        const { page } = await openCell(browser, `${base}/clock?sc_panel=0`, { viewport: { width: 500, height: 300 } });
        hashes.add(createHash('sha256').update(await page.screenshot()).digest('hex'));
        await page.close();
      }
    } finally {
      await browser.close();
    }
    expect(hashes.size).toBe(1);
  }, 120000);

  it('FR-407: renders a matrix grid served by the proxy', async () => {
    const t0 = Date.now();
    const m = await renderMatrix({ base, root, routes: [], route: '/clean', cells: [{ viewport: VIEWPORTS.desktop }, { viewport: VIEWPORTS.tablet }, { viewport: VIEWPORTS.phone }, { persona: 'employee', viewport: VIEWPORTS.phone }] });
    expect(m.cells).toHaveLength(4);
    expect(Date.now() - t0).toBeLessThan(60000);
    const page = await fetch(`${base}/__stagecraft/checks/${m.dir.split('/').pop()}/index.html`);
    const html = await page.text();
    expect(html).toContain('4 cells');
    expect(html).toContain('employee');
    expect((await fetch(`${base}/__stagecraft/checks/${m.dir.split('/').pop()}/cell-00.png`)).headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/__stagecraft/checks/..%2F..%2Fstagecraft.config.ts`)).status).toBe(404);
  }, 120000);
});

/** A tiny repo with a design-system package, a base commit, then a change with planted design debt. */
function debtRepo() {
  const fx = fixture('debt');
  const r = join(fx.root, 'app');
  const ui = join(r, 'node_modules/@acme/ui');
  mkdirSync(join(ui, 'src'), { recursive: true });
  writeFileSync(join(ui, 'package.json'), JSON.stringify({ name: '@acme/ui', main: 'src/index.tsx' }));
  writeFileSync(join(ui, 'src/index.tsx'), 'export function Button() { return null }\nexport function Card() { return null }\n/** @deprecated use Button */\nexport function OldButton() { return null }\n');
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/ui': '1.0.0' } }));
  writeFileSync(join(r, '.gitignore'), 'node_modules\n');
  writeFileSync(join(r, 'src/old.tsx'), 'export const legacy = { color: "#123456" };\n');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { r, git };
}

describe('check components (FR-1005) on seeded design debt', () => {
  it('flags new debt on changed lines only and honours explained exceptions', () => {
    const { r } = debtRepo();
    writeFileSync(
      join(r, 'src/new.tsx'),
      [
        "import { Card, OldButton } from '@acme/ui';",
        'export function Button({ label }: { label: string }) { return <button>{label}</button>; }',
        "export const AgentCard = () => <div style={{ color: '#ff0000' }} />;",
        "export const Gap = () => <div style={{ padding: '13px' }} />;",
        "export const Fine = () => <div style={{ background: 'rgb(0, 0, 0)' }} />; // stagecraft-allow: brand exception approved",
        'export const Ok = () => <Card />;',
      ].join('\n'),
    );
    writeFileSync(join(r, 'src/old.tsx'), 'export const legacy = { color: "#123456" };\nexport const x = 1;\n');
    const res = checkComponents(r);
    const rules = res.findings.map((f) => `${f.rule}:${f.line}`);
    expect(rules).toContain('deprecated-component:1');
    expect(rules).toContain('duplicate-component:2');
    expect(rules).toContain('hard-coded-color:3');
    expect(rules).toContain('hard-coded-spacing:4');
    // Planted: 4 debts. Caught: all. Not flagged: the allowed line, the Card usage, old untouched lines.
    expect(res.findings.filter((f) => f.file === 'src/new.tsx' && f.line === 5)).toEqual([]);
    expect(res.findings.filter((f) => f.file === 'src/old.tsx')).toEqual([]);
    expect(res.pass).toBe(false);
    expect(res.notes?.[0]).toMatch(/@acme\/ui \(3 exports\)/);
  });
});

describe('check handoff (FR-1106) and PR description (FR-1107)', () => {
  it('fails with a reason for each condition, then passes when fixed', async () => {
    const { r, git } = debtRepo();
    writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/ui': '1.0.0' }, scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(1)"' } }));
    writeFileSync(join(r, 'src/page.tsx'), "import { Variant } from '@stagecraft/react';\nimport { seed } from '../stagecraft/seed';\nexport const P = () => <Variant name=\"x\" options={{ a: null, b: null }} />;\n");
    git('add', '-A');
    git('commit', '-qm', 'proto');
    let g = await checkHandoff(r);
    const failed = g.steps.filter((s) => !s.ok).map((s) => s.step);
    expect(failed).toEqual(expect.arrayContaining(['tests', 'no mock code in product code', 'no variants left']));
    expect(g.pass).toBe(false);
    writeFileSync(join(r, 'src/page.tsx'), 'export const P = () => null;\n');
    writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/ui': '1.0.0' }, scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }));
    g = await checkHandoff(r);
    expect(g.steps.filter((s) => !s.ok)).toEqual([]);
    expect(g.pass).toBe(true);
  }, 60000);

  it('writes a PR description with every section', async () => {
    const md = await describePr(root);
    for (const h of ['## Summary', '## Screens changed', '## States covered', '## Scenarios', '## Tapes', '## Figma', '## Backend work needed', '## Known gaps', '## Handoff gate']) expect(md).toContain(h);
    expect(md).toContain('Over-limit admin');
    expect(md).toContain('vendor-payment-approval');
  });
});

describe('check fast (FR-1003)', () => {
  it('reports type errors in changed files within budget', () => {
    const { r, git } = debtRepo();
    writeFileSync(join(r, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, jsx: 'react-jsx', skipLibCheck: true, types: [] }, include: ['src'] }));
    writeFileSync(join(r, 'src/bad.ts'), 'export const n: number = "not a number";\n');
    git('add', 'tsconfig.json');
    const t0 = Date.now();
    const res = checkFast(r);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(res.findings.some((f) => f.file === 'src/bad.ts' && /not assignable/.test(f.message))).toBe(true);
  }, 30000);
});

describe('scenario clock', () => {
  it('mock handlers see the scenario time; links carry it', async () => {
    await fetch(`${base}/__stagecraft/api/session`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clock: '2027-03-01T09:00:00Z' }) });
    const s = await (await fetch(`${base}/__stagecraft/api/session`)).json();
    expect(s.state.clock).toBe('2027-03-01T09:00:00.000Z');
    expect(s.link).toMatch(/__sc=/);
    const bad = await fetch(`${base}/__stagecraft/api/session`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clock: 'tomorrow' }) });
    expect(bad.status).toBe(400);
    await fetch(`${base}/__stagecraft/api/session`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clock: null }) });
  });
});

describe('Figma fidelity (FR-1002) and token map (FR-1203)', () => {
  it('scores an identical frame 100 and finds the region that changed', async () => {
    const { checkFigma } = await import('@stagecraft/checks');
    const browser = await launch();
    const refFile = join(root, 'frame.png');
    try {
      const { page } = await openCell(browser, `${base}/clean?sc_panel=0`, { viewport: { width: 600, height: 400 } });
      writeFileSync(refFile, await page.screenshot({ clip: { x: 0, y: 0, width: 600, height: 400 } }));
      await page.close();
    } finally {
      await browser.close();
    }
    const same = await checkFigma({ base, root, route: '/clean', reference: refFile });
    expect(same.score).toBe(100);
    expect(same.regions).toEqual([]);
    const other = await checkFigma({ base, root, route: '/overlap', reference: refFile });
    expect(other.score).toBeLessThan(100);
    expect(other.regions.length).toBeGreaterThan(0);
    for (const f of Object.values(other.images)) expect(existsSync(f)).toBe(true);
  }, 60000);

  it('maps Figma variables to CSS and TS tokens by value and lists the rest', async () => {
    const { codeTokens, flattenVars, mapTokens } = await import('@stagecraft/checks');
    const { EXAMPLE } = await import('../helpers.ts');
    const vars = flattenVars({ color: { brand: { primary: '#2F43D6' }, text: { default: 'rgb(28, 28, 30)' }, accent: '#FF00AA' }, spacing: { '4': '16px' } });
    expect(Object.keys(vars)).toEqual(['color/brand/primary', 'color/text/default', 'color/accent', 'spacing/4']);
    const map = mapTokens(vars, codeTokens([join(EXAMPLE, 'src'), join(REPO_ROOT, 'examples/multi-repo/acme-ui/src')], EXAMPLE));
    expect(map.mapped.find((m) => m.figma === 'color/brand/primary')?.code).toBe('--color-brand');
    expect(map.mapped.find((m) => m.figma === 'color/text/default')?.code).toBe('--color-text');
    expect(map.mapped.find((m) => m.figma === 'spacing/4')?.code).toBe('--space-4');
    expect(map.unmapped).toEqual([{ figma: 'color/accent', value: '#FF00AA' }]);
  });
});
