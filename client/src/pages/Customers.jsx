import { Mail, MessageCircle, Phone, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Badge, Button, EmptyState, ErrorState, PageHeading, Panel, SearchBar } from '../components/UI';
import { api } from '../services/api';
import { formatDateTime, timeAgo } from '../lib/format';

const statusOf = c =>
  c.requiresHuman || c.status === 'HUMAN_REQUIRED' ? 'human' : c.status === 'RESOLVED' ? 'resolved' : 'active';
const statusBadge = key => key === 'human' ? ['danger', 'Human'] : key === 'resolved' ? ['green', 'Resolved'] : ['purple', 'In conversation'];
const filterLabels = { all: 'All customers', active: 'In conversation', human: 'Needs human', resolved: 'Resolved' };

export default function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [convos, setConvos] = useState([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [cu, c] = await Promise.all([api('/customers'), api('/conversations')]);
      setCustomers(cu || []);
      setConvos(c || []);
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const byCustomer = {};
  convos.forEach(c => {
    const key = String(c.customerId?.name || '');
    byCustomer[key] = byCustomer[key] || [];
    byCustomer[key].push(c);
  });

  const rows = customers
    .map(cu => {
      const list = byCustomer[cu.name] || [];
      const latest = [...list].sort((a, b) => new Date(b.lastMessageAt || b.updatedAt) - new Date(a.lastMessageAt || a.updatedAt))[0];
      return { cu, count: list.length, latest, status: latest ? statusOf(latest) : 'resolved' };
    })
    .filter(r => status === 'all' || r.status === status)
    .filter(r => !query || `${r.cu.name || ''} ${r.cu.phone || ''} ${r.cu.email || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (b.latest?.lastMessageAt || b.cu.updatedAt) - (a.latest?.lastMessageAt || a.cu.updatedAt));

  return (
    <>
      <PageHeading
        eyebrow="CONTACTS"
        title="Customers"
        description="Every contact currently known to Customer AI."
        action={<div className="page-heading-stat"><Users size={16} /> {customers.length} total</div>}
      />
      {error && <ErrorState description={error} onRetry={load} />}

      <div className="toolbar-row">
        <SearchBar value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, phone or email" />
        <select className="select-control" value={status} onChange={e => setStatus(e.target.value)}>
          {Object.entries(filterLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <Panel className="table-panel">
        {loading ? (
          <div className="empty-state"> <Users size={24} /> <p>Loading customers…</p></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users size={26} />} title="No customers found" description={query || status !== 'all' ? 'Try a different search or filter.' : 'Customers are recorded automatically when a new WhatsApp conversation arrives.'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Customer</th><th>Contact</th><th>Conversations</th><th>Status</th><th>Latest activity</th><th></th></tr></thead>
              <tbody>
                {rows.map(({ cu, count, latest, status: st }) => {
                  const [tone, label] = statusBadge(st);
                  const target = latest || (byCustomer[cu.name] || [])[0];
                  return (
                    <tr key={cu._id}>
                      <td><span className="cell-customer"><Avatar name={cu.name} size="md" /><span className="cell-strong">{cu.name || 'WhatsApp customer'}</span></span></td>
                      <td>
                        <span className="cell-lines"><span><Phone size={12} /> {cu.phone}</span>{cu.email && <span><Mail size={12} /> {cu.email}</span>}</span>
                      </td>
                      <td><Badge tone="neutral">{count}</Badge></td>
                      <td><Badge tone={tone}>{label}</Badge></td>
                      <td className="cell-muted">{latest ? timeAgo(latest.lastMessageAt || latest.updatedAt) : '—'}</td>
                      <td>{target ? <Button variant="ghost" size="sm" className="button-compact" onClick={() => navigate(`/conversations/${target._id}`)}>Open</Button> : <span className="cell-muted">{formatDateTime(cu.updatedAt)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}