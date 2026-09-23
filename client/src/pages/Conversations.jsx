import { AlertCircle, Bot, CheckCheck, MessageCircle, MoreHorizontal, Paperclip, Pause, Phone, Play, Send, UserRoundCheck, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar, Badge, Button, EmptyState, ErrorState, IconButton, SearchBar, Spinner } from '../components/UI';
import { api } from '../services/api';
import { formatTime, initials, timeAgo } from '../lib/format';

const statusTone = s =>
  s === 'HUMAN_REQUIRED' ? 'danger' : s === 'RESOLVED' ? 'green' : 'purple';

const filterOptions = ['', 'active', 'human', 'resolved'];
const filterLabels = { '': 'All conversations', active: 'AI active', human: 'Human required', resolved: 'Resolved' };

export default function Conversations() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [sending, setSending] = useState(false);
  const listEndRef = useRef(null);

  const shown = items.filter(c => !query || `${c.customerId?.name || ''} ${c.customerId?.phone || ''}`.toLowerCase().includes(query.toLowerCase()));

  const open = async conversation => {
    setActive(conversation);
    setNotes(conversation.customerId?.notes || '');
    if (conversation._id !== id) navigate(`/conversations/${conversation._id}`, { replace: true });
    try {
      setMessages(await api(`/conversations/${conversation._id}/messages`));
    } catch (e) { setNotice(e.message); }
  };

  const load = async () => {
    try {
      const data = await api(`/conversations${filter ? `?filter=${filter}` : ''}`);
      setItems(data);
      const next = data.find(x => x._id === id) || (active && data.find(x => x._id === active._id)) || data[0];
      if (next && (!active || next._id !== active._id)) {
        open(next);
      } else if (next && active && active._id === next._id) {
        setActive(next);
        api(`/conversations/${next._id}/messages`).then(setMessages).catch(e => setNotice(e.message));
      } else {
        setActive(null);
      }
    } catch (e) { setNotice(e.message); }
  };

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { load(); }, [filter]);
  useEffect(() => {
    const t = setInterval(() => loadRef.current(), 4000);
    return () => clearInterval(t);
  }, []);

  const scrollToBottom = () => { listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); };
  useEffect(scrollToBottom, [messages, active?._id]);

  const send = async () => {
    if (!text.trim() || !active || sending) return;
    setSending(true);
    try {
      const message = await api(`/conversations/${active._id}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
      setMessages(prev => [...prev.filter(m => m._id !== message._id), message]);
      setText('');
      load();
    } catch (e) { setNotice(e.message); } finally { setSending(false); }
  };

  const patchConversation = async body => {
    try {
      const updated = await api(`/conversations/${active._id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setActive(updated);
      load();
    } catch (e) { setNotice(e.message); }
  };

  const assignToMe = async () => {
    try {
      const updated = await api(`/conversations/${active._id}/assign`, { method: 'POST' });
      setActive(updated); load();
    } catch (e) { setNotice(e.message); }
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      const updated = await api(`/customers/${active.customerId._id}`, { method: 'PATCH', body: JSON.stringify({ notes }) });
      setActive(prev => ({ ...prev, customerId: { ...prev.customerId, notes: updated.notes } }));
      setNotice('');
    } catch (e) { setNotice(e.message); } finally { setSavingNotes(false); }
  };

  return (
    <>
      {notice && <div className="loading-bar top">{notice} <button onClick={() => setNotice('')}><XCircle size={15} /></button></div>}
      <div className="conversation-app">
        {/* List */}
        <aside className="inbox">
          <div className="inbox-top">
            <SearchBar value={query} onChange={e => setQuery(e.target.value)} placeholder="Search customer or phone" />
            <select className="select-control" value={filter} onChange={e => setFilter(e.target.value)}>
              {filterOptions.map(f => <option key={f} value={f}>{filterLabels[f]}</option>)}
            </select>
          </div>
          <div className="inbox-count">{shown.length} {shown.length === 1 ? 'conversation' : 'conversations'}</div>
          <div className="inbox-list-wrap">
          {shown.length === 0 ? (
            <EmptyState icon={<MessageCircle size={24} />} title="No conversations here" description={filter || query ? 'Try a different filter or search.' : 'Your WhatsApp conversations will show up here.'} />
          ) : shown.map(c => (
            <button className={`inbox-item ${active?._id === c._id ? 'active' : ''}`} onClick={() => open(c)} key={c._id}>
              <Avatar name={c.customerId?.name} size="md" />
              <div className="inbox-item-main">
                <b>{c.customerId?.name || 'Customer'}</b>
                <p className="inbox-item-sub">{c.requiresHuman ? 'Human attention required' : c.aiEnabled ? 'AI active' : 'AI paused'}</p>
              </div>
              <div className="inbox-item-side">
                <small>{timeAgo(c.lastMessageAt || c.updatedAt)}</small>
                {c.requiresHuman && <i className="pulse-dot" title="Needs human review" />}
              </div>
            </button>
          ))}
          </div>
        </aside>

        {/* Thread */}
        {active ? (
          <section className="chat">
            <div className="chat-head">
              <Avatar name={active.customerId?.name} size="md" />
              <div className="chat-head-copy">
                <h3>{active.customerId?.name || 'Customer'}</h3>
                <p>{active.customerId?.phone} · WhatsApp</p>
              </div>
              <Badge tone={statusTone(active.status)}>{active.requiresHuman ? 'HUMAN REQUIRED' : active.aiEnabled ? 'AI ACTIVE' : 'AI PAUSED'}</Badge>
              <div className="chat-actions">
                <IconButton label="Call (no dialer wired)"><Phone size={16} /></IconButton>
                <IconButton label="More options"><MoreHorizontal size={17} /></IconButton>
              </div>
            </div>

            <div className={`triage ${active.aiEnabled ? 'triage-on' : 'triage-off'}`}>
              <Bot size={17} />
              <div>
                <b>{active.aiEnabled ? 'AI is active' : 'AI is paused'}</b>
                <p>{active.aiEnabled ? 'Hermes can reply only to safe, high-confidence requests.' : 'Incoming messages are routed to the human queue.'}</p>
              </div>
              <Button variant="outline" size="sm" className="button-compact" onClick={() => patchConversation({ aiEnabled: !active.aiEnabled })}>
                {active.aiEnabled ? <><Pause size={14} /> Pause AI</> : <><Play size={14} /> Resume AI</>}
              </Button>
            </div>

            <div className="messages">
              {messages.map(m => (
                <div key={m._id} className={`message ${m.direction === 'INBOUND' ? 'incoming' : 'outgoing'} msg-${m.senderType.toLowerCase()}`}>
                  <span className="message-sender">
                    <Avatar name={m.senderType === 'CUSTOMER' ? (active.customerId?.name || 'Customer') : m.senderType === 'AI' ? 'AI Agent' : 'Staff'} size="xs" />
                    <b>{m.senderType === 'CUSTOMER' ? 'Customer' : m.senderType === 'AI' ? 'AI Agent' : 'Staff'}</b>
                    <span className="message-meta">
                      {m.senderType !== 'CUSTOMER' && <CheckCheck size={13} />}
                      {formatTime(m.createdAt)}
                    </span>
                  </span>
                  <div className="message-bubble">{m.content}
                    {m.aiIntent && m.senderType === 'AI' && <span className="message-intent">{m.aiIntent}</span>}
                  </div>
                </div>
              ))}
              {messages.length === 0 && <div className="messages-empty">No messages in this conversation yet.</div>}
              <div ref={listEndRef} />
            </div>

            <div className="composer">
              <IconButton label="Attach file (not implemented)"><Paperclip size={18} /></IconButton>
              <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} placeholder="Type a message…" />
              <button className="send" onClick={send} disabled={sending || !text.trim()} title="Send message" aria-label="Send message">
                {sending ? <Spinner size={17} /> : <Send size={17} />}
              </button>
            </div>
          </section>
        ) : (
          <section className="empty-inbox">
            <MessageCircle size={30} />
            <p>Select a conversation to start working.</p>
          </section>
        )}

        {/* Profile */}
        <aside className="profile">
          {active ? (
            <>
              <div className="profile-head">
                <Avatar name={active.customerId?.name} size="lg" />
                <h3>{active.customerId?.name || 'Customer'}</h3>
                <p>{active.customerId?.phone || '—'}</p>
                {active.customerId?.email && <p className="profile-email">{active.customerId.email}</p>}
                <div className="profile-badges">
                  <Badge tone={statusTone(active.status)}>{active.status === 'RESOLVED' ? 'RESOLVED' : active.requiresHuman ? 'HUMAN REQUIRED' : active.aiEnabled ? 'AI ACTIVE' : 'AI PAUSED'}</Badge>
                  {active.assignedTo?.name && <Badge tone="blue">{active.assignedTo.name}</Badge>}
                </div>
              </div>

              <div className="profile-section">
                <h4>Customer notes</h4>
                <textarea className="input" rows="4" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add context about this customer…" />
                <Button variant="outline" className="button-compact" onClick={saveNotes} disabled={savingNotes || notes === (active.customerId?.notes || '')}>
                  {savingNotes ? <Spinner size={14} /> : <UserRoundCheck size={15} />} Save notes
                </Button>
              </div>

              <div className="profile-section">
                <h4>Last AI decision</h4>
                {active.lastMessage?.aiIntent ? (
                  <>
                    <Badge tone="purple">{active.lastMessage.aiIntent}</Badge>
                    {active.lastMessage.aiConfidence != null && (
                      <p className="confidence">Confidence {(active.lastMessage.aiConfidence * 100).toFixed(0)}%</p>
                    )}
                  </>
                ) : (
                  <p className="profile-muted">No AI decision recorded yet.</p>
                )}
              </div>

              <div className="profile-section profile-actions">
                <h4>Actions</h4>
                <Button variant="outline" className="button-compact" onClick={assignToMe} disabled={active.assignedTo?.name?.toLowerCase().includes('you') || !!active.assignedTo?.name}>
                  <UserRoundCheck size={14} /> {active.assignedTo?.name ? `Assigned to ${active.assignedTo.name}` : 'Assign to me'}
                </Button>
                {active.status !== 'RESOLVED' && (
                  <Button variant="outline" className="button-compact" onClick={() => patchConversation({ status: 'RESOLVED' })}>
                    <CheckCheck size={14} /> Mark resolved
                  </Button>
                )}
                {active.status === 'RESOLVED' && (
                  <Button variant="outline" className="button-compact" onClick={() => patchConversation({ status: 'OPEN', requiresHuman: false })}>
                    <Play size={14} /> Reopen
                  </Button>
                )}
              </div>
              <p className="profile-fallback"><AlertCircle size={13} /> <span>Assignment alone keeps the message in the human queue until a reply is sent.</span></p>
            </>
          ) : (
            <div className="profile-empty">Select a conversation to see customer details.</div>
          )}
        </aside>
      </div>
    </>
  );
}