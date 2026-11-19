import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

const STORAGE_KEY = 'customer_ai_web_session';

function money(amount, currency = 'GHS') {
  return `${currency === 'GHS' ? 'GH₵' : currency}${Number(amount || 0).toFixed(2)}`;
}

export default function WebChat() {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState([]);
  const [order, setOrder] = useState(null);
  const [requiresHuman, setRequiresHuman] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        let id = localStorage.getItem(STORAGE_KEY);
        if (!id) {
          const created = await api('/webchat/session', { method: 'POST', body: JSON.stringify({}) });
          id = created.sessionId;
          localStorage.setItem(STORAGE_KEY, id);
        }
        if (cancelled) return;
        setSessionId(id);
        const history = await api(`/webchat/history?session_id=${encodeURIComponent(id)}`);
        if (cancelled) return;
        setMessages(history.messages || []);
        setOrder(history.order || null);
        setRequiresHuman(Boolean(history.requiresHuman));
      } catch {
        if (!cancelled) setError('Could not start the chat. Please refresh and try again.');
      }
    }
    start();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  // A human may answer from the dashboard after handoff. Poll the shared
  // conversation history so their reply appears here without a page refresh.
  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = setInterval(async () => {
      if (busy) return;
      try {
        const history = await api(`/webchat/history?session_id=${encodeURIComponent(sessionId)}`);
        setMessages(history.messages || []);
        setOrder(history.order || null);
        setRequiresHuman(Boolean(history.requiresHuman));
      } catch { /* keep the current transcript on a transient error */ }
    }, 7000);
    return () => clearInterval(timer);
  }, [sessionId, busy]);

  async function send(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || !sessionId || busy) return;
    setInput('');
    setError('');
    setBusy(true);
    setMessages((current) => [...current, { direction: 'INBOUND', senderType: 'CUSTOMER', content: text }]);
    try {
      const result = await api('/webchat/message', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
          message_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        }),
      });
      if (result.reply) {
        setMessages((current) => [...current, { direction: 'OUTBOUND', senderType: 'AI', content: result.reply }]);
      }
      setOrder(result.order || null);
      setRequiresHuman(Boolean(result.requiresHuman));
    } catch (err) {
      setError(err.message || 'The message could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f6f3ec', display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 620, background: '#fff', borderRadius: 18, boxShadow: '0 12px 40px rgba(20,20,20,.12)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #eee' }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#1f7a4d', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700 }}>AI</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>Customer AI</div>
            <div style={{ fontSize: 12, color: '#666' }}>Order assistant · replies instantly</div>
          </div>
          <Link to="/" style={{ fontSize: 13, color: '#1f7a4d' }}>Home</Link>
        </header>

        <div style={{ flex: 1, minHeight: 360, maxHeight: '60vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10, background: '#faf9f6' }}>
          {messages.length === 0 && !error && (
            <div style={{ margin: 'auto', color: '#777', textAlign: 'center', fontSize: 14 }}>
              Ask about the menu, prices, or place an order.
            </div>
          )}
          {messages.map((message, index) => {
            const mine = message.direction === 'INBOUND';
            return (
              <div key={`${index}-${message.createdAt || ''}`} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{
                  background: mine ? '#1f7a4d' : '#fff',
                  color: mine ? '#fff' : '#222',
                  border: mine ? 'none' : '1px solid #e6e2d8',
                  padding: '10px 13px',
                  borderRadius: 14,
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.45,
                  fontSize: 14,
                }}>{message.content}</div>
              </div>
            );
          })}
          {busy && <div style={{ alignSelf: 'flex-start', color: '#777', fontSize: 13 }}>Customer AI is typing…</div>}
          {order?.paymentUrl && (
            <div style={{ alignSelf: 'flex-start', background: '#fff', border: '1px solid #d9e7df', borderRadius: 14, padding: 14, maxWidth: '90%' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Order {order.reference}</div>
              <div style={{ fontSize: 13, color: '#555', marginBottom: 4 }}>{order.items?.map((item) => `${item.quantity} × ${item.name}`).join(', ')}</div>
              <div style={{ fontSize: 14, marginBottom: 10 }}>Total {money(order.amount, order.currency)} · {order.status}</div>
              <a href={order.paymentUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', background: '#1f7a4d', color: '#fff', padding: '9px 14px', borderRadius: 10, fontWeight: 600, textDecoration: 'none' }}>
                {order.status === 'PAID' ? 'View receipt' : 'Pay with Paystack'}
              </a>
            </div>
          )}
          {requiresHuman && (
            <div style={{ alignSelf: 'center', background: '#fff4e5', border: '1px solid #f0d3a7', color: '#8a5a12', padding: '8px 12px', borderRadius: 10, fontSize: 13 }}>
              A team member has been asked to help with this conversation.
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && <div style={{ padding: '10px 20px', color: '#a12', fontSize: 13 }}>{error}</div>}

        <form onSubmit={send} style={{ display: 'flex', gap: 10, padding: 16, borderTop: '1px solid #eee' }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={requiresHuman ? 'A team member will reply here…' : 'Type your message…'}
            aria-label="Message"
            style={{ flex: 1, padding: '12px 14px', borderRadius: 12, border: '1px solid #d8d4ca', fontSize: 14, outline: 'none' }}
          />
          <button type="submit" disabled={busy || !input.trim()} style={{ background: '#1f7a4d', color: '#fff', border: 0, borderRadius: 12, padding: '0 18px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy || !input.trim() ? 0.6 : 1 }}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
