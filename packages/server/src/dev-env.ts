import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Env names that look like production secrets. Never passed to the dev server. */
export const SECRET_DENYLIST = /^(?:.*_)?(?:PROD|PRODUCTION)_|DATABASE_URL|_SECRET$|_SECRET_KEY$|PRIVATE_KEY|AWS_SECRET|STRIPE_SECRET/i;

export function preloadUrl(): string {
  try {
    return import.meta.resolve('@stagecraft/server/preload');
  } catch {
    return pathToFileURL(createRequire(import.meta.url).resolve('@stagecraft/server/preload')).href;
  }
}

/**
 * Environment for a dev server behind the Stagecraft proxy:
 * no secret-looking vars, STAGECRAFT=1, and the server-side fetch interceptor (SSR/RSC).
 */
export function devServerEnv(opts: { proxyUrl: string; apiOrigins: string[]; base?: NodeJS.ProcessEnv; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.base ?? process.env)) if (v !== undefined && !SECRET_DENYLIST.test(k)) env[k] = v;
  Object.assign(env, opts.extra ?? {});
  const imp = `--import ${preloadUrl()}`;
  env.NODE_OPTIONS = env.NODE_OPTIONS?.includes('stagecraft') ? env.NODE_OPTIONS : `${env.NODE_OPTIONS ?? ''} ${imp}`.trim();
  env.STAGECRAFT = '1';
  env.VITE_STAGECRAFT = '1';
  env.NEXT_PUBLIC_STAGECRAFT = '1';
  env.STAGECRAFT_PROXY = opts.proxyUrl;
  env.STAGECRAFT_API_ORIGINS = JSON.stringify(opts.apiOrigins);
  return env;
}
