import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { axeSource, cellLabel, cellUrl, launch, openCell, outDir, pool, VIEWPORTS, type Cell } from './browser.ts';
import { result, type CheckResult, type Finding } from './util.ts';

/** In-page detectors for the visual bugs that reading code misses. Runs in the browser. */
function detect() {
  const out: { rule: string; severity: 'error' | 'warning'; message: string; selector?: string }[] = [];
  const own = (e: Element) => !!e.closest('stagecraft-panel, stagecraft-overlay');
  const sel = (e: Element): string => {
    if ((e as HTMLElement).dataset?.testid) return `[data-testid="${(e as HTMLElement).dataset.testid}"]`;
    if (e.id) return `#${e.id}`;
    const p = e.parentElement;
    if (!p) return e.tagName.toLowerCase();
    const i = [...p.children].filter((c) => c.tagName === e.tagName).indexOf(e) + 1;
    return `${sel(p)} > ${e.tagName.toLowerCase()}:nth-of-type(${i})`;
  };
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const all = [...document.body.querySelectorAll('*')].filter((e) => !own(e));
  // 1. Page wider than the viewport (horizontal scroll).
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    const offender = all.filter((e) => visible(e) && e.getBoundingClientRect().right > vw + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    out.push({ rule: 'page-overflow', severity: 'error', message: `Page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport (horizontal scroll).`, selector: offender ? sel(offender) : undefined });
  }
  // 2. Cut-off text: content larger than a box that hides overflow.
  for (const e of all) {
    if (!visible(e) || !(e as HTMLElement).innerText?.trim()) continue;
    const cs = getComputedStyle(e);
    const hidesX = /hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis';
    const hidesY = /hidden|clip/.test(cs.overflowY);
    const he = e as HTMLElement;
    const directText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
    if (!directText) continue;
    if ((hidesX && he.scrollWidth > he.clientWidth + 1) || (hidesY && he.scrollHeight > he.clientHeight + 1)) {
      out.push({ rule: 'text-cut-off', severity: cs.textOverflow === 'ellipsis' ? 'warning' : 'error', message: `Text is cut off: "${he.innerText.trim().slice(0, 50)}"`, selector: sel(e) });
    }
  }
  // 3. Interactive elements on top of each other.
  const inter = all.filter((e) => e.matches('a[href],button,input,select,textarea,[role=button],[role=link]') && visible(e));
  for (let i = 0; i < inter.length; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i]!;
      const b = inter[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const r1 = a.getBoundingClientRect();
      const r2 = b.getBoundingClientRect();
      const w = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
      const h = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
      if (w > 2 && h > 2 && w * h > 0.2 * Math.min(r1.width * r1.height, r2.width * r2.height)) {
        out.push({ rule: 'overlap', severity: 'error', message: `"${(a as HTMLElement).innerText?.trim().slice(0, 30) || a.tagName}" overlaps "${(b as HTMLElement).innerText?.trim().slice(0, 30) || b.tagName}"`, selector: sel(a) });
      }
    }
  }
  // 4. Broken images.
  for (const img of document.images) if (!own(img) && img.complete && img.naturalWidth === 0 && visible(img)) out.push({ rule: 'broken-image', severity: 'error', message: `Image did not load: ${img.src.slice(0, 80)}`, selector: sel(img) });
  // 5. Placeholder values leaking into the UI.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<string>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || own(el) || !visible(el) || /^(SCRIPT|STYLE|CODE|PRE)$/.test(el.tagName)) continue;
    const m = /(^|[\s$:(])(undefined|NaN|null|\[object Object\]|Invalid Date)(?=$|[\s.,)])/.exec(n.textContent ?? '');
    if (m && !seen.has(m[2]!)) {
      seen.add(m[2]!);
      out.push({ rule: 'bad-value', severity: 'error', message: `"${m[2]}" is shown to the user: "${n.textContent!.trim().slice(0, 60)}"`, selector: sel(el) });
    }
  }
  // 6. Nothing on the page.
  const text = all.filter((e) => !own(e)).map((e) => (e as HTMLElement).innerText ?? '').join(' ').trim();
  if (text.length < 20 && !document.querySelector('img,svg,canvas,video')) out.push({ rule: 'empty-page', severity: 'error', message: 'The page shows almost nothing.' });
  return out;
}

export interface VisualOptions {
  base: string;
  root: string;
  routes: string[];
  cells?: Cell[];
  session?: string;
  /** Include axe color-contrast (default true). */
  contrast?: boolean;
  concurrency?: number;
}

/** Default matrix: current state on desktop and phone. */
export const DEFAULT_CELLS: Cell[] = [{ viewport: VIEWPORTS.desktop }, { viewport: VIEWPORTS.phone }];

/**
 * FR-1001: screenshot changed views across a state matrix, run the detectors, and return the
 * screenshots so the agent can look at them too (the agent is the vision reviewer).
 */
