import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { componentGuide, discoverStates, readStories, setupReport } from 'stagecraft';
import { EXAMPLE, fixture, multiRepoFixture, REPO } from '../helpers.ts';

const BIN = join(REPO, 'packages/cli/src/bin.ts');

describe('component guide (FR-305) and Storybook (FR-1301/1302)', () => {
  it('lists every exported design-system component with import, props and stories', () => {
    const fx = multiRepoFixture({ web: 6101, admin: 6102 });
    spawnSync('node', [BIN, 'workspace', 'link'], { cwd: fx.web });
    mkdirSync(join(fx.ui, 'stories'), { recursive: true });
    writeFileSync(
      join(fx.ui, 'stories/Button.stories.tsx'),
      "import { Button } from '../src';\nexport default { title: 'Core/Button', component: Button };\nexport const Primary = { args: { variant: 'primary' } };\nexport const Disabled = { args: { disabled: true } };\nexport const Loading = {};\n",
    );
    const g = componentGuide(fx.web);
    expect(g.entries.map((e) => e.name).sort()).toEqual(['Button', 'Card', 'StatusBadge']); // 100% of exports
    const btn = g.entries.find((e) => e.name === 'Button')!;
    expect(btn.importLine).toBe("import { Button } from '@acme/ui';");
    expect(btn.props.join(' ')).toMatch(/variant\?: 'primary' \| 'secondary'/);
    expect(btn.stories.map((s) => s.split(' ')[0])).toEqual(['Primary', 'Disabled', 'Loading']);
    expect(g.markdown).toMatch(/Don't\*\* build <button> with your own styles/);
    const stories = readStories(fx.ui);
    expect(stories[0]).toMatchObject({ component: 'Button', title: 'Core/Button' });
    // Story names become candidate states (FR-1302).
    const props = discoverStates(fx.ui);
    expect(props.find((p) => p.kind === 'story')?.states).toEqual(['disabled', 'loading']);
  });
});

describe('state discovery (FR-109)', () => {
  it('finds labelled states in the reference apps and reports recall', () => {
    // Labelled lists = the states each example defines by hand in stagecraft/states.ts.
    const cases = [
      { root: EXAMPLE, labelled: ['active', 'frozen', 'over_limit', 'under_review', 'none:approvals', 'pending', 'none:agents', 'some', 'many'] },
      { root: join(REPO, 'examples/ref-next-app'), labelled: ['active', 'past_due', 'suspended', 'none:invoices', 'some', 'overdue'] },
    ];
    for (const c of cases) {
      const props = discoverStates(c.root);
      const found = new Set(props.flatMap((p) => p.states));
      const emptyViews = props.filter((p) => p.kind === 'branch' && p.states.includes('empty')).length;
      const hit = c.labelled.filter((l) => {
        const [s] = l.split(':');
        if (s === 'none') return emptyViews > 0; // an "empty" view branch proposes the none/empty state
        return found.has(s!);
      });
      console.log(`${c.root.split('/').pop()}: recall ${hit.length}/${c.labelled.length}`);
      expect(hit.length).toBeGreaterThan(0);
    }
    const ref = discoverStates(EXAMPLE, { account: { states: { active: {}, frozen: {}, over_limit: {}, under_review: {} } } });
    const acc = ref.find((p) => p.field === 'status' && p.entity === 'account')!;
    expect(acc.states).toEqual(['active', 'frozen', 'over_limit', 'under_review']);
    expect(acc.inCatalog).toHaveLength(4);
    expect(ref.some((p) => p.kind === 'flag' && p.field === 'new-nav')).toBe(true);
  });

  it('writes a proposed states file that type-checks', () => {
    const fx = fixture('disc');
    mkdirSync(join(fx.root, 'src'));
    writeFileSync(join(fx.root, 'src/types.ts'), "export interface Invoice { id: string; status: 'draft' | 'sent' | 'paid'; }\nexport enum Plan { Free = 'free', Pro = 'pro' }\n");
    const r = spawnSync('node', [BIN, 'discover', '--write'], { cwd: fx.root, encoding: 'utf8' });
    expect(r.stdout).toMatch(/invoice\.status: draft, sent, paid/);
    expect(r.stdout).toMatch(/plan\.value: free, pro/);
    const tsc = spawnSync('node', [join(REPO, 'node_modules/typescript/bin/tsc'), '--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', '--allowImportingTsExtensions', join(fx.root, 'stagecraft/states.proposed.ts')], { encoding: 'utf8' });
    expect(tsc.stdout + tsc.stderr).toBe('');
  });
});

describe('setup report (FR-105)', () => {
  it('reports stack, mocks, gaps and a next action per problem', async () => {
    const r = await setupReport(EXAMPLE);
    expect(r.markdown).toMatch(/\*\*Stack:\*\* react/);
    expect(r.markdown).toMatch(/## Mocked endpoints \(8\)/);
    expect(r.markdown).toMatch(/## What works/);
    const fx = fixture('report');
    mkdirSync(join(fx.root, 'src'));
    writeFileSync(join(fx.root, 'src/a.ts'), "fetch('/api/invoices'); import x from '../stagecraft/seed';\n");
    const bad = await setupReport(fx.root);
    expect(bad.markdown).toMatch(/\/api\/invoices.*\(found in code\)/);
    expect(bad.json.steps.find((s: any) => s.ok === false).what).toMatch(/imports mock code/);
    expect(bad.markdown).toMatch(/Next: /);
  });
});
