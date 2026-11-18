export interface CheckResult {
  id: string;
  pass: boolean;
  detail?: string;
}

export interface AgentMetrics {
  ok: boolean;
  turns: number | null;
  costUsd: number | null;
  durationMs: number;
  toolCalls: number;
  toolsUsed: Record<string, number>;
  skillsUsed: string[];
  screenshots: number;
  permissionDenials: string[];
  mcpConnected: boolean;
  finalMessage: string;
  timedOut: boolean;
}

export interface TaskResult {
  taskId: string;
  title: string;
  category: string;
  pass: boolean;
  checks: CheckResult[];
  agent: AgentMetrics;
  changedFiles: Record<string, string[]>;
  doctorWarnings: string[];
  screenshots: string[];
  workdir: string;
  startedAt: string;
}
