import { Clock3, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, PageHeading } from '../components/UI';
import { api } from '../services/api';

const priority = intent => ['REFUND', 'PAYMENT_DISPUTE', 'COMPLAINT', 'LARGE_ORDER', 'DISCOUNT_REQUEST', 'UNKNOWN'].includes(intent) ? 'High' : 'Normal';
const highIntent = intent => ['REFUND', 'PAYMENT_DISPUTE', 'COMPLAINT', 'LARGE_ORDER', 'DISCOUNT_REQUEST'].includes(intent);

export default function HumanQueue() {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    api('/conversations?filter=human')
      .then(setItems)
      .catch(e => setNotice(e.message));
  }, []);
  return <>
    <PageHeading eyebrow="HUMAN-IN-THE-LOOP" title="Human queue" description="Review conversations Hermes has escalated for your approval." />
    {notice && <p className="setup-error">{notice}</p>}
    <div className="queue-stats">
      <div><b>{items.length}</b><span>Waiting for review</span></div>
      <div><b>{items.filter(c => highIntent(c.lastMessage?.aiIntent)).length}</b><span>High priority</span></div>
    </div>
    <div className="queue-list">
      {items.length === 0 && <p className="empty-note">No conversations are waiting for a human right now.</p>}
      {items.map(c => (
        <article className="queue-card" key={c._id}>
          <div className="person purple">{c.customerId?.name?.split(' ').map(n => n[0]).join('').slice(0, 2) || '?'}</div>
          <div className="queue-main">
            <div>
              <h3>{c.customerId?.name || 'Customer'} <Badge tone="danger">{priority(c.lastMessage?.aiIntent).toUpperCase()}</Badge></h3>
              <p>{c.customerId?.phone} · Waiting since {new Date(c.lastMessageAt).toLocaleString()}</p>
            </div>
            <blockquote>“{c.lastMessage?.content || 'No message text.'}”</blockquote>
            <div className="reason"><Clock3 size={16}/><span><b>Why Hermes escalated:</b> Sensitive request or AI confidence below policy threshold.</span></div>
          </div>
          <div className="queue-actions">
            <Badge tone="purple">{c.lastMessage?.aiIntent || c.status}</Badge>
            <Button variant="outline"><UserPlus size={16}/> Assign</Button>
            <Button onClick={() => navigate(`/conversations/${c._id}`)}>Open conversation</Button>
          </div>
        </article>
      ))}
    </div>
  </>;
}