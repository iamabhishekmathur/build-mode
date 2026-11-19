#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, Edge, FirecrackerDriver, NamespaceDriver, Orchestrator } from './index.ts';

/**
 * stagecraft-cloud: control-plane API + preview edge + egress proxy on one host.
 * Env: STAGECRAFT_MASTER_KEY (32 bytes base64), STAGECRAFT_ADMIN_TOKEN, STAGECRAFT_EDGE_SECRET,
 * STAGECRAFT_PREVIEW_DOMAIN, STAGECRAFT_DATA (default /var/lib/stagecraft), STAGECRAFT_DRIVER
 * (namespace | firecracker), STAGECRAFT_API_PORT (8080), STAGECRAFT_EDGE_PORT (8443),
 * STAGECRAFT_UPSTREAM_PROXY, STAGECRAFT_CA_FILE, STAGECRAFT_WARM_POOL.
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`stagecraft-cloud: set ${k}`);
    process.exit(1);
  }
  return v;
};
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const driver = process.env.STAGECRAFT_DRIVER === 'firecracker' ? new FirecrackerDriver() : new NamespaceDriver();
const orch = new Orchestrator({
  dataDir: process.env.STAGECRAFT_DATA ?? '/var/lib/stagecraft',
  masterKey: need('STAGECRAFT_MASTER_KEY'),
  driver,
  platform: { nodeDir: dirname(dirname(process.execPath)), stagecraftDir: repo, caFile: process.env.STAGECRAFT_CA_FILE },
  previewDomain: need('STAGECRAFT_PREVIEW_DOMAIN'),
  previewScheme: (process.env.STAGECRAFT_PREVIEW_SCHEME as 'http' | 'https') ?? 'https',
  previewPort: process.env.STAGECRAFT_PREVIEW_PUBLIC_PORT ? Number(process.env.STAGECRAFT_PREVIEW_PUBLIC_PORT) : undefined,
  edgeSecret: need('STAGECRAFT_EDGE_SECRET'),
  upstreamProxy: process.env.STAGECRAFT_UPSTREAM_PROXY,
  warmPool: Number(process.env.STAGECRAFT_WARM_POOL ?? 0),
});
await orch.start();
const api = new Api(orch, need('STAGECRAFT_ADMIN_TOKEN'));
const edge = new Edge(orch, { previewDomain: need('STAGECRAFT_PREVIEW_DOMAIN'), edgeSecret: need('STAGECRAFT_EDGE_SECRET'), secureCookies: (process.env.STAGECRAFT_PREVIEW_SCHEME ?? 'https') === 'https' });
const apiPort = await api.listen(Number(process.env.STAGECRAFT_API_PORT ?? 8080), process.env.STAGECRAFT_API_HOST ?? '127.0.0.1');
const edgePort = await edge.listen(Number(process.env.STAGECRAFT_EDGE_PORT ?? 8443));
orch.log(`API on :${apiPort}, preview edge on :${edgePort}, driver ${driver.name}`);
const stop = async () => {
  await orch.shutdown();
  await api.close();
  await edge.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
