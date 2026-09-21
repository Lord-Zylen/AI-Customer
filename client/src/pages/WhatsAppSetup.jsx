import { CheckCircle2, ShieldCheck, Smartphone, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, PageHeading } from '../components/UI';

const api = import.meta.env.VITE_API_URL || '/api';

export default function WhatsAppSetup() {
  const [status, setStatus] = useState({ status: 'DISCONNECTED', managedBy: 'hermes' });
  const [error, setError] = useState('');
  const poll = async () => {
    try {
      const r = await fetch(`${api}/whatsapp/status`);
      setStatus(await r.json());
    } catch { /* the API may be briefly unreachable; the poll will retry */ }
  };
  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);
  const connected = status.status === 'CONNECTED';
  const managedByHermes = status.managedBy === 'hermes';
  return <>
    <PageHeading eyebrow="CHANNEL SETUP" title="WhatsApp connection" description="WhatsApp is handled by the Hermes gateway — Customer AI never runs a second connection." />
    <div className="whatsapp-setup">
      <article className="panel pairing-card">
        <div className="pairing-heading">
          <div className="wa-icon"><Smartphone size={23} /></div>
          <div>
            <h2>WhatsApp via Hermes gateway</h2>
            <p>Pair and connect WhatsApp with <code>hermes gateway</code>. Customer AI supervises replies through its decision webhook.</p>
          </div>
          <Badge tone={connected ? 'success' : 'neutral'}>{connected ? 'CONNECTED' : (status.status || 'DISCONNECTED').replaceAll('_', ' ')}</Badge>
        </div>
        {error && <p className="setup-error">{error}</p>}
        {managedByHermes ? (connected
          ? <div className="connected-state"><CheckCircle2 size={42} /><h3>WhatsApp is connected</h3><p>The Hermes gateway is receiving WhatsApp messages and replying only when Customer AI approves an automatic response.</p></div>
          : <div className="connected-state"><Unplug size={42} /><h3>Not connected yet</h3><p>Start the Hermes gateway and pair WhatsApp there. Customer AI keeps supervising as soon as the gateway is running.</p></div>)
          : <div className="connected-state"><ShieldCheck size={42} /><h3>Legacy direct connection removed</h3><p>Customer AI no longer opens its own WhatsApp Web session. Single transport, no duplicate replies.</p></div>}
      </article>
      <aside className="setup-guide">
        <h3>How it works</h3>
        <div><span>1</span><p>The Hermes gateway owns the WhatsApp account. Customer AI never pairs a second device.</p></div>
        <div><span>2</span><p>Every inbound WhatsApp message is checked by Customer AI before Hermes may reply.</p></div>
        <div><span>3</span><p>Routine questions get one automatic reply from Hermes. Sensitive or low-confidence requests are flagged for the human queue and stay silent.</p></div>
        <p className="setup-note">WhatsApp connection settings live in the Hermes gateway (<code>~/.hermes</code>), not in this app.</p>
      </aside>
    </div>
  </>;
}