import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, freePort, REPO, until } from '../helpers.ts';

describe('stagecraft dev: restart and logs for agents (FR-206)', () => {
  it('restarts the dev server with new env values and serves masked logs', async () => {
    const fx = fixture('devctl');
    const [appPort, proxyPort] = [await freePort(), await freePort()];
    writeFileSync(
      join(fx.root, 'app.mjs'),
      `import http from 'node:http';
console.log('booting with API_TOKEN=' + process.env.API_TOKEN);
http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><head></head><body>COLOR=' + process.env.APP_COLOR + '</body></html>'); }).listen(${appPort});`,
    );
    writeFileSync(join(fx.root, '.env.stagecraft'), 'APP_COLOR=blue\nAPI_TOKEN=fake-123\n');
    const cfg = join(fx.root, 'stagecraft.config.ts');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace("devCommand: 'npm run dev'", "devCommand: 'node app.mjs'").replace('http://localhost:5174', `http://127.0.0.1:${appPort}`).replace('port: 4400', `port: ${proxyPort}`));
    const proc = spawn('node', [join(REPO, 'packages/cli/src/bin.ts'), 'dev'], { cwd: fx.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => (out += d));
    const base = `http://127.0.0.1:${proxyPort}`;
    try {
      await until(() => out.includes('Ready:'), 30000, 100);
      const page = () => fetch(base + '/', { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(await page()).toContain('COLOR=blue');
      writeFileSync(join(fx.root, '.env.stagecraft'), 'APP_COLOR=green\nAPI_TOKEN=fake-456\n');
      const r = await fetch(`${base}/__stagecraft/api/dev/restart`, { method: 'POST' });
      expect(await r.json()).toEqual({ status: 'restarted' });
      expect(await page()).toContain('COLOR=green');
      const logs = (await (await fetch(`${base}/__stagecraft/api/dev/logs?tail=50`)).json()).lines.join('\n');
      expect(logs).toMatch(/\[dev\] booting with API_TOKEN=\*\*\*\*/);
      expect(logs).not.toContain('fake-456');
      expect(logs).toContain('[stagecraft] restarting dev servers');
    } finally {
      process.kill(-proc.pid!, 'SIGTERM');
    }
  }, 60000);
});
