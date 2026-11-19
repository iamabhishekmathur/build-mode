# Cloud runtime (`packages/cloud`)

Decision OQ-8: **build our own** sandbox layer. This package is that layer. It runs the same `stagecraft dev` process as a laptop, inside a per-session sandbox, behind a preview edge and a control-plane API.

Status:
- Built and tested: orchestration, snapshots, egress, edge and API. The tests run on a namespace driver: 13 tests in `tests/cloud`. They need root, so they skip without it.
- Not built: the microVM driver for multi-tenant production (Firecracker). The stub is in place, and the plan is below.

## Parts

| File | Role | PRD |
|---|---|---|
| `driver.ts` | `SandboxDriver` interface. `NamespaceDriver` (bubblewrap + netns + cgroups). `FirecrackerDriver` stub. | 6.7, 6.8 |
| `net.ts` | One veth pair per sandbox (`10.231.n.0/24`), no default route. nftables table `inet stagecraft`: a sandbox reaches the host on tcp/3128 only. All other traffic gets a fast reject. | NFR-101 |
| `egress.ts` | HTTP CONNECT proxy. Per-tenant allowlist (base list + `policy.egressAllow`). Ports 80/443 only, no raw IPs, every decision logged. It can chain to an upstream proxy. | NFR-101 |
| `cgroups.ts` | Memory, CPU and pids limits (cgroup v1 or v2). OOM count. Kills everything on destroy. | NFR-208 |
| `snapshots.ts` | `tenant + repo hash + lockfile hash` → tar.gz of the checkout plus `node_modules`. The second user with the same lockfile skips the install. | FR-107 |
| `orchestrator.ts` | Workspaces, sessions (start, sleep, resume, stop), warm pool, idle and wall-clock sweep, usage metering, monthly caps, strict mode, agent runs with secrets. | FR-203/204/205, NFR-201/207 |
| `edge.ts` | `https://<session>.<domain>` → sandbox. Signed login link → HttpOnly cookie → signed owner header. Wake page for sleeping sessions. `noindex`. | FR-1403, NFR-207 |
| `api.ts` | `/v1` control plane. Bearer tokens are stored as scrypt hashes. Roles are `admin` and `builder`. Cross-tenant access → 404. Audit log. | FR-1503 (metering) |
| `store.ts`, `crypto.ts` | JSON state file (mode 600, atomic writes). AES-256-GCM secrets: a per-tenant DEK, sealed by the master KEK. | NFR-102 |

Run it: `STAGECRAFT_MASTER_KEY=… STAGECRAFT_ADMIN_TOKEN=… STAGECRAFT_EDGE_SECRET=… STAGECRAFT_PREVIEW_DOMAIN=preview.example.com npx stagecraft-cloud`. The entrypoint is `src/bin.ts`.

## Request flow

```
builder ──API──▶ POST /v1/workspaces   git clone (host, no hooks) → install in sandbox (tenant egress) → snapshot
        ──API──▶ POST /v1/sessions     warm slot → restore snapshot → git checkout -B proto/<id> → stagecraft dev
                                        returns previewUrl + ownerLoginUrl (signed, short-lived)
browser ──▶ edge ──▶ sandbox:4400       owner cookie → x-stagecraft-edge = ts.HMAC(session key)
                                        no cookie → remote client → only share-link viewer sessions work
idle 30 min ──▶ sleep                   GET /state/export → state.json, tear down sandbox, close usage
link opened ──▶ resume                  restore + boot + POST /state/import, wake page meanwhile
```

## Threat model

Who can attack what, and how we stop it.

1. **The customer's code and its install scripts are hostile.** They run as uid 1000 in user, pid, ipc, uts and net namespaces with `--cap-drop ALL`. System dirs are read-only. `/etc/shadow`, `/etc/sudoers*` and `/etc/ssh` are masked. `/tmp` is private. They have no route out; egress goes through the proxy and its allowlist only. On the host, git runs with hooks and fsmonitor off, and tar extracts with `--no-same-owner`.
2. **One tenant attacks another.** Each tenant has its own token namespace, store records and egress allowlist. Each sandbox has its own network, and sandboxes cannot reach each other (test: `b.ip:80` refused). The API returns 404 for another tenant's IDs.
3. **A stranger with the preview URL.** They have no owner cookie, so the sandbox sees a remote client. Only share-link viewer sessions work for them (explore and comment). A client-sent `x-stagecraft-edge` header is removed. The owner header is an HMAC over a per-session key, so a spoofed one fails.
4. **Secrets.** Secrets are encrypted at rest (envelope encryption). They go into the agent's process env only, never argv (test: not visible in `/proc/*/cmdline`). Agent output is redacted.
5. **Runaway cost.** Memory, CPU and pids limits are set per sandbox. Idle and wall-clock caps apply. Each tenant has a monthly minutes cap (402) with an 80% alert. Strict mode refuses cloud sessions (403).

**The namespace driver is not a multi-tenant boundary.** It shares the host kernel, so one kernel bug escapes it. `multiTenantSafe = false` marks this. Use it for single-tenant or self-hosted installs, and for CI. Multi-tenant production needs the microVM driver.

## Firecracker driver (next)

This container has no `/dev/kvm`, so the driver is not built or tested here. It plugs in behind the same `SandboxDriver` interface. The orchestrator, edge, API and tests need no change.

- **Jailer:**
  - one jailer per VM: chroot, its own uid/gid, seccomp, and a cgroup that `cgroups.ts` already manages;
  - the KVM process is the only thing on the host side.
- **Rootfs:**
  - a read-only ext4 base image (Node LTS, git, Chromium, agent CLIs, `/opt/stagecraft`);
  - a per-VM overlay;
  - the workspace snapshot as a second block device, so tar restore goes away.
- **Network:**
  - a tap device per VM, which replaces the veth;
  - the same `10.231.n.0/24` plan and the same nftables rules.
- **Exec:**
  - a small guest agent on vsock (exec, env, cwd, stdout/stderr streams);
  - it implements `Sandbox.exec`, and secrets go over vsock.
- **Warm starts:**
  - Firecracker snapshot/restore of a booted VM with `stagecraft` preloaded;
  - published numbers are about 125 ms boot and less than 5 MiB overhead per VM (Firecracker docs);
  - I have not measured them here.
- **Fleet (NFR-208, 2,000 concurrent):**
  - bare-metal hosts (KVM in nested cloud VMs is slow or not available);
  - a scheduler that bin-packs by memory;
  - one orchestrator per host plus a central store. Replace the JSON store with Postgres.

## Measured here (namespace driver, small fixture repo)

| Metric | Result | Target |
|---|---|---|
| Snapshot build | ~0.9 s | — |
| Snapshot reuse (same lockfile) | ~17 ms | FR-107 |
| Session start, warm | p50 ~830 ms | NFR-201 ≤ 20 s |
| Resume via link | ~1.0 s | NFR-207 |

Caveat: the fixture has one dependency. A real repo has a 300 MB+ `node_modules`, so tar restore will dominate. That is why the Firecracker plan uses block-device snapshots.

## Long poles (not code)

- A bare-metal fleet with KVM.
- A third-party pen test of this layer (NFR-108) before any multi-tenant beta.
- SOC 2 controls for the KEK. Move the master key to a KMS or HSM. Today it comes from env.
