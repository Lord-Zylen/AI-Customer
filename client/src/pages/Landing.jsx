import {
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  ChefHat,
  Clock,
  Inbox,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Store,
  UtensilsCrossed,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import heroImage from '../assets/landing/jollof-vendor-hero.jpg';
import plateImage from '../assets/landing/jollof-plate.jpg';
import stallImage from '../assets/landing/curbside-stall.jpg';

const NAV_LINKS = [
  ['#features', 'Features'],
  ['#how', 'How it works'],
  ['#showcase', 'Showcase'],
];

const FEATURES = [
  {
    icon: Zap,
    tone: 'violet',
    title: 'Instant replies',
    body: 'Routine questions get answered in seconds — at lunch rush or midnight — without you touching the phone.',
  },
  {
    icon: ShieldCheck,
    tone: 'green',
    title: 'Approved knowledge only',
    body: 'Menus, prices and policies come from the knowledge you sign off on. The agent never invents a price or a fee.',
  },
  {
    icon: Users,
    tone: 'amber',
    title: 'Human handoff',
    body: 'Refunds, complaints and anything sensitive wait for you in a review queue instead of being guessed at.',
  },
  {
    icon: Inbox,
    tone: 'blue',
    title: 'One live inbox',
    body: 'Every WhatsApp thread in one place, with AI replies and your own replies side by side.',
  },
  {
    icon: UtensilsCrossed,
    tone: 'orange',
    title: 'Menus and totals',
    body: 'Teach it your menu once. It answers every item, every price and every order total correctly.',
  },
  {
    icon: BarChart3,
    tone: 'pink',
    title: 'Know what needs you',
    body: 'See how many chats the agent closed on its own and which conversations still need a human.',
  },
];

const STEPS = [
  {
    icon: Smartphone,
    title: 'Connect your WhatsApp',
    body: 'Pair the number you already use with the Hermes gateway. Customer AI never opens a second connection.',
  },
  {
    icon: Store,
    title: 'Approve your knowledge',
    body: 'Add your menu, prices and policies once in Settings. Everything the agent says is drawn from this.',
  },
  {
    icon: Users,
    title: 'Review the queue',
    body: 'Routine questions are answered automatically. Sensitive ones stay silent and wait for you.',
  },
];

const METRICS = [
  { value: '24/7', label: 'Answers outside your hours, too.' },
  { value: 'Seconds', label: 'Typical reply time on a routine question.' },
  { value: 'Zero', label: 'Invented prices, fees or policies.' },
];

const THREAD = [
  { from: 'customer', text: 'Hi, what food do you sell?' },
  {
    from: 'agent',
    text: 'Hello! 😊 Here’s our menu:\n🍚 Jollof Rice – GH₵30 per pack\n🍛 Fried Rice – GH₵30 per pack\n🍜 Noodles – GH₵30 per pack\n\nWhat would you like to order?',
  },
  { from: 'customer', text: 'I want two packs of jollof and one pack of noodles. How much will it cost?' },
  {
    from: 'agent',
    text: '🍚 Jollof Rice × 2 – GH₵60\n🍜 Noodles × 1 – GH₵30\n\nTotal: GH₵90\n\nWould you like to proceed with the order?',
  },
];

export default function Landing() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(sessionStorage.getItem('customer_ai_token')));
    const previous = document.title;
    document.title = 'Customer AI — Every WhatsApp message answered by AI';
    return () => { document.title = previous; };
  }, []);

  const workspaceHref = signedIn ? '/dashboard' : '/login';
  const workspaceLabel = signedIn ? 'Open workspace' : 'Sign in to the workspace';

  return (
    <div className="lp">
      {/* ── Navigation ─────────────────────────────────────────── */}
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <Link to="/" className="lp-brand">
            <span className="lp-brand-mark"><Bot size={20} /></span>
            <b>Customer <i>AI</i></b>
          </Link>

          <nav className="lp-nav-links">
            {NAV_LINKS.map(([href, label]) => (
              <a key={href} href={href}>{label}</a>
            ))}
          </nav>

          <div className="lp-nav-actions">
            {!signedIn && <Link className="lp-btn-ghost" to="/login">Sign in</Link>}
            <Link className="lp-btn" to={workspaceHref}>
              {workspaceLabel}
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className="lp-hero">
        <div className="lp-glow lp-glow-a" />
        <div className="lp-glow lp-glow-b" />
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-pill">
              <Sparkles size={13} /> WhatsApp customer service workspace
            </span>
            <h1>
              Every WhatsApp message
              <span className="lp-gradient-text"> answered by AI</span>,
              <br />with a human one click away.
            </h1>
            <p className="lp-lead">
              Customer AI triages every inbound chat, replies instantly from your approved
              business knowledge, and escalates the tricky ones to your human queue — so you
              never answer a customer from a phone in the middle of service.
            </p>
            <div className="lp-hero-actions">
              <Link className="lp-btn lp-btn-lg" to={workspaceHref}>
                {workspaceLabel} <ArrowRight size={16} />
              </Link>
              <a className="lp-btn lp-btn-lg lp-btn-outline" href="#how">
                See how it works
              </a>
            </div>
            <ul className="lp-checks">
              <li><Check size={15} /> Uses the WhatsApp number you already have</li>
              <li><Check size={15} /> Replies only from knowledge you approve</li>
            </ul>
          </div>

          <div className="lp-hero-visual">
            <div className="lp-hero-frame">
              <img src={heroImage} alt="A street food vendor preparing jollof rice on a busy urban street" />
              <div className="lp-hero-tint" />
            </div>

            <div className="lp-float lp-float-chat">
              <div className="lp-float-head">
                <span className="lp-float-avatar"><Bot size={14} /></span>
                <div>
                  <strong>Hermes</strong>
                  <small>AI agent · Check Check City</small>
                </div>
                <span className="lp-float-live"><i />live</span>
              </div>
              <div className="lp-float-body">
                <div className="lp-bubble lp-bubble-in">How much is a pack?</div>
                <div className="lp-bubble lp-bubble-out">
                  🍚 Jollof Rice – GH₵30 per pack
                  <br />🍛 Fried Rice – GH₵30 per pack
                  <br />🍜 Noodles – GH₵30 per pack
                </div>
              </div>
            </div>

            <div className="lp-float lp-float-stat">
              <Clock size={15} />
              <div><strong>Replied in 2s</strong><small>no human needed</small></div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Metrics ─────────────────────────────────────────────── */}
      <section className="lp-metrics">
        {METRICS.map(m => (
          <div className="lp-metric" key={m.value}>
            <strong>{m.value}</strong>
            <span>{m.label}</span>
          </div>
        ))}
      </section>

      {/* ── Features ────────────────────────────────────────────── */}
      <section className="lp-section" id="features">
        <div className="lp-section-head">
          <p className="lp-eyebrow">What it does</p>
          <h2>An agent that knows the difference between a question and an escalation</h2>
          <p>
            The AI handles the repetitive half of customer service. You keep the half that
            actually needs a person.
          </p>
        </div>
        <div className="lp-feature-grid">
          {FEATURES.map(f => (
            <article className="lp-feature" key={f.title}>
              <span className={`lp-feature-icon lp-tone-${f.tone}`}><f.icon size={19} /></span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Showcase ────────────────────────────────────────────── */}
      <section className="lp-section lp-showcase" id="showcase">
        <div className="lp-showcase-grid">
          <div className="lp-showcase-media">
            <img src={plateImage} alt="A plate of jollof rice with fried plantains" />
            <div className="lp-showcase-badge">
              <ChefHat size={16} />
              <div>
                <strong>Menu &amp; prices</strong>
                <small>Jollof · Fried rice · Noodles — GH₵30 a pack</small>
              </div>
            </div>
          </div>

          <div className="lp-showcase-copy">
            <p className="lp-eyebrow">Showcase</p>
            <h2>Your menu, answered like a real shopkeeper</h2>
            <p>
              Check Check City’s AI answers questions, prices and order totals straight from
              the knowledge the owner approved — and says so plainly when it doesn’t have
              confirmed information.
            </p>

            <div className="lp-thread">
              {THREAD.map((m, i) => (
                <div className={`lp-thread-row lp-thread-${m.from}`} key={i}>
                  {m.from === 'agent' && (
                    <span className="lp-thread-avatar"><Bot size={13} /></span>
                  )}
                  <div className="lp-thread-bubble">{m.text}</div>
                </div>
              ))}
              <div className="lp-thread-note">
                <ShieldCheck size={14} />
                Real transcript from the live agent — menu, prices and totals drawn from
                approved knowledge only.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────── */}
      <section className="lp-section lp-steps-section" id="how">
        <div className="lp-section-head">
          <p className="lp-eyebrow">How it works</p>
          <h2>Live in three steps</h2>
          <p>No migration, no second WhatsApp number, no new app for your staff to learn.</p>
        </div>
        <div className="lp-steps">
          {STEPS.map((s, i) => (
            <article className="lp-step" key={s.title}>
              <span className="lp-step-number">{String(i + 1).padStart(2, '0')}</span>
              <span className="lp-step-icon"><s.icon size={19} /></span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── CTA band ────────────────────────────────────────────── */}
      <section className="lp-cta">
        <img className="lp-cta-bg" src={stallImage} alt="" aria-hidden="true" />
        <div className="lp-cta-overlay" />
        <div className="lp-cta-inner">
          <p className="lp-eyebrow lp-eyebrow-light">Get started</p>
          <h2>Stop letting a menu question become an unanswered chat</h2>
          <p>
            Connect your number, approve your knowledge, and let the agent take the
            repetitive half of customer service.
          </p>
          <div className="lp-hero-actions lp-cta-actions">
            <Link className="lp-btn lp-btn-lg lp-btn-light" to={workspaceHref}>
              {workspaceLabel} <ArrowRight size={16} />
            </Link>
            <a className="lp-btn lp-btn-lg lp-btn-glass" href="#features">
              Explore the features
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <Link to="/" className="lp-brand lp-brand-dark">
              <span className="lp-brand-mark"><Bot size={18} /></span>
              <b>Customer <i>AI</i></b>
            </Link>
            <p>
              A WhatsApp customer service workspace: Hermes answers, you approve,
              nothing is invented.
            </p>
          </div>
          <div className="lp-footer-links">
            <div>
              <strong>Product</strong>
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#showcase">Showcase</a>
            </div>
            <div>
              <strong>Workspace</strong>
              <Link to="/login">Sign in</Link>
              <Link to="/dashboard">Dashboard</Link>
              <Link to="/human-queue">Human queue</Link>
            </div>
          </div>
        </div>
        <div className="lp-footer-base">
          <span>© {new Date().getFullYear()} Customer AI</span>
          <span className="lp-credit">
            Photography from <a href="https://www.pexels.com/" target="_blank" rel="noreferrer">Pexels</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
