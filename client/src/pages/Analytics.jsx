import { BarChart3, Bot, MessagesSquare, ShieldAlert, ShieldCheck, UserRoundCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState, KpiCard, PageHeading, Panel, Skeleton } from '../components/UI';
import { api } from '../services/api';

const pct = (n, total) => (!total ? 0 : Math.round((n / total) * 100));

export default function Analytics() {
  const [convos, setConvos] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setConvos(await api('/conversations'));
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  const total = convos.length;
  const open = convos.filter(c => c.status === 'OPEN').length;
  const human = convos.filter(c => c.status === 'HUMAN_REQUIRED' || c.requiresHuman).length;
  const resolved = convos.filter(c => c.status === 'RESOLVED').length;
  const aiOn = convos.filter(c => c.aiEnabled).length;
  const aiOff = total - aiOn;

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - i));
    const label = d.toLocaleDateString([], { weekday: 'short' });
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const count = convos.filter(c => {
      const t = new Date(c.lastMessageAt || c.updatedAt);
      return t >= d && t < next;
    }).length;
    return { label, count, max: 0 };
  });
  const dayMax = Math.max(1, ...days.map(d => d.count));

  const dist = [['In conversation', open, 'blue'], ['Human review', human, 'red'], ['Resolved', resolved, 'green']];

  return (
    <>
      <PageHeading eyebrow="MEASUREMENT" title="Analytics" description="Real numbers computed from your live workspace — no samples, no placeholders." />
      {error && <ErrorState description={error} onRetry={load} />}

      <div className="kpi-grid">
        <KpiCard label="Conversations" value={total} loading={loading} hint="All recorded" icon={<MessagesSquare size={17} />} tone="violet" />
        <KpiCard label="In conversation" value={open} loading={loading} hint={`${pct(open, total)}% of total`} icon={<Bot size={17} />} tone="blue" />
        <KpiCard label="Human review" value={human} loading={loading} hint="Escalated for approval" icon={<ShieldAlert size={17} />} tone="red" />
        <KpiCard label="Resolved" value={resolved} loading={loading} hint={`${pct(resolved, total)}% resolved`} icon={<ShieldCheck size={17} />} tone="green" />
      </div>

      <div className="analytics-grid">
        <Panel className="panel-pad" title="Conversation pipeline" description="Current status distribution.">
          {loading ? <div style={{ padding: 20 }}><Skeleton height={200} /></div> : (
            <div className="pipeline">
              {dist.map(([label, count, tone]) => (
                <div className="pipeline-row" key={label}>
                  <span className="pipeline-label"><span className={`dot dot-${tone}`} />{label}</span>
                  <div className="pipeline-track"><div className={`pipeline-fill fill-${tone}`} style={{ width: `${pct(count, total)}%` }} /></div>
                  <b>{count}</b><em>{pct(count, total)}%</em>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="panel-pad" title="AI vs human handled" description="How many conversations keep AI enabled.">
          {loading ? <div style={{ padding: 20 }}><Skeleton height={120} /></div> : (
            <div className="split">
              <div className="split-bar"><span className="split-ai" style={{ width: `${pct(aiOn, total)}%` }} /><span className="split-human" style={{ width: `${pct(aiOff, total)}%` }} /></div>
              <div className="split-legend">
                <div><span className="dot dot-blue" /><b>{aiOn}</b> AI enabled <em>{pct(aiOn, total)}%</em></div>
                <div><span className="dot dot-neutral" /><b>{aiOff}</b> AI paused <em>{pct(aiOff, total)}%</em></div>
              </div>
            </div>
          )}
        </Panel>

        <Panel className="panel-pad analytics-activity" title="Conversation activity — last 7 days" description="Conversations with activity per day (latest message).">
          {loading ? <div style={{ padding: 20 }}><Skeleton height={140} /></div> : (
            <div className="bars">
              {days.map((d, i) => (
                <div className="bar-col" key={i} title={`${d.label}: ${d.count}`}>
                  <div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(4, (d.count / dayMax) * 100)}%` }} /></div>
                  <span>{d.label}</span>
                  <b>{d.count}</b>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <p className="analytics-note"><UserRoundCheck size={13} /> Counts are computed from the conversations currently served by the API (up to the latest 100). Orders analytics will appear once order tracking is connected.</p>
    </>
  );
}