export async function checkVisual(opts: VisualOptions): Promise<CheckResult & { cells: { route: string; label: string; screenshot: string; url: string }[] }> {
  const t0 = Date.now();
  const dir = outDir(opts.root, 'visual');
  const cells = opts.cells?.length ? opts.cells : DEFAULT_CELLS;
  const jobs = opts.routes.flatMap((route) => cells.map((cell) => ({ route, cell })));
  const browser = await launch();
  const axe = opts.contrast === false ? '' : axeSource();
  const findings: Finding[] = [];
  const shots: { route: string; label: string; screenshot: string; url: string }[] = [];
  try {
    await pool(jobs, opts.concurrency ?? 4, async ({ route, cell }, i) => {
      const url = cellUrl(opts.base, route, cell, opts.session);
      const where = `${route} @ ${cellLabel(cell)}`;
      const { page, errors } = await openCell(browser, url, cell);
      try {
        for (const e of errors) findings.push({ rule: 'runtime-error', severity: 'error', message: e, where });
        for (const f of (await page.evaluate(detect)) as Finding[]) findings.push({ ...f, where });
        if (axe) {
          await page.addScriptTag({ content: axe });
          const res = await page.evaluate(() => (window as any).axe.run({ exclude: [['stagecraft-panel'], ['stagecraft-overlay']] }, { runOnly: { type: 'rule', values: ['color-contrast'] } }));
          for (const v of res.violations) for (const n of v.nodes.slice(0, 5)) findings.push({ rule: 'low-contrast', severity: 'error', message: n.failureSummary?.split('\n').slice(-1)[0]?.trim() ?? v.help, selector: n.target.join(' '), where });
        }
        const file = join(dir, `${String(i).padStart(2, '0')}-${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}-${cellLabel(cell).replace(/[^a-z0-9=]+/gi, '_')}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots[i] = { route, label: cellLabel(cell), screenshot: file, url: url.replace(/&?sc_panel=0/, '') };
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings, null, 2));
  return { ...result('visual', t0, findings, { artifacts: shots.map((s) => s.screenshot), notes: [`${jobs.length} screenshots in ${dir}`] }), cells: shots };
}

/** FR-1004: axe-core WCAG 2.2 A/AA scan of routes. */
export async function checkA11y(opts: VisualOptions): Promise<CheckResult> {
  const t0 = Date.now();
  const cells = opts.cells?.length ? opts.cells : [{ viewport: VIEWPORTS.desktop }];
  const browser = await launch();
  const axe = axeSource();
  const findings: Finding[] = [];
  try {
    await pool(opts.routes.flatMap((route) => cells.map((cell) => ({ route, cell }))), opts.concurrency ?? 4, async ({ route, cell }) => {
      const { page, errors } = await openCell(browser, cellUrl(opts.base, route, cell, opts.session), cell);
      const where = `${route} @ ${cellLabel(cell)}`;
      try {
        for (const e of errors.filter((x) => x.startsWith('document') || x.startsWith('navigation'))) findings.push({ rule: 'runtime-error', severity: 'error', message: e, where });
        await page.addScriptTag({ content: axe });
        const res = await page.evaluate(() =>
          (window as any).axe.run({ exclude: [['stagecraft-panel'], ['stagecraft-overlay']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }),
        );
        for (const v of res.violations) {
          for (const n of v.nodes.slice(0, 5)) {
            findings.push({ rule: `a11y ${v.id}`, severity: v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning', message: `${v.help} (${v.impact})`, selector: n.target.join(' '), where });
          }
        }
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
  return result('a11y', t0, findings);
}

/** FR-407: one screen across a cell matrix as a grid of screenshots; each cell links to the live state. */
export async function renderMatrix(opts: VisualOptions & { route: string }): Promise<{ html: string; dir: string; cells: { label: string; screenshot: string; url: string }[]; ms: number }> {
  const t0 = Date.now();
  const dir = outDir(opts.root, 'matrix');
  const cells = opts.cells?.length ? opts.cells : DEFAULT_CELLS;
  const browser = await launch();
  const out: { label: string; screenshot: string; url: string }[] = [];
  try {
    await pool(cells, opts.concurrency ?? 4, async (cell, i) => {
      const url = cellUrl(opts.base, opts.route, cell, opts.session);
      const { page } = await openCell(browser, url, cell);
      try {
        const file = join(dir, `cell-${String(i).padStart(2, '0')}.png`);
        await page.screenshot({ path: file });
        out[i] = { label: cellLabel(cell), screenshot: file, url: cellUrl(opts.base, opts.route, cell, opts.session, true) };
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matrix ${esc(opts.route)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1b;--muted:#666;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333}}
body{margin:0;padding:16px;font:13px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg)}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}figcaption{padding:6px 8px}img{width:100%;display:block;border-top:1px solid var(--line)}a{color:inherit}</style></head>
<body><h1 style="font-size:16px">${esc(opts.route)}: ${out.length} cells</h1><main>${out
    .map((c) => `<figure><figcaption><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.label)}</a></figcaption><img alt="${esc(c.label)}" src="${esc(c.screenshot.split('/').pop()!)}"></figure>`)
    .join('')}</main></body></html>`;
  writeFileSync(join(dir, 'index.html'), html);
  return { html, dir, cells: out, ms: Date.now() - t0 };
}
