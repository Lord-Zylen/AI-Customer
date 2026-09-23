import { Bot, CheckCircle2, LockKeyhole, LogOut, Save, Settings2, Smartphone, ShieldCheck, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Badge, Button, PageHeading, Panel, StatusPill } from '../components/UI';
import { api } from '../services/api';

const fields = [
  ['businessName', 'Business name'],
  ['description', 'Business description'],
  ['location', 'Business location'],
  ['openingHours', 'Opening hours'],
  ['productsServices', 'Products / services'],
  ['prices', 'Prices'],
  ['deliveryInformation', 'Delivery information'],
  ['paymentInformation', 'Payment information'],
  ['commonQuestions', 'Common questions and answers'],
];

const tabs = [
  ['business', 'Business knowledge', Store],
  ['account', 'Account', LockKeyhole],
  ['system', 'System', Settings2],
];

export default function Settings() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('business');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/settings/business')
      .then(d => { setData(d || {}); })
      .catch(e => setNotice(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      setData(await api('/settings/business', { method: 'PATCH', body: JSON.stringify(data) }));
      setNotice('Saved. Hermes will use this approved information.');
    } catch (e) { setNotice(e.message); } finally { setSaving(false); }
  };

  let user = {};
  try { user = JSON.parse(sessionStorage.getItem('customer_ai_user') || '{}'); } catch { /* ignore */ }
  const displayName = user.name || user.email || 'Administrator';
  const email = user.email || '';

  const logout = () => { sessionStorage.clear(); navigate('/login'); };

  return (
    <>
      <PageHeading
        eyebrow="CONFIGURATION"
        title="Settings"
        description="The information your AI is allowed to use."
        action={tab === 'business' ? <Button onClick={save} disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save changes'}</Button> : undefined}
      />

      <div className="settings-tabs" role="tablist">
        {tabs.map(([key, label, Icon]) => (
          <button key={key} className={`settings-tab ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); setNotice(''); }} role="tab">
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {notice && <p className={notice.includes('Saved') ? 'notice-success' : 'notice-error'}>
        {notice.includes('Saved') ? <><CheckCircle2 size={14} /> {notice}</> : notice}
      </p>}

      {tab === 'business' && (
        <div className="settings-form">
          <Panel className="panel-pad">
            <div className="panel-header pad-h"><div><h3>Business knowledge</h3><p>Hermes may use these details in customer replies. Keep them accurate and approved.</p></div></div>
            {loading ? <div className="empty-state"><p>Loading business settings…</p></div> : (
              <div className="settings-grid">
                {fields.map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <textarea className="input textarea" value={data[key] || ''} onChange={e => setData({ ...data, [key]: e.target.value })} placeholder={`Enter ${label.toLowerCase()}…`} />
                  </label>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'account' && (
        <div className="settings-form">
          <Panel className="panel-pad">
            <div className="account-row">
              <Avatar name={displayName} size="xl" />
              <div>
                <h3>{displayName}</h3>
                <p>{email || 'Administrator account'}</p>
                <Badge tone="purple">ADMINISTRATOR</Badge>
              </div>
              <Button variant="outline" onClick={logout}><LogOut size={15} /> Sign out</Button>
            </div>
            <div className="account-note">
              <LockKeyhole size={15} />
              <span>Passwords are managed through the server (<code>.env</code> + seed script), not through this dashboard, to keep credentials out of the browser.</span>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'system' && (
        <div className="settings-form">
          <div className="status-stack">
            <Link className="status-row" to="/ai-agent">
              <span className="status-icon ok"><Bot size={17} /></span>
              <span className="status-row-copy"><strong>AI Agent</strong><small>Service health, AI engine and activity</small></span>
              <StatusPill tone="info" >Open</StatusPill>
            </Link>
            <Link className="status-row" to="/whatsapp">
              <span className="status-icon ok"><Smartphone size={17} /></span>
              <span className="status-row-copy"><strong>WhatsApp</strong><small>Channel status and Hermes guidance</small></span>
              <StatusPill tone="info">Open</StatusPill>
            </Link>
            <Link className="status-row" to="/dashboard">
              <span className="status-icon ok"><ShieldCheck size={17} /></span>
              <span className="status-row-copy"><strong>Overview</strong><small>Back to your workspace dashboard</small></span>
              <StatusPill tone="info">Open</StatusPill>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}