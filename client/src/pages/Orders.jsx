import { PackageSearch, ShoppingBag } from 'lucide-react';
import { PageHeading, Panel } from '../components/UI';

export default function Orders() {
  return (
    <>
      <PageHeading
        eyebrow="COMMERCE"
        title="Orders"
        description="Track orders discussed with customers on WhatsApp."
      />
      <Panel>
        <div className="empty-state">
          <span className="empty-state-icon"><PackageSearch size={26} /></span>
          <h3>No order tracking yet</h3>
          <p>Customer AI records customers and conversations, but order management hasn't been wired into this workspace yet. Orders will appear here — with status, value and delivery — as soon as order tracking is connected.</p>
          <span className="orders-soon"><ShoppingBag size={14} /> Order tracking is planned as a separate integration.</span>
        </div>
      </Panel>
    </>
  );
}