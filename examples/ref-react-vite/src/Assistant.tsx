import { useEffect, useRef, useState } from 'react';
import { money, send, useApi, type Payment, type User } from './api';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; id: string; text: string; partial?: boolean }
  | { kind: 'tool'; id: string; name: string; done: boolean; error?: boolean }
  | { kind: 'action'; id: string; title: string; data: { paymentId: string; vendor: string; amount: number } }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string };

type Status = 'connecting' | 'live' | 'timeout' | 'done' | 'error';

/** The product's chat transport: SSE from /api/assistant/stream. Stagecraft tapes mock it. */
function useAssistantStream() {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStatus('connecting');
    const es = new EventSource('/api/assistant/stream');
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      switch (e.type) {
        case 'hello':
          setItems([]);
          setStatus('live');
          break;
        case 'user_message':
          setItems((xs) => [...xs, { kind: 'user', text: e.text }]);
          break;
        case 'message_start':
          setItems((xs) => [...xs, { kind: 'assistant', id: e.id, text: '' }]);
          break;
        case 'token':
          setItems((xs) => xs.map((x) => (x.kind === 'assistant' && x.id === e.id ? { ...x, text: x.text + e.text } : x)));
          break;
        case 'message_end':
          setItems((xs) => xs.map((x) => (x.kind === 'assistant' && x.id === e.id ? { ...x, partial: e.partial } : x)));
          break;
        case 'tool_call':
          setItems((xs) => [...xs, { kind: 'tool', id: e.id, name: e.name, done: false }]);
          break;
        case 'tool_result':
          setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, done: true, error: e.isError } : x)));
          break;
        case 'pending_action':
          setItems((xs) => [...xs, { kind: 'action', id: e.id, title: e.title, data: e.data }]);
          break;
        case 'error':
          setItems((xs) => [...xs, { kind: 'error', text: e.message }]);
          break;
        case 'timeout':
          if (e.replay) setItems((xs) => [...xs, { kind: 'notice', text: 'A request timed out and was retried.' }]);
          else {
            setStatus('timeout');
            es.close();
          }
          break;
        case 'done':
          setStatus('done');
          break;
      }
    };
    es.onerror = () => {
      setStatus((s) => (s === 'timeout' ? s : 'error'));
      es.close();
    };
    return () => es.close();
  }, [attempt]);
  return { items, status, retry: () => setAttempt((a) => a + 1) };
}

function ActionCard({ item, me }: { item: Extract<Item, { kind: 'action' }>; me: User | null }) {
  const payments = useApi<Payment[]>('/api/payments');
  const [err, setErr] = useState<string | null>(null);
  const p = payments.data?.find((x) => x.id === item.data.paymentId);
  const act = (verb: 'approve' | 'reject') => send('POST', `/api/payments/${item.data.paymentId}/${verb}`).catch((e: Error) => setErr(e.message));
  return (
    <div className="chat__action" data-testid="pending-action">
      <strong>{item.title}</strong>
      <span className="muted">{item.data.vendor} · {money(item.data.amount)}</span>
      {p?.status === 'approved' ? (
        <span className="pill pill--approved">approved</span>
      ) : p?.status === 'rejected' ? (
        <span className="pill pill--rejected">rejected</span>
      ) : me?.role === 'admin' ? (
        <span className="actions">
          <button className="btn" onClick={() => act('approve')}>Approve</button>
          <button className="btn btn--ghost" onClick={() => act('reject')}>Reject</button>
        </span>
      ) : (
        <span className="muted">Waiting for an admin</span>
      )}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

export function Assistant({ onClose, me }: { onClose: () => void; me: User | null }) {
  const { items, status, retry } = useAssistantStream();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, and React rejects non-function cleanups.
    end.current?.scrollIntoView({ block: 'end' });
  }, [items]);
  return (
    <aside className="chat" aria-label="Assistant" data-testid="assistant">
      <header className="chat__head">
        <strong>Assistant</strong>
        <button className="btn btn--ghost" onClick={onClose} aria-label="Close assistant">✕</button>
      </header>
      <div className="chat__body" aria-live="polite">
        {items.length === 0 && status !== 'timeout' && <p className="muted">Ask about payments, cards or spend.</p>}
        {items.map((it, i) => {
          switch (it.kind) {
            case 'user':
              return <div key={i} className="chat__msg chat__msg--user">{it.text}</div>;
            case 'assistant':
              return (
                <div key={i} className="chat__msg" data-testid="assistant-message">
                  {it.text}
                  {it.partial && <span className="muted"> …</span>}
                </div>
              );
            case 'tool':
              return <div key={i} className="chat__tool">{it.done ? (it.error ? '✕' : '✓') : '…'} {it.name.replace('_', ' ')}</div>;
            case 'action':
              return <ActionCard key={i} item={it} me={me} />;
            case 'error':
              return <div key={i} role="alert" className="chat__error" data-testid="assistant-error">{it.text}</div>;
            case 'notice':
              return <div key={i} className="chat__notice">{it.text}</div>;
          }
        })}
        {status === 'timeout' && (
          <div className="chat__error" role="alert" data-testid="assistant-timeout">
            The assistant took too long to answer.{' '}
            <button className="btn" onClick={retry}>Retry</button>
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="chat__input" onSubmit={(e) => e.preventDefault()}>
        <input aria-label="Message" placeholder="Message the assistant" />
        <button className="btn">Send</button>
      </form>
    </aside>
  );
}
