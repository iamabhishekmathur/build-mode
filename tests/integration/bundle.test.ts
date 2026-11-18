import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, REPO } from '../helpers.ts';

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('production build (FR-507, FR-106)', () => {
  it('contains zero bytes of mock code and still builds', async () => {
    const { build } = await import('vite');
    const outDir = join(REPO, 'tests/.tmp', `bundle-${Date.now()}`);
    await build({ root: EXAMPLE, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const code = allFiles(outDir).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(code.length).toBeGreaterThan(10_000);
    // Strings that only exist in stagecraft/ (seed, mocks, states).
    for (const marker of ['Northwind Supplies', 'ledgerly.test', 'Only admins can approve', 'Umbrella Logistics', 'No such agent', '__STAGECRAFT_BOOT__']) {
      expect(code, marker).not.toContain(marker);
    }
  }, 60000);

  it('Vue app (@stagecraft/vue): zero bytes of mock code, adapter is inert', async () => {
    const { build } = await import('vite');
    const root = join(REPO, 'examples/ref-vue-vite');
    const outDir = join(REPO, 'tests/.tmp', `bundle-vue-${Date.now()}`);
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const code = allFiles(outDir).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(code.length).toBeGreaterThan(10_000);
    expect(code).toContain('Fieldnote');
    for (const marker of ['Harbor Design Co', 'fieldnote.test', 'Only owners can create projects', 'Project 12', 'An admin locked the workspace', '__STAGECRAFT_BOOT__']) {
      expect(code, marker).not.toContain(marker);
    }
  }, 60000);
});
