import { CheckCircle2, RefreshCw, ShieldCheck, Smartphone, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, ErrorState, PageHeading, Panel, StatusPill } from '../components/UI';
import { formatDateTime } from '../lib/format';

const rawApi = import.meta.env.VITE_API_URL || '/api';

const steps = [
  ['1', 'Hermes owns the WhatsApp account', 'Customer AI never pairs a second device, so there is a single transport and no duplicate replies.'],
  ['2', 'Every inbound message is vetted', 'Customer AI checks intent and confidence before Hermes is allowed to reply at all.'],
  ['3', 'Safe tasks get one reply', 'Routine questions receive a single automatic reply. Sensitive or low-confidence requests stay silent and land in the human queue.'],
];

export default function WhatsAppSetup() {
  const [status, setStatus] = useState({ status: 'DISCONNECTED', managedBy: 'hermes' });
  const [error, setError] = useState('');
  const [lastCheck, setLastCheck] = useState(null);

  const poll = async () => {
    try {
      const r = await fetch(`${rawApi}/whatsapp/status`);
      setStatus(await r.json());
      setError('');
    } catch { /* briefly unreachable; retry on the next poll */ } finally {
      setLastCheck(Date.now());
    }
  };
  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const connected = status.status === 'CONNECTED';
  const hermesManaged = status.managedBy === 'hermes';

  return (
    <>
      <PageHeading
        eyebrow="CHANNEL SETUP"
        title="WhatsApp"
        description="WhatsApp is handled by the Hermes gateway — Customer AI supervises, never re-connects."
        action={<Badge tone={connected ? 'green' : 'neutral'}><StatusPill tone={connected ? 'good' : 'bad'}>{connected ? 'CONNECTED' : (status.status || 'DISCONNECTED').replaceAll('_', ' ')}</StatusPill></Badge>}
      />

      {error && <ErrorState description={error} onRetry={poll} />}

      <div className="whatsapp-setup">
        <div className="wa-hero">
          <div className={`wa-hero-icon ${connected ? 'ok' : 'idle'}`}>{connected ? <Smartphone size={30} /> : <Unplug size={30} />}</div>
          <div className="wa-hero-copy">
            <h2>{connected ? 'WhatsApp is live' : 'WhatsApp is not connected'}</h2>
            <p>
              {hermesManaged
                ? connected
                  ? 'The Hermes gateway is receiving messages and replying only when Customer AI approves an automatic response.'
                  : 'Start the Hermes gateway and pair WhatsApp there. Customer AI keeps supervising as soon as the gateway is running.'
                : 'Legacy direct connection removed — Customer AI now uses a single transport through Hermes.'}
            </p>
            <div className="wa-hero-meta">
              {status.phone && <span><Smartphone size={13} /> {status.phone}</span>}
              {status.updatedAt && <span>Last update {formatDateTime(status.updatedAt)}</span>}
              {status.gatewayState && <span className="cell-muted">gateway {status.gatewayState}</span>}
            </div>
          </div>
          <button className="button button-outline wa-refresh" onClick={poll} title="Refresh status"><RefreshCw size={15} /> Refresh</button>
        </div>

        <Panel className="setup-guide" title="How it works" description="WhatsApp connection settings live in the Hermes gateway (~/.hermes), not in this app.">
          <div className="guide-steps">
            {steps.map(([n, title, body]) => (
              <div className="guide-step" key={n}>
                <span className="guide-num">{n}</span>
                <div><h4>{title}</h4><p>{body}</p></div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}