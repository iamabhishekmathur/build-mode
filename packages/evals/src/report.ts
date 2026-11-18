import { relative } from 'node:path';
import type { TaskResult } from './types.ts';

export function report(results: TaskResult[], outDir: string): string {
  const total = results.reduce((s, r) => s + (r.agent.costUsd ?? 0), 0);
  const lines = [
    `# Eval run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Agent: Claude Code (headless, \`claude -p\`). One run per task: no confidence intervals (PRD 14.9 needs ≥3 runs).`,
    '',
    '| Task | Pass | Checks | Turns | Time | Cost | Tools | Self-check shots | Denied |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const ok = r.checks.filter((c) => c.pass).length;
      return `| ${r.taskId} ${r.title} | ${r.pass ? '✅' : '❌'} | ${ok}/${r.checks.length} | ${r.agent.turns ?? '–'} | ${Math.round(r.agent.durationMs / 1000)} s | $${(r.agent.costUsd ?? 0).toFixed(2)} | ${r.agent.toolCalls} | ${r.agent.screenshots} | ${r.agent.permissionDenials.length} |`;
    }),
    '',
    `Total agent cost: $${total.toFixed(2)}.`,
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.taskId}: ${r.title}`, '');
    lines.push(`Category ${r.category}. MCP connected: ${r.agent.mcpConnected ? 'yes' : '**no**'}. Skills used: ${r.agent.skillsUsed.join(', ') || 'none'}.${r.agent.timedOut ? ' **Timed out.**' : ''}`, '');
    for (const c of r.checks) lines.push(`- ${c.pass ? '✅' : '❌'} ${c.id}${c.detail ? ` — ${c.detail.replace(/\n/g, ' ')}` : ''}`);
    lines.push('', `Changed files: ${Object.entries(r.changedFiles).map(([n, f]) => `${n}: ${f.length}`).join(', ')}.`);
    const tools = Object.entries(r.agent.toolsUsed).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('mcp__stagecraft__', 'sc:')}×${v}`);
    lines.push(`Tool use: ${tools.join(', ')}.`);
    if (r.agent.permissionDenials.length) lines.push('', 'Permission denials:', ...r.agent.permissionDenials.map((d) => `- \`${d.replace(/`/g, "'")}\``));
    if (r.doctorWarnings.length) lines.push('', 'Doctor warnings:', ...r.doctorWarnings.map((w) => `- ${w.split('\n')[0]}`));
    lines.push('', 'Screenshots: ' + r.screenshots.map((s) => `[${relative(outDir, s)}](${relative(outDir, s)})`).join(', '), '');
    lines.push('<details><summary>Agent final message</summary>', '', r.agent.finalMessage.trim(), '', '</details>', '');
  }
  return lines.join('\n');
}
