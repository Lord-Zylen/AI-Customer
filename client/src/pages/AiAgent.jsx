import { Bot, CheckCircle2, Cpu, Database, HardDrive, HeartPulse, MessageSquareText, RefreshCw, ShieldAlert, Smartphone, Sparkles, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, EmptyState, ErrorState, PageHeading, Panel, Skeleton, StatusPill } from '../components/UI';
import { api } from '../services/api';
import { timeAgo } from '../lib/format';

const services = [
  ['backend', 'API server', 'Serves your dashboard and webhooks', HeartPulse],
  ['mongodb', 'Database', 'Conversations, customers and messages', Database],
  ['redis', 'Decision cache', 'Shared state with Hermes', HardDrive],
  ['groq', 'AI engine', 'Understands intent, confidence and replies', Cpu],
  ['hermes', 'Gateway', 'Owns the WhatsApp transport', Wifi],
  ['whatsapp', 'WhatsApp', 'Live channel through Hermes', Smartphone],
];

const stateOf = v => {
  if (['CONNECTED', 'CONFIGURED'].includes(v)) return 'good';
  if (['RECONNECTING', 'CONNECTING'].includes(v)) return 'warn';
  if (['NOT_CONFIGURED', 'NOT CONFIGURED'].includes(v)) return 'warn';
  return v ? 'bad' : 'warn';
};

export default function AiAgent() {
  const navigate = useNavigate();
  const [sys, setSys] = useState({});
  const [queue, setQueue] = useState([]);
  const [convos, setConvos] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [s, q, c] = await Promise.all([
        api('/system/status'),
        api('/conversations?filter=human').catch(() => []),
        api('/conversations'),
      ]);
      setSys(s || {}); setQueue(q || []); setConvos(c || []);
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const human = convos.filter(c => c.requiresHuman || c.status === 'HUMAN_REQUIRED').length;
  const aiActive = convos.filter(c => c.aiEnabled && c.status !== 'RESOLVED').length;
  const resolved = convos.filter(c => c.status === 'RESOLVED').length;

  return (
    <>
      <PageHeading
        eyebrow="AUTOMATION"
        title="AI Agent"
        description="How your customer-service AI is performing right now."
        action={<Button variant="outline" onClick={load}><RefreshCw size={15} /> Refresh</Button>}
      />
      {error && <ErrorState description={error} onRetry={load} />}

      <div className="agent-grid">
        <Panel className="panel-pad" title="Service health" description="Live status from the backend (refreshes automatically).">
          <div className="health-grid">
            {services.map(([key, label, hint, Icon]) => (
              <div className="health-card" key={key}>
                <span className={`health-icon ${stateOf(sys[key])}`}><Icon size={17} /></span>
                <div className="health-copy">
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </div>
                {loading ? <Skeleton width={72} height={12} /> : (
                  <StatusPill tone={stateOf(sys[key])}>{sys[key] || 'UNKNOWN'}</StatusPill>
                )}
              </div>
            ))}
          </div>
          <p className="health-note">
            {sys.managedBy ? `Transport is managed by ${sys.managedBy}.` : ''} Conversation decisions run through this backend before any WhatsApp reply is approved.
          </p>
        </Panel>

        <Panel className="panel-pad" title="Agent activity" description="Derived live from your recorded conversations.">
          <div className="agent-stats">
            <div className="agent-stat"><b>{aiActive}</b><span>Conversations on AI</span></div>
            <div className="agent-stat"><b>{human}</b><span>Waiting for human</span></div>
            <div className="agent-stat"><b>{resolved}</b><span>Resolved</span></div>
          </div>
          <p className="health-note"><Sparkles size={14} /> The AI reviews intent and confidence before replying — only safe, high-confidence requests get an automatic answer.</p>
        </Panel>
      </div>

      <Panel
        className="panel-pad"
        title="Needs human review"
        description="Latest conversations the AI has escalated."
        action={<button className="panel-link" onClick={() => navigate('/human-queue')}>Go to queue</button>}
      >
        {queue.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={24} />} title="Queue is clear" description="Nothing needs your attention right now." />
        ) : (
          <div className="row-list">
            {queue.slice(0, 5).map(c => (
              <button className="row-item" key={c._id} onClick={() => navigate(`/conversations/${c._id}`)}>
                <span className="health-icon bad"><ShieldAlert size={17} /></span>
                <div className="row-item-main">
                  <div className="row-item-top"><strong>{c.customerId?.name || 'Customer'}</strong><span className="row-time">{timeAgo(c.lastMessageAt || c.updatedAt)}</span></div>
                  <div className="row-item-sub">
                    <Badge tone="purple">{c.lastMessage?.aiIntent || c.status}</Badge>
                    <span className="row-snippet">{c.lastMessage?.content || 'No message text.'}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}