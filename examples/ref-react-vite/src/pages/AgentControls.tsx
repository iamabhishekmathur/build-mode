import { Variant } from '@stagecraft/react';
import { AGENTS_API, money, send, useApi, type Agent } from '../api';

function Toggle({ agent }: { agent: Agent }) {
  const next = agent.status === 'active' ? 'paused' : 'active';
  return (
    <button className="btn btn--ghost" onClick={() => send('PATCH', `${AGENTS_API}/api/agents/${agent.id}`, { status: next })}>
      {agent.status === 'active' ? 'Pause' : 'Resume'}
    </button>
  );
}

function AgentTable({ agents }: { agents: Agent[] }) {
  return (
    <table className="table" data-testid="agents-table">
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Can do</th>
          <th scope="col">Spend limit</th>
          <th scope="col">Status</th>
          <th scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.id}>
            <td>{a.name}</td>
            <td className="muted">{a.scope}</td>
            <td className="num">{money(a.spendLimit)}</td>
            <td><span className={`pill pill--${a.status}`}>{a.status}</span></td>
            <td><Toggle agent={a} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentCards({ agents }: { agents: Agent[] }) {
  return (
    <div className="cards" data-testid="agents-cards">
      {agents.map((a) => (
        <article key={a.id} className="card">
          <h3>{a.name}</h3>
          <p className="muted">{a.scope}</p>
          <p>Limit {money(a.spendLimit)} · <span className={`pill pill--${a.status}`}>{a.status}</span></p>
          <Toggle agent={a} />
        </article>
      ))}
    </div>
  );
}

export function AgentControls() {
  const { data, error } = useApi<Agent[]>(`${AGENTS_API}/api/agents`);
  if (error) return <p className="error">Could not load agents: {error}</p>;
  if (!data) return <p className="muted">Loading agents…</p>;
  return (
    <>
      <h1>Agent controls</h1>
      <p className="muted">Decide what each AI agent can do with your money.</p>
      {data.length === 0 ? (
        <section className="card empty" data-testid="agents-empty">
          <h2>No agents connected</h2>
          <p>Connect an agent to let it read transactions or draft payments. You set the limits.</p>
          <button className="btn">Connect an agent</button>
        </section>
      ) : (
        <Variant name="agent-list-layout" options={{ table: <AgentTable agents={data} />, cards: <AgentCards agents={data} /> }} />
      )}
    </>
  );
}
