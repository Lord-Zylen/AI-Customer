import { ArrowRight, Clock3, Inbox, Play, ShieldAlert, UserPlus, UserRoundCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Badge, Button, EmptyState, PageHeading } from '../components/UI';
import { api } from '../services/api';
import { timeAgo } from '../lib/format';

const highIntents = ['REFUND', 'PAYMENT_DISPUTE', 'COMPLAINT', 'LARGE_ORDER', 'DISCOUNT_REQUEST'];
const priority = intent => (highIntents.includes(intent) ? 'danger' : 'neutral');
const priorityLabel = intent => (highIntents.includes(intent) ? 'High priority' : 'Normal');

export default function HumanQueue() {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [assignError, setAssignError] = useState('');
  const navigate = useNavigate();

  const load = async () => {
    try {
      setItems(await api('/conversations?filter=human'));
      setNotice('');
    } catch (e) { setNotice(e.message); }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    load();
    const t = setInterval(() => loadRef.current(), 4000);
    return () => clearInterval(t);
  }, []);

  const assign = async conversation => {
    if (busyId) return;
    setBusyId(conversation._id);
    setAssignError('');
    try {
      const updated = await api(`/conversations/${conversation._id}/assign`, { method: 'POST' });
      setItems(prev => prev.map(c => (c._id === updated._id ? { ...c, assignedTo: updated.assignedTo } : c)));
    } catch (e) { setAssignError(e.message); } finally { setBusyId(null); }
  };

  const returnToAi = async conversation => {
    setBusyId(conversation._id);
    try {
      const updated = await api(`/conversations/${conversation._id}`, { method: 'PATCH', body: JSON.stringify({ aiEnabled: true }) });
      if (!updated.requiresHuman) setItems(prev => prev.filter(c => c._id !== updated._id));
    } catch (e) { setAssignError(e.message); } finally { setBusyId(null); }
  };

  const highCount = items.filter(c => priority(c.lastMessage?.aiIntent) === 'danger').length;

  return (
    <>
      <PageHeading
        eyebrow="HUMAN-IN-THE-LOOP"
        title="Human queue"
        description="Conversations Hermes has escalated for your review and approval."
      />
      {notice && !assignError && <p className="notice-error">{notice}</p>}
      {assignError && <p className="notice-error">{assignError} <button className="link-reset" onClick={() => setAssignError('')}>Dismiss</button></p>}

      <div className="queue-stats">
        <div className="queue-stat"><b>{items.length}</b><span>Waiting for review</span></div>
        <div className="queue-stat"><b className={highCount ? 'text-danger' : ''}>{highCount}</b><span>High priority</span></div>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<Inbox size={26} />}
            title="Queue is clear"
            description="No conversations are waiting for a human right now. Sensitive or low-confidence requests appear here automatically."
          />
        </div>
      ) : (
        <div className="queue-list">
          {items.map(c => (
            <article className="queue-card" key={c._id}>
              <Avatar name={c.customerId?.name} size="lg" />
              <div className="queue-main">
                <div className="queue-title">
                  <h3>{c.customerId?.name || 'Customer'}</h3>
                  <Badge tone={priority(c.lastMessage?.aiIntent)}>{priorityLabel(c.lastMessage?.aiIntent)}</Badge>
                  <span className="queue-wait"><Clock3 size={13} /> waiting {timeAgo(c.lastMessageAt || c.updatedAt)}</span>
                </div>
                <p className="queue-phone">{c.customerId?.phone} · WhatsApp</p>
                <blockquote>“{c.lastMessage?.content || 'No message text.'}”</blockquote>
                <div className="reason"><ShieldAlert size={16} /><span><b>Why Hermes escalated:</b> Sensitive request or AI confidence below policy threshold.</span></div>
              </div>
              <div className="queue-actions">
                <Badge tone="purple">{c.lastMessage?.aiIntent || c.status}</Badge>
                <span className="assigned-note">
                  {c.assignedTo?.name ? <><UserRoundCheck size={15} /> Assigned to {c.assignedTo.name}</> : 'Unassigned'}
                </span>
                <div className="queue-button-row">
                  {!c.assignedTo?.name ? (
                    <Button variant="outline" disabled={!!busyId} onClick={() => assign(c)}>
                      <UserPlus size={15} /> {busyId === c._id ? 'Assigning…' : 'Assign to me'}
                    </Button>
                  ) : <Button variant="outline" disabled>Assigned</Button>}
                  <Button variant="outline" disabled={!!busyId} onClick={() => returnToAi(c)} title="Re-enable AI for this conversation">
                    <Play size={15} /> Return to AI
                  </Button>
                  <Button onClick={() => navigate(`/conversations/${c._id}`)}>
                    Open <ArrowRight size={15} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}