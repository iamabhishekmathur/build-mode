import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Privileged binaries by absolute path: never trust PATH (node_modules/.bin can shadow them:
 * @vercel/nft ships an `nft` CLI).
 */
const BIN: Record<string, string> = { ip: '/usr/sbin/ip', nft: '/usr/sbin/nft' };
const run = (cmd: string, args: string[]) => execFileSync(BIN[cmd] ?? cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });

/** Address plan: sandbox n gets 10.231.n.0/24; host side .1, sandbox side .2. */
export function addrs(n: number) {
  if (n < 1 || n > 250) throw new Error('sandbox slot out of range');
  return { host: `10.231.${n}.1`, sandbox: `10.231.${n}.2`, hostIf: `scv${n}`, netns: `sc-n${n}` };
}

export const EGRESS_PORT = 3128;

/**
 * Host firewall (nftables), installed once (reject, not drop: tools in the sandbox fail fast with a clear error):
 * - from sandboxes, only the egress proxy port on the host is reachable;
 * - no forwarding from sandboxes at all (no internet, no sandbox-to-sandbox);
 * - the host can open connections into sandboxes (edge → sandbox proxy).
 */
export function installFirewall(egressPort = EGRESS_PORT) {
  const rules = `
table inet stagecraft {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "scv*" ct state established,related accept
    iifname "scv*" tcp dport ${egressPort} accept
    iifname "scv*" counter reject
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "scv*" counter reject
    oifname "scv*" counter drop
  }
}`;
  try {
    run('nft', ['delete', 'table', 'inet', 'stagecraft']);
  } catch {
    /* not there yet */
  }
  // Some nft builds refuse /dev/stdin: use a private temp file.
  const dir = mkdtempSync(join(tmpdir(), 'sc-nft-'));
  try {
    writeFileSync(join(dir, 'rules.nft'), rules, { mode: 0o600 });
    run('nft', ['-f', join(dir, 'rules.nft')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function firewallCounters(): string {
  try {
    return run('nft', ['list', 'table', 'inet', 'stagecraft']);
  } catch {
    return '';
  }
}

/** A network namespace with one veth pair to the host and no default route out. */
export function createNet(n: number) {
  const a = addrs(n);
  destroyNet(n);
  run('ip', ['netns', 'add', a.netns]);
  run('ip', ['link', 'add', a.hostIf, 'type', 'veth', 'peer', 'name', `${a.hostIf}p`]);
  run('ip', ['link', 'set', `${a.hostIf}p`, 'netns', a.netns]);
  run('ip', ['addr', 'add', `${a.host}/24`, 'dev', a.hostIf]);
  run('ip', ['link', 'set', a.hostIf, 'up']);
  const ns = (...args: string[]) => run('ip', ['netns', 'exec', a.netns, 'ip', ...args]);
  ns('link', 'set', `${a.hostIf}p`, 'name', 'eth0');
  ns('addr', 'add', `${a.sandbox}/24`, 'dev', 'eth0');
  ns('link', 'set', 'eth0', 'up');
  ns('link', 'set', 'lo', 'up');
  // Deliberately no default route: the only reachable host is the /24 peer (the egress proxy).
  return a;
}

export function destroyNet(n: number) {
  const a = addrs(n);
  try {
    run('ip', ['link', 'del', a.hostIf]);
  } catch {
    /* gone */
  }
  try {
    run('ip', ['netns', 'del', a.netns]);
  } catch {
    /* gone */
  }
}

export function netAvailable(): boolean {
  try {
    run('ip', ['-V']);
    run('nft', ['--version']);
    return process.getuid?.() === 0;
  } catch {
    return false;
  }
}
