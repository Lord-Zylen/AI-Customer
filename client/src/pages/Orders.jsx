import { CreditCard, ExternalLink, PackageSearch, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, PageHeading, Panel } from '../components/UI';
import { api } from '../services/api';
import { formatDateTime } from '../lib/format';

const statusTone = status => (
  status === 'PAID' ? 'green'
  : status === 'FAILED' ? 'danger'
  : status === 'ABANDONED' ? 'neutral'
  : 'purple'
);

const money = (amount, currency) => new Intl.NumberFormat([], {
  style: 'currency',
  currency: currency || 'GHS',
  maximumFractionDigits: 2,
}).format(Number(amount) || 0);

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setOrders(await api('/orders'));
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  return (
    <>
      <PageHeading
        eyebrow="COMMERCE"
        title="Orders"
        description="Orders confirmed on WhatsApp and their Paystack payment links."
        action={<Button variant="outline" size="sm" icon={<RefreshCw size={15} />} onClick={load}>Refresh</Button>}
      />
      {error && <ErrorState description={error} onRetry={load} />}

      <Panel className="table-panel">
        {loading ? (
          <div className="empty-state"><CreditCard size={24} /><p>Loading orders…</p></div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<PackageSearch size={26} />}
            title="No orders yet"
            description="When a customer confirms an order, the agent creates a Paystack payment link and the order appears here."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Customer</th><th>Items</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order._id}>
                    <td className="cell-strong">{order.reference}</td>
                    <td>
                      <span className="cell-lines">
                        <span className="cell-strong">{order.customerName || order.customerId?.name || 'WhatsApp customer'}</span>
                        {order.customerId?.phone && <span>{order.customerId.phone}</span>}
                      </span>
                    </td>
                    <td className="cell-muted">
                      {order.items?.length
                        ? order.items.map(item => `${item.name} × ${item.quantity}`).join(', ')
                        : order.description || '—'}
                    </td>
                    <td className="cell-strong">{money(order.amount, order.currency)}</td>
                    <td><Badge tone={statusTone(order.status)}>{order.status}</Badge></td>
                    <td className="cell-muted">{formatDateTime(order.createdAt)}</td>
                    <td>
                      {order.paymentUrl
                        ? <Button variant="ghost" size="sm" className="button-compact" icon={<ExternalLink size={13} />} onClick={() => window.open(order.paymentUrl, '_blank', 'noopener,noreferrer')}>Pay link</Button>
                        : <span className="cell-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
