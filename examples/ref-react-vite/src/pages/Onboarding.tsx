import { useState } from 'react';
import { send, useApi, type User } from '../api';

const STEPS = ['Verify your email', 'Add a bank account', 'Invite your team', 'Set spend limits'];

export function Onboarding() {
  const me = useApi<User>('/api/me');
  const [busy, setBusy] = useState(false);
  if (!me.data) return <p className="muted">Loading…</p>;
  const done = me.data.onboardingStep; // steps completed
  const complete = async () => {
    setBusy(true);
    await send('POST', '/api/onboarding/complete-step');
    me.reload();
    setBusy(false);
  };
  return (
    <>
      <h1>Get set up</h1>
      <section className="card">
        {done >= STEPS.length ? (
          <p data-testid="onboarding-status">Onboarding complete.</p>
        ) : (
          <p data-testid="onboarding-status">
            Step {done + 1} of {STEPS.length}: {STEPS[done]}
          </p>
        )}
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < done ? 'steps__done' : i === done ? 'steps__current' : ''}>
              {s}
            </li>
          ))}
        </ol>
        {done < STEPS.length && (
          <button className="btn" onClick={complete} disabled={busy}>
            Complete step {done + 1}
          </button>
        )}
      </section>
    </>
  );
}
