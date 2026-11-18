import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useFlag } from '@stagecraft/react';
import { useApi, type Account, type User } from './api';
import { Dashboard } from './pages/Dashboard';
import { Payments } from './pages/Payments';
import { Onboarding } from './pages/Onboarding';
import { AgentControls } from './pages/AgentControls';
import { Assistant } from './Assistant';

const BANNERS: Record<string, { tone: string; text: string } | undefined> = {
  frozen: { tone: 'danger', text: 'This account is frozen. Payments and cards are paused while we review recent activity.' },
  over_limit: { tone: 'warning', text: 'You are over your monthly spend limit. New payments need an admin to approve them.' },
  under_review: { tone: 'info', text: 'Your account is under review. Some features may be limited for up to 2 business days.' },
};

export function App() {
  const sidebar = useFlag('new-nav', false);
  const me = useApi<User>('/api/me');
  const account = useApi<Account>('/api/account');
  const [chatOpen, setChatOpen] = useState(false);
  const banner = account.data ? BANNERS[account.data.status] : undefined;
  const nav = (
    <nav className={sidebar ? 'nav nav--side' : 'nav nav--top'} aria-label="Main">
      <span className="brand">Ledgerly</span>
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/payments">Payments</NavLink>
      <NavLink to="/onboarding">Onboarding</NavLink>
      <NavLink to="/settings/agents">Agent controls</NavLink>
      <span className="spacer" />
      <span className="me" data-testid="me">{me.data ? `${me.data.name} · ${me.data.role}` : '…'}</span>
      <button className="btn btn--ghost" onClick={() => setChatOpen((o) => !o)} aria-expanded={chatOpen}>Assistant</button>
    </nav>
  );
  return (
    <div className={sidebar ? 'shell shell--side' : 'shell'}>
      {nav}
      <main className="main">
        {banner && (
          <div role="status" className={`banner banner--${banner.tone}`} data-testid="account-banner">
            {banner.text}
          </div>
        )}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/payments" element={<Payments me={me.data} />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/settings/agents" element={<AgentControls />} />
        </Routes>
      </main>
      {chatOpen && <Assistant onClose={() => setChatOpen(false)} me={me.data} />}
    </div>
  );
}
