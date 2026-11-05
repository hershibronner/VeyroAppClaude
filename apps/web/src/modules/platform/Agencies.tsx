import { Building2 } from 'lucide-react';
import { date, money, relTime } from '../../lib/format';
import { PageHeader, StatusPill } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';

export default function AgenciesPage() {
  return (
    <div className="stack">
      <PageHeader title="Agencies" sub="Every tenant on VeyroApp with plan, seats, usage and billing status." />
      <DataTable<any> title="Agencies" endpoint="/api/v1/platform/agencies" rowLink={r => `/platform/agencies/${r.id}`} exportName="agencies" defaultSort="name" defaultDir="asc"
        filters={[{ key: 'status', label: 'Status', options: opts(['trialing', 'active', 'grace', 'suspended', 'cancelled']) }, { key: 'plan', label: 'Plan', options: opts(['trial', 'standard', 'white_label']) }, { key: 'comped', label: 'Comped', type: 'boolean' }]}
        columns={[
          { key: 'name', label: 'Agency', sortable: true, mobile: 'title', render: r => <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><span className="st-logo" style={{ background: r.primary_color ?? 'var(--ink)', width: 30, height: 30 }}>{(r.logo_text || r.name).split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}</span><span><div className="bold">{r.name}</div><div className="tiny muted">{r.slug}</div></span></span> },
          { key: 'plan_name', label: 'Plan', mobile: 'subtitle', render: r => <span>{r.plan_name ?? '—'}{r.comped && <> <StatusPill status="comped" label="Comped" tone="purple" /></>}</span> },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
          { key: 'seats', label: 'Seats', sortable: true, align: 'right' },
          { key: 'mrr_cents', label: 'MRR', align: 'right', render: r => <span title={`Gross ${money(r.mrr_gross_cents)}`}>{money(r.mrr_cents)}</span>, csv: r => (r.mrr_cents / 100).toFixed(2) },
          { key: 'staff', label: 'Staff', sortable: true, align: 'right' },
          { key: 'client_users', label: 'Client users', align: 'right' },
          { key: 'open_tickets', label: 'Open tickets', align: 'right' },
          { key: 'last_active_at', label: 'Last active', render: r => r.last_active_at ? relTime(r.last_active_at) : '—' },
          { key: 'created_at', label: 'Created', sortable: true, render: r => date(r.created_at) },
        ]}
        emptyText={<span className="row" style={{ gap: 6, justifyContent: 'center' }}><Building2 size={14} /> Agencies appear here when they register.</span>} />
    </div>
  );
}
