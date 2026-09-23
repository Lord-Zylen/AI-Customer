import { ArrowUpRight, Bot, MessagesSquare, ShieldAlert, Smartphone, CheckCircle2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Badge, EmptyState, ErrorState, KpiCard, PageHeading, Panel, Skeleton, StatusPill } from '../components/UI';
import { api } from '../services/api';
import { shortDate, timeAgo } from '../lib/format';

const statusTone = s =>
  s === 'HUMAN_REQUIRED' ? 'danger' : s === 'RESOLVED' ? 'green' : 'purple';

export default function Dashboard() {
  const navigate = useNavigate();
  const [convos, setConvos] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [sys, setSys] = useState({});
  const [wa, setWa] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [c, cu, s, w] = await Promise.all([
        api('/conversations'),
        api('/customers').catch(() => []),
        api('/system/status').catch(() => ({})),
        api('/whatsapp/status').catch(() => ({})),
      ]);
      setConvos(c || []);
      setCustomers(cu || []);
      setSys(s || {});
      setWa(w || {});
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const waiting = convos.filter(c => c.requiresHuman || c.status === 'HUMAN_REQUIRED');
  const active = convos.filter(c => c.aiEnabled && c.status !== 'RESOLVED');
  const resolved = convos.filter(c => c.status === 'RESOLVED');
  const recent = [...convos].sort((a, b) => new Date(b.lastMessageAt || b.updatedAt) - new Date(a.lastMessageAt || a.updatedAt)).slice(0, 8);

  const waConnected = wa.status === 'CONNECTED';
  const aiOk = ['CONNECTED', 'CONFIGURED'].includes(sys.groq);

  return (
    <>
      <PageHeading
        eyebrow="OVERVIEW"
        title="Dashboard"
        description="Your AI customer-service operations at a glance."
      />

      {error && <ErrorState description={error} onRetry={load} />}

      <div className="kpi-grid">
        <KpiCard label="Conversations" value={convos.length} loading={loading} hint={`${customers.length} customers recorded`} icon={<MessagesSquare size={17} />} tone="violet" />
        <KpiCard label="AI active" value={active.length} loading={loading} hint="Automated, high-confidence" icon={<Bot size={17} />} tone="blue" />
        <KpiCard label="Waiting for human" value={waiting.length} loading={loading} hint="Need your review" icon={<ShieldAlert size={17} />} tone={loading ? 'orange' : (waiting.length ? 'red' : 'green')} />
        <KpiCard label="Resolved" value={resolved.length} loading={loading} hint="Closed conversations" icon={<CheckCircle2 size={17} />} tone="green" />
      </div>

      <div className="dash-grid">
        <Panel
          className="dash-recent"
          title="Recent conversations"
          description="Latest activity across your workspace."
          action={<Link className="panel-link" to="/conversations">View all <ArrowUpRight size={14} /></Link>}
        >
          {loading ? (
            <div className="row-list">{Array.from({ length: 5 }).map((_, i) => <div className="row-loading" key={i}><Skeleton width={40} height={40} className="skeleton-round" /><div style={{ flex: 1 }}><Skeleton width="55%" /><Skeleton width="80%" height={12} /></div><Skeleton width={52} height={12} /></div>)}</div>
          ) : recent.length === 0 ? (
            <EmptyState icon={<MessagesSquare size={24} />} title="No conversations yet" description="Incoming WhatsApp messages will appear here as soon as the Hermes gateway is running." action={<Link className="button" to="/whatsapp">Open WhatsApp page</Link>} />
          ) : (
            <div className="row-list">
              {recent.map(c => (
                <button className="row-item" key={c._id} onClick={() => navigate(`/conversations/${c._id}`)}>
                  <Avatar name={c.customerId?.name} size="md" />
                  <div className="row-item-main">
                    <div className="row-item-top"><strong>{c.customerId?.name || 'Customer'}</strong><span className="row-time">{timeAgo(c.lastMessageAt || c.updatedAt)}</span></div>
                    <div className="row-item-sub">
                      <Badge tone={statusTone(c.status)}>{c.requiresHuman ? 'HUMAN' : c.aiEnabled ? 'AI' : 'PAUSED'}</Badge>
                      <span className="row-snippet">{c.lastMessage?.content || 'No messages yet.'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <div className="dash-side">
          <Panel title="Agent status">
            <div className="status-stack">
              <button className="status-row" onClick={() => navigate('/ai-agent')}>
                <span className={`status-icon ${aiOk ? 'ok' : 'bad'}`}>{aiOk ? <Bot size={17} /> : <ShieldAlert size={17} />}</span>
                <span className="status-row-copy"><strong>AI Agent</strong><small>{aiOk ? 'Online and replying' : 'Not fully configured'}</small></span>
                <StatusPill tone={aiOk ? 'good' : 'bad'}>{aiOk ? 'Online' : 'Offline'}</StatusPill>
              </button>
              <button className="status-row" onClick={() => navigate('/whatsapp')}>
                <span className={`status-icon ${waConnected ? 'ok' : 'bad'}`}>{waConnected ? <Smartphone size={17} /> : <Smartphone size={17} />}</span>
                <span className="status-row-copy"><strong>WhatsApp</strong><small>{waConnected ? `Connected · ${wa.phone || ''}`.trim() : 'Hermes gateway not connected'}</small></span>
                <StatusPill tone={waConnected ? 'good' : 'bad'}>{waConnected ? 'Live' : 'Off'}</StatusPill>
              </button>
              <button className="status-row" onClick={() => navigate('/analytics')}>
                <span className="status-icon ok"><Users size={17} /></span>
                <span className="status-row-copy"><strong>Customers</strong><small>{customers.length} recorded in your book</small></span>
                <span className="row-count">{customers.length}</span>
              </button>
            </div>
          </Panel>
          <Panel title="Quick actions">
            <div className="quick-actions">
              <Link className="button" to="/conversations">Inbox</Link>
              <Link className="button button-outline" to="/human-queue">Human queue</Link>
              <Link className="button button-outline" to="/ai-agent">AI Agent</Link>
              <Link className="button button-outline" to="/settings">Settings</Link>
            </div>
            <p className="dash-footnote">Updated {shortDate(Date.now())}. Data comes from your live Customer AI workspace.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}