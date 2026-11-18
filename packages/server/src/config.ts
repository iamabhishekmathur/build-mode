import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { assertTape, scenarioSlug, validateScenario, type Scenario, type StagecraftConfig, type Tape } from '@stagecraft/core';

export const CONFIG_FILES = ['stagecraft.config.ts', 'stagecraft.config.mts', 'stagecraft.config.js', 'stagecraft.config.mjs'];

export function findConfig(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const f of CONFIG_FILES) if (existsSync(join(dir, f))) return join(dir, f);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface LoadedConfig {
  file: string;
  root: string;
  config: Required<Pick<StagecraftConfig, 'port' | 'scenariosDir' | 'tapesDir' | 'dbMode' | 'unmocked'>> & StagecraftConfig;
}

export async function loadConfig(file: string): Promise<LoadedConfig> {
  // Fresh jiti instance without cache so edits to mocks reload.
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  const mod = (await jiti.import(file, { default: true })) as StagecraftConfig;
  if (!mod || typeof mod !== 'object') throw new Error(`${file} must default-export a config object (use defineConfig).`);
  const missing = (['devUrl', 'apiOrigins', 'handlers', 'seed', 'personas', 'defaultPersona'] as const).filter((k) => mod[k] === undefined);
  if (missing.length) throw new Error(`${file} is missing: ${missing.join(', ')}`);
  if (!mod.personas[mod.defaultPersona]) throw new Error(`defaultPersona "${mod.defaultPersona}" is not in personas`);
  for (const [entity, def] of Object.entries(mod.states ?? {})) {
    if (!def.states[def.default]) throw new Error(`states.${entity}.default "${def.default}" is not one of its states`);
  }
  return {
    file,
    root: dirname(file),
    config: {
      port: 4400,
      scenariosDir: 'stagecraft/scenarios',
      tapesDir: 'stagecraft/tapes',
      dbMode: 'session',
      unmocked: '404',
      ...mod,
    },
  };
}

function readJsonDir<T>(dir: string, onError: (file: string, err: Error) => void): Record<string, { file: string; value: T }> {
  const out: Record<string, { file: string; value: T }> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const file = join(dir, f);
    try {
      out[f.replace(/\.json$/, '')] = { file, value: JSON.parse(readFileSync(file, 'utf8')) };
    } catch (err) {
      onError(file, err as Error);
    }
  }
  return out;
}

export function loadScenarios(dir: string, warn: (m: string) => void): Record<string, Scenario> {
  const out: Record<string, Scenario> = {};
  for (const { file, value } of Object.values(readJsonDir<Scenario>(dir, (f, e) => warn(`Skipping ${f}: ${e.message}`)))) {
    const issues = validateScenario(value);
    if (issues.length) {
      warn(`Skipping ${file}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
      continue;
    }
    out[value.name] = value;
  }
  return out;
}

export function loadTapes(dir: string, warn: (m: string) => void): Record<string, Tape> {
  const out: Record<string, Tape> = {};
  for (const { file, value } of Object.values(readJsonDir<Tape>(dir, (f, e) => warn(`Skipping ${f}: ${e.message}`)))) {
    try {
      const t = assertTape(value);
      out[t.id] = t;
    } catch (err) {
      warn(`Skipping ${file}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function writeJson(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenarioSlug(name)}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
