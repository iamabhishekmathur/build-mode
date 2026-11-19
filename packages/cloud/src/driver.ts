import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { Cgroup, type Limits } from './cgroups.ts';
import { createNet, destroyNet } from './net.ts';

export interface MountSpec {
  host: string;
  sandbox: string;
  writable?: boolean;
}

export interface SandboxSpec {
  id: string;
  /** Network slot 1..250 (address plan in net.ts). */
  slot: number;
  limits: Limits;
  /** Host folder mounted read-write at /workspace. */
  workspace: string;
  /** Extra read-only mounts (platform tools: Node, Stagecraft, browsers, CA bundle). */
  mounts: MountSpec[];
  env: Record<string, string>;
}

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Extra env visible only to this process (agent API keys). */
  secretEnv?: Record<string, string>;
}

export interface Sandbox {
  id: string;
  ip: string;
  hostIp: string;
  exec(cmd: string[], opts?: ExecOptions): ChildProcess;
  stats(): { memoryBytes: number; pids: number; oomKills: number };
  destroy(): Promise<void>;
}

export interface SandboxDriver {
  name: string;
  /** True when this driver isolates tenants with separate kernels (PRD 6.8). */
  multiTenantSafe: boolean;
  available(): { ok: boolean; reason?: string };
  create(spec: SandboxSpec): Promise<Sandbox>;
}

/** System paths every sandbox gets read-only. Nothing from /root or /home. */
const SYSTEM_RO = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc'];
/** Files under /etc that must not be visible. */
const MASK = ['/etc/shadow', '/etc/gshadow', '/etc/ssh', '/etc/sudoers', '/etc/sudoers.d'];

/**
 * Linux namespaces + cgroups + bubblewrap.
 * - PID, mount, IPC, UTS, user and network namespaces; runs as an unprivileged uid with no capabilities.
 * - Root filesystem: read-only system dirs + declared platform mounts + /workspace + tmpfs /tmp.
 * - Network: own netns, one veth to the host, no default route; nftables lets it reach only the egress proxy.
 * - cgroup limits on memory (no swap), CPU and processes.
 *
 * Shares the host kernel. Good for development, single-tenant and self-hosted pools; NOT the
 * multi-tenant isolation the PRD requires (no shared kernel between tenants): use the Firecracker driver.
 */
export class NamespaceDriver implements SandboxDriver {
  name = 'namespace';
  multiTenantSafe = false;

  available() {
    if (process.getuid?.() !== 0) return { ok: false, reason: 'needs root (netns, cgroups, nftables)' };
    for (const bin of ['/usr/bin/bwrap', '/usr/sbin/ip', '/usr/sbin/nft']) if (!existsSync(bin)) return { ok: false, reason: `missing ${bin}` };
    if (!Cgroup.available()) return { ok: false, reason: 'cgroups not available' };
    return { ok: true };
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const a = createNet(spec.slot);
    const cg = new Cgroup(spec.id);
    cg.create(spec.limits);
    const children = new Set<ChildProcess>();

    const exec = (cmd: string[], opts: ExecOptions = {}): ChildProcess => {
      const env = { ...spec.env, ...(opts.env ?? {}), ...(opts.secretEnv ?? {}) };
      const bw: string[] = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-user', '--uid', '1000', '--gid', '1000', '--hostname', 'sandbox', '--cap-drop', 'ALL'];
      for (const p of SYSTEM_RO) if (existsSync(p)) bw.push('--ro-bind', p, p);
      for (const p of MASK) if (existsSync(p)) bw.push(...(statSync(p).isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
      for (const m of spec.mounts) bw.push(m.writable ? '--bind' : '--ro-bind', m.host, m.sandbox);
      bw.push('--bind', spec.workspace, '/workspace', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--chdir', opts.cwd ?? '/workspace');
      // Env goes through the process environment, never argv: argv is readable in /proc/<pid>/cmdline.
      // The spawn env is exactly this object (nothing inherited from the host).
      const childEnv: Record<string, string> = { HOME: '/tmp', USER: 'sandbox', ...env };
      // Join the cgroup first, then enter the network namespace, then bubblewrap.
      const join = cg.procsFiles().map((f) => `echo $$ > ${f}`).join(' && ');
      const child = spawn('/bin/sh', ['-c', `${join} && exec /usr/sbin/ip netns exec ${a.netns} /usr/bin/bwrap "$@"`, 'sandbox', ...bw, ...cmd], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: childEnv });
      children.add(child);
      child.on('exit', () => children.delete(child));
      return child;
    };

    return {
      id: spec.id,
      ip: a.sandbox,
      hostIp: a.host,
      exec,
      stats: () => ({ memoryBytes: cg.memoryBytes(), pids: cg.pids().length, oomKills: cg.oomKills() }),
      destroy: async () => {
        await cg.destroy();
        for (const c of children) c.kill('SIGKILL');
        destroyNet(spec.slot);
      },
    };
  }
}

/**
 * Firecracker microVMs (PRD 6.8: no shared kernel between tenants). Not implemented here:
 * this machine has no /dev/kvm. The interface is the same; see docs/cloud.md for the plan
 * (jailer, rootfs image with Node + Stagecraft, virtio-net tap per VM in the same address
 * plan, vsock exec agent, snapshot/restore for the warm pool).
 */
export class FirecrackerDriver implements SandboxDriver {
  name = 'firecracker';
  multiTenantSafe = true;
  available() {
    if (!existsSync('/dev/kvm')) return { ok: false, reason: 'no /dev/kvm on this host (nested virtualization off)' };
    return { ok: false, reason: 'Firecracker driver not implemented yet (see docs/cloud.md)' };
  }
  async create(): Promise<Sandbox> {
    throw new Error(this.available().reason);
  }
}
