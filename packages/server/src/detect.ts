import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Output of `stagecraft detect` (FR-101). Written to stagecraft.detect.json. */
export interface Detection {
  root: string;
  framework: { name: string; version: string | null; tier: 1 | 2 | 3 } | null;
  bundler: string | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  monorepo: { tool: string; apps: string[] } | null;
  devCommand: string | null;
  devPort: number | null;
  node: string | null;
  router: string | null;
  apiStyle: string[];
  apiSpecs: string[];
  stateLibrary: string[];
  flagVendor: string[];
  designSystem: string[];
  storybook: { version: string | null; mcpAddon: boolean } | null;
  typescript: boolean;
  notes: string[];
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const has = (deps: Record<string, string>, name: string) => name in deps;
const ver = (deps: Record<string, string>, name: string) => deps[name]?.replace(/^[^\d]*/, '') ?? null;

function walk(dir: string, depth: number, out: string[], match: (f: string) => boolean) {
  if (depth < 0) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.') || e === 'dist' || e === 'build') continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth - 1, out, match);
    else if (match(e)) out.push(p);
  }
}

export function detect(root: string): Detection {
  const pkg = readJson(join(root, 'package.json')) ?? {};
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const notes: string[] = [];
  const d: Detection = {
    root,
    framework: null,
    bundler: null,
    packageManager: null,
    monorepo: null,
    devCommand: null,
    devPort: null,
    node: null,
    router: null,
    apiStyle: [],
    apiSpecs: [],
    stateLibrary: [],
    flagVendor: [],
    designSystem: [],
    storybook: null,
    typescript: existsSync(join(root, 'tsconfig.json')) || has(deps, 'typescript'),
    notes,
  };

  // Package manager
  if (existsSync(join(root, 'pnpm-lock.yaml'))) d.packageManager = 'pnpm';
  else if (existsSync(join(root, 'yarn.lock'))) d.packageManager = 'yarn';
  else if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) d.packageManager = 'bun';
  else if (existsSync(join(root, 'package-lock.json'))) d.packageManager = 'npm';
  if (typeof pkg.packageManager === 'string') d.packageManager = pkg.packageManager.split('@')[0];

  // Monorepo
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  const tool = existsSync(join(root, 'turbo.json')) ? 'turborepo' : existsSync(join(root, 'nx.json')) ? 'nx' : existsSync(join(root, 'pnpm-workspace.yaml')) ? 'pnpm-workspaces' : workspaces ? `${d.packageManager ?? 'npm'}-workspaces` : null;
  if (tool) {
    const apps: string[] = [];
    for (const dir of ['apps', 'packages', 'examples']) {
      const p = join(root, dir);
      if (!existsSync(p)) continue;
      for (const e of readdirSync(p)) {
        const sub = readJson(join(p, e, 'package.json'));
        const sdeps = { ...sub?.dependencies, ...sub?.devDependencies };
        if (sub && (sdeps.react || sdeps.vue || sdeps.svelte || sdeps['@angular/core'] || sdeps.next || sdeps.nuxt) && sub.scripts?.dev) apps.push(`${dir}/${e}`);
      }
    }
    d.monorepo = { tool, apps };
    if (apps.length) notes.push(`Monorepo: run "stagecraft init" inside one app folder (${apps.join(', ')}).`);
  }

  // Framework (most specific first)
  const fw: [string, string, 1 | 2 | 3][] = [
    ['next', 'next', 1],
    ['nuxt', 'nuxt', 1],
    ['@sveltejs/kit', 'sveltekit', 1],
    ['@angular/core', 'angular', 1],
    ['@remix-run/react', 'remix', 2],
    ['@react-router/dev', 'react-router', 2],
    ['astro', 'astro', 2],
    ['react-scripts', 'create-react-app', 2],
    ['solid-js', 'solid', 2],
    ['preact', 'preact', 2],
    ['vue', 'vue', 1],
    ['react', 'react', 1],
    ['svelte', 'svelte', 2],
  ];
  for (const [dep, name, tier] of fw) {
    if (has(deps, dep)) {
      d.framework = { name, version: ver(deps, dep), tier };
      break;
    }
  }
  if (!d.framework) {
    if (existsSync(join(root, 'index.html'))) d.framework = { name: 'plain', version: null, tier: 2 };
    else if (existsSync(join(root, 'Gemfile')) || existsSync(join(root, 'manage.py')) || existsSync(join(root, 'composer.json'))) d.framework = { name: 'server-rendered', version: null, tier: 3 };
  }
  if (d.framework?.name === 'angular' && Number((d.framework.version ?? '0').split('.')[0]) < 17) d.framework.tier = 2;

  // Bundler
  d.bundler = has(deps, 'vite') || has(deps, 'nuxt') ? 'vite' : has(deps, 'next') ? 'next' : has(deps, 'webpack') ? `webpack ${ver(deps, 'webpack') ?? ''}`.trim() : has(deps, 'react-scripts') ? 'webpack (CRA)' : has(deps, 'parcel') ? 'parcel' : null;
  if (d.bundler?.startsWith('webpack 4')) notes.push('webpack 4 is Tier 2: injection works through the proxy; HMR may need a manual reload.');

  // Dev command and port
  const scripts = pkg.scripts ?? {};
  const devScript = ['dev', 'start', 'serve'].find((s) => scripts[s]);
  if (devScript) {
    d.devCommand = `${d.packageManager === 'yarn' ? 'yarn' : d.packageManager === 'pnpm' ? 'pnpm' : d.packageManager === 'bun' ? 'bun run' : 'npm run'} ${devScript}`;
    const portMatch = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/.exec(scripts[devScript]);
    d.devPort = portMatch ? Number(portMatch[1]) : null;
  }
  if (!d.devPort) {
    for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
      const p = join(root, f);
      if (existsSync(p)) {
        const m = /port:\s*(\d{2,5})/.exec(readFileSync(p, 'utf8'));
        if (m) d.devPort = Number(m[1]);
      }
    }
  }
  d.devPort ??= d.bundler === 'vite' ? 5173 : d.framework?.name === 'angular' ? 4200 : d.framework?.name === 'nuxt' || d.framework?.name === 'next' ? 3000 : null;

  // Node version
  for (const f of ['.nvmrc', '.node-version']) {
    if (existsSync(join(root, f))) d.node = readFileSync(join(root, f), 'utf8').trim();
  }
  d.node ??= pkg.engines?.node ?? null;
  if (!d.node && existsSync(join(root, '.tool-versions'))) {
    const m = /nodejs\s+(\S+)/.exec(readFileSync(join(root, '.tool-versions'), 'utf8'));
    if (m) d.node = m[1]!;
  }

  // Router
  d.router =
    ['react-router', 'react-router-dom', '@tanstack/react-router', 'vue-router', 'wouter'].find((r) => has(deps, r)) ??
    (d.framework?.name === 'next' ? (existsSync(join(root, 'app')) || existsSync(join(root, 'src/app')) ? 'next-app-router' : 'next-pages-router') : null) ??
    (d.framework?.name === 'nuxt' ? 'nuxt-pages' : null);

  // API style
  if (['@apollo/client', 'urql', 'graphql-request', 'graphql'].some((x) => has(deps, x))) d.apiStyle.push('graphql');
  if (['@trpc/client', '@trpc/react-query'].some((x) => has(deps, x))) d.apiStyle.push('trpc');
  const specs: string[] = [];
  walk(root, 3, specs, (f) => /^(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(f) || /\.graphql$/.test(f) || f === 'schema.gql');
  d.apiSpecs = specs.map((s) => relative(root, s));
  if (d.apiSpecs.some((s) => /openapi|swagger/i.test(s))) d.apiStyle.push('rest (openapi)');
  if (!d.apiStyle.length) d.apiStyle.push('rest');

  // State and data libraries
  d.stateLibrary = ['@reduxjs/toolkit', 'redux', 'zustand', 'jotai', 'mobx', 'pinia', 'vuex', '@ngrx/store', '@tanstack/react-query', 'swr', '@apollo/client', 'xstate'].filter((x) => has(deps, x));

  // Flags
  const flagDeps: Record<string, string> = {
    'launchdarkly-js-client-sdk': 'launchdarkly',
    'launchdarkly-react-client-sdk': 'launchdarkly',
    '@launchdarkly/js-client-sdk': 'launchdarkly',
    'statsig-js': 'statsig',
    '@statsig/js-client': 'statsig',
    '@growthbook/growthbook': 'growthbook',
    '@growthbook/growthbook-react': 'growthbook',
    'unleash-proxy-client': 'unleash',
    '@unleash/proxy-client-react': 'unleash',
    '@splitsoftware/splitio': 'split',
    '@openfeature/web-sdk': 'openfeature',
    '@openfeature/react-sdk': 'openfeature',
  };
  d.flagVendor = [...new Set(Object.entries(flagDeps).filter(([k]) => has(deps, k)).map(([, v]) => v))];

  // Design system: well-known kits plus workspace packages named like a DS.
  const known = ['@mui/material', '@chakra-ui/react', 'antd', '@mantine/core', '@radix-ui/themes', 'react-bootstrap', 'vuetify', '@angular/material', 'primevue', '@shopify/polaris'];
  d.designSystem = [...known.filter((x) => has(deps, x)), ...Object.keys(deps).filter((x) => /(design-system|^@[^/]+\/ui$|\/components$|-ui$)/.test(x) && !known.includes(x))];
  if (existsSync(join(root, 'components.json')) && has(deps, 'tailwindcss')) d.designSystem.push('shadcn/ui');

  // Storybook
  const sbVersion = ver(deps, 'storybook') ?? ver(deps, '@storybook/react') ?? ver(deps, '@storybook/vue3');
  if (sbVersion || existsSync(join(root, '.storybook'))) d.storybook = { version: sbVersion, mcpAddon: has(deps, '@storybook/addon-mcp') };

  if (!d.framework) notes.push('No known framework found. Stagecraft will use the generic fallback (proxy + network mocks + reload on change).');
  if (d.framework && d.framework.tier === 3) notes.push('Tier 3 stack: best effort only.');
  return d;
}
