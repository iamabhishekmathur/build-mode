import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/sys/fs/cgroup';
const V2 = existsSync(join(ROOT, 'cgroup.controllers'));

export interface Limits {
  memoryMb: number;
  /** 100 = one CPU. */
  cpuPercent: number;
  pids: number;
}

/** Per-sandbox cgroup with memory, CPU and process limits (cgroup v1 or v2). */
export class Cgroup {
  readonly name: string;
  readonly dirs: string[];
  constructor(name: string) {
    this.name = name;
    this.dirs = V2 ? [join(ROOT, 'stagecraft', name)] : ['memory', 'cpu', 'pids'].map((c) => join(ROOT, c, 'stagecraft', name));
  }

  static available(): boolean {
    return V2 || (existsSync(join(ROOT, 'memory')) && existsSync(join(ROOT, 'pids')) && existsSync(join(ROOT, 'cpu')));
  }

  create(l: Limits) {
    for (const d of this.dirs) mkdirSync(d, { recursive: true });
    const bytes = String(l.memoryMb * 1024 * 1024);
    const period = 100_000;
    const quota = Math.round((l.cpuPercent / 100) * period);
    if (V2) {
      const d = this.dirs[0]!;
      writeFileSync(join(d, 'memory.max'), bytes);
      writeFileSync(join(d, 'memory.swap.max'), '0');
      writeFileSync(join(d, 'cpu.max'), `${quota} ${period}`);
      writeFileSync(join(d, 'pids.max'), String(l.pids));
    } else {
      const [mem, cpu, pids] = this.dirs as [string, string, string];
      writeFileSync(join(mem, 'memory.limit_in_bytes'), bytes);
      try {
        writeFileSync(join(mem, 'memory.memsw.limit_in_bytes'), bytes);
      } catch {
        /* swap accounting off */
      }
      writeFileSync(join(cpu, 'cpu.cfs_period_us'), String(period));
      writeFileSync(join(cpu, 'cpu.cfs_quota_us'), String(quota));
      writeFileSync(join(pids, 'pids.max'), String(l.pids));
    }
  }

  /** Files a process writes its pid to, to join every controller. */
  procsFiles(): string[] {
    return this.dirs.map((d) => join(d, 'cgroup.procs'));
  }

  pids(): number[] {
    const f = this.procsFiles()[0]!;
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(Number);
  }

  memoryBytes(): number {
    const f = V2 ? join(this.dirs[0]!, 'memory.current') : join(this.dirs[0]!, 'memory.usage_in_bytes');
    return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  }

  oomKills(): number {
    const f = V2 ? join(this.dirs[0]!, 'memory.events') : join(this.dirs[0]!, 'memory.oom_control');
    if (!existsSync(f)) return 0;
    const m = /oom_kill (\d+)/.exec(readFileSync(f, 'utf8'));
    return m ? Number(m[1]) : 0;
  }

  /** Kill every process in the group, then remove it. */
  async destroy() {
    for (let i = 0; i < 20; i++) {
      const pids = this.pids();
      if (!pids.length) break;
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const d of this.dirs) {
      try {
        rmdirSync(d);
      } catch {
        /* busy or gone */
      }
    }
  }
}
