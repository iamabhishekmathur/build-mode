import { findConfig, loadConfig } from '@stagecraft/server';

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Share links are made by people from the CLI or panel, never by the agent (NFR-109). */
export async function shareCommand(cwd: string, sub: string | undefined, args: string[], log: (m: string) => void): Promise<number> {
  const file = findConfig(cwd);
  if (!file) throw new Error('No stagecraft.config.ts');
  const { config } = await loadConfig(file);
  const base = process.env.STAGECRAFT_URL ?? `http://127.0.0.1:${config.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/__stagecraft/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (!r) throw new Error(`The proxy is not running at ${base}. Start "npx --no stagecraft dev".`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  if (sub === 'list') {
    for (const s of await call('GET', '/shares')) log(`${s.id}  ${s.active ? 'active ' : 'inactive'}  ${s.path}  ${s.expiresAt ? `expires ${s.expiresAt}` : 'no expiry'}${s.hasPassword ? '  password' : ''}${s.revoked ? '  revoked' : ''}  ${base}/__stagecraft/s/${s.token}`);
    return 0;
  }
  if (sub === 'revoke') {
    const id = args[0];
    if (!id) throw new Error('Usage: stagecraft share revoke <id>');
    await call('DELETE', `/shares/${id}`);
    log(`Revoked ${id}. Viewers lose access at their next request.`);
    return 0;
  }
  const out = await call('POST', '/shares', { path: flag(args, '--path') ?? sub, expires: flag(args, '--expires'), password: flag(args, '--password'), label: flag(args, '--label') });
  log(`${base}${out.url}`);
  log(`Expires: ${out.expiresAt ?? 'never'}${out.password ? ' · password protected' : ''}`);
  log('Viewers get their own copy of this view: they can switch states and comment, not change files.');
  log(config.sharing?.publicLinks === false ? '' : 'The proxy listens on 127.0.0.1. For others to open the link, run "stagecraft dev --host 0.0.0.0" (or a tunnel). Only share-link sessions are reachable from other machines.');
  return 0;
}
