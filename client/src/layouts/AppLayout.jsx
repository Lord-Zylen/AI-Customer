import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, Bot, LayoutDashboard, LogOut, Menu, MessageSquare, Settings,
  ShieldAlert, ShoppingBag, Smartphone, Users, X,
} from 'lucide-react';
import { Avatar } from '../components/UI';
import { api } from '../services/api';

const groups = [
  ['OPERATIONS', [
    ['/dashboard', 'Dashboard', LayoutDashboard],
    ['/conversations', 'Conversations', MessageSquare],
    ['/human-queue', 'Human queue', ShieldAlert],
    ['/customers', 'Customers', Users],
  ]],
  ['INSIGHT', [
    ['/orders', 'Orders', ShoppingBag],
    ['/analytics', 'Analytics', BarChart3],
  ]],
  ['SYSTEM', [
    ['/ai-agent', 'AI Agent', Bot],
    ['/whatsapp', 'WhatsApp', Smartphone],
    ['/settings', 'Settings', Settings],
  ]],
];

const routeMeta = {
  '/dashboard': ['Dashboard', 'Your live workspace at a glance'],
  '/conversations': ['Conversations', 'WhatsApp threads with AI assistance'],
  '/human-queue': ['Human queue', 'Review escalated conversations'],
  '/customers': ['Customers', 'Everyone recorded in your book'],
  '/orders': ['Orders', 'No order tracking connected yet'],
  '/analytics': ['Analytics', 'Real numbers, no placeholders'],
  '/ai-agent': ['AI Agent', 'Automation status and activity'],
  '/whatsapp': ['WhatsApp', 'Supervised through the Hermes gateway'],
  '/settings': ['Settings', 'Tune what your AI may use'],
};

const metaFor = pathname => {
  const exact = routeMeta[pathname];
  if (exact) return exact;
  if (pathname.startsWith('/conversations/')) return routeMeta['/conversations'];
  return routeMeta['/dashboard'];
};

export default function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [pill, setPill] = useState({ ai: null, wa: null, queue: 0 });

  let user = {};
  try { user = JSON.parse(sessionStorage.getItem('customer_ai_user') || '{}'); } catch { /* ignore */ }
  const displayName = user.name || user.email || 'Administrator';
  const [title, caption] = metaFor(pathname);

  const logout = () => { sessionStorage.clear(); navigate('/login'); };

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [s, w, q] = await Promise.all([
          api('/system/status'),
          api('/whatsapp/status'),
          api('/conversations?filter=human').then(d => d?.length ?? 0),
        ]);
        if (!alive) return;
        setPill({
          ai: ['CONNECTED', 'CONFIGURED'].includes(s.groq) ? 'good' : 'off',
          wa: w.status === 'CONNECTED' ? 'good' : 'off',
          queue: q,
        });
      } catch { /* the health endpoints may be briefly unreachable */ }
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const close = () => setOpen(false);

  return (
    <div className="shell">
      <div className={`main-overlay ${open ? 'show' : ''}`} onClick={close} />

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark"><Bot size={20} /></span>
          <span>Customer <b>AI</b></span>
          <button className="sidebar-close" onClick={close} aria-label="Close menu"><X size={18} /></button>
        </div>

        <nav className="side-nav">
          {groups.map(([label, links]) => (
            <div key={label}>
              <p className="side-group-label">{label}</p>
              {links.map(([to, text, Icon]) => (
                <NavLink key={to} to={to} end={to === '/dashboard'} onClick={close}>
                  <Icon size={17} />
                  <span>{text}</span>
                  {text === 'Human queue' && pill.queue > 0 && <span className="nav-badge">{pill.queue > 9 ? '9+' : pill.queue}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="side-footer">
          <div className="side-user">
            <Avatar name={displayName} size="md" />
            <div className="side-user-copy">
              <strong>{displayName}</strong>
              <small>{user.email || 'Administrator'}</small>
            </div>
          </div>
          <nav>
            <button className="logout" onClick={logout}><LogOut size={16} /> Sign out</button>
          </nav>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="topbar-title">
            <h1>{title}</h1>
            <p>{caption}</p>
          </div>
          <div className="topbar-right">
            <div className="topbar-stats">
              <button className="topbar-status" onClick={() => navigate('/ai-agent')} title="AI Agent status">
                <i className={`live-dot ${pill.ai === 'good' ? 'good' : 'off'}`} />
                <span>AI {pill.ai === 'good' ? 'online' : 'offline'}</span>
              </button>
              <button className="topbar-status" onClick={() => navigate('/whatsapp')} title="WhatsApp status">
                <i className={`live-dot ${pill.wa === 'good' ? 'good' : 'off'}`} />
                <span>WhatsApp {pill.wa === 'good' ? 'live' : 'off'}</span>
              </button>
            </div>
            <button className="icon-button topbar-avatar" onClick={() => navigate('/settings')} title="Open settings" aria-label="Account">
              <Avatar name={displayName} size="sm" />
            </button>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}