import { useSearchParams } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { date, money, relTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { PageHeader, StatusPill } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'trialing', label: 'Trialing' },
  { key: 'grace', label: 'Grace period' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** Plain-language health for one agency row: what (if anything) a platform admin should look at. */
export function agencyHealth(r: any): { tone: 'green' | 'amber' | 'red' | 'gray'; label: string } {
  if (r.status === 'suspended') return { tone: 'red', label: 'Suspended' };
  if (r.failed_invoices) return { tone: 'red', label: `${r.failed_invoices} failed invoice${r.failed_invoices === 1 ? '' : 's'}` };
  if (r.status === 'grace') return { tone: 'amber', label: 'Card needs updating' };
  if (r.status === 'trialing' && r.trial_ends_at) {
    const days = Math.ceil((new Date(r.trial_ends_at).getTime() - Date.now()) / 864e5);
    if (days < 0) return { tone: 'red', label: 'Trial expired' };
    if (days <= 7) return { tone: 'amber', label: `Trial ends in ${days}d` };
  }
  if (!r.last_active_at) return { tone: 'gray', label: 'Never signed in' };
  if (Date.now() - new Date(r.last_active_at).getTime() > 14 * 864e5) return { tone: 'amber', label: 'Quiet 14+ days' };
  if (r.open_tickets) return { tone: 'gray', label: `${r.open_tickets} open ticket${r.open_tickets === 1 ? '' : 's'}` };
  return { tone: 'green', label: 'Healthy' };
}

export const AgencyLogo = ({ r, size = 32 }: { r: { name: string; logo_text?: string | null; primary_color?: string | null }; size?: number }) => (
  <span className="st-logo" style={{ background: r.primary_color ?? 'var(--ink)', width: size, height: size, fontSize: size * 0.36, flex: 'none' }}>{(r.logo_text || r.name).split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
);

export default function AgenciesPage() {
  const [sp, setSp] = useSearchParams();
  const sum = useApi<any>('/api/v1/platform/agencies-summary');
  const status = sp.get('status') ?? '';
  const s = sum.data;
  const setStatus = (v: string) => { const n = new URLSearchParams(sp); v ? n.set('status', v) : n.delete('status'); n.delete('page'); setSp(n, { replace: true }); };
  return (
    <div className="stack">
      <PageHeader title="Agencies" sub="Every tenant on VeyroApp — plan, seats, revenue and health at a glance." />
      {s && <div className="st-sumstrip">
        <div><span>Agencies</span><b>{s.total}</b></div>
        <div><span>Billable MRR</span><b>{money(s.mrr_cents, 'USD', { noCents: true })}</b></div>
        <div><span>Active seats</span><b>{s.seats}</b></div>
        <div><span>Trialing</span><b>{s.by_status.trialing ?? 0}</b></div>
        <div className={s.at_risk ? 'warn' : ''}><span>Need attention</span><b>{s.at_risk}</b></div>
      </div>}
      <div className="tabs st-tabs" role="tablist">{STATUS_TABS.map(t => {
        const n = t.key ? s?.by_status[t.key] ?? 0 : s?.total;
        if (t.key && !n && status !== t.key) return null;
        return <button key={t.key} role="tab" aria-selected={status === t.key} className={status === t.key ? 'on' : ''} onClick={() => setStatus(t.key)}>{t.label}{n != null && <span className="count">{n}</span>}</button>;
      })}</div>
      <DataTable<any> title="Agencies" endpoint="/api/v1/platform/agencies" rowLink={r => `/platform/agencies/${r.id}`} exportName="agencies" defaultSort="name" defaultDir="asc"
        filters={[{ key: 'plan', label: 'Plan', options: opts(['trial', 'standard', 'white_label']) }, { key: 'comped', label: 'Comped', type: 'boolean' }]}
        params={{ status: status || undefined }}
        searchPlaceholder="Search agency name or slug"
        columns={[
          { key: 'name', label: 'Agency', sortable: true, mobile: 'title', render: r => <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><AgencyLogo r={r} /><span><div className="bold">{r.name}</div><div className="tiny muted">{r.slug}</div></span></span> },
          { key: 'health', label: 'Health', mobile: 'subtitle', render: r => { const h = agencyHealth(r); return <StatusPill status={h.tone} tone={h.tone} label={h.label} />; }, csv: r => agencyHealth(r).label },
          { key: 'plan_name', label: 'Plan', render: r => <span>{r.plan_name ?? '—'}{r.comped && <> <StatusPill status="comped" label="Comped" tone="purple" dot={false} /></>}</span> },
          { key: 'status', label: 'Subscription', sortable: true, render: r => <StatusPill status={r.status} /> },
          { key: 'seats', label: 'Seats', sortable: true, align: 'right' },
          { key: 'mrr_cents', label: 'MRR', align: 'right', render: r => <span title={`Gross ${money(r.mrr_gross_cents)}`} className="bold">{money(r.mrr_cents)}</span>, csv: r => (r.mrr_cents / 100).toFixed(2) },
          { key: 'staff', label: 'Staff', sortable: true, align: 'right' },
          { key: 'open_tickets', label: 'Tickets', align: 'right', render: r => r.open_tickets ? <span className="bold" style={{ color: 'var(--warning-600)' }}>{r.open_tickets}</span> : <span className="muted">0</span> },
          { key: 'last_active_at', label: 'Last active', render: r => r.last_active_at ? relTime(r.last_active_at) : <span className="muted">Never</span> },
          { key: 'created_at', label: 'Customer since', sortable: true, render: r => date(r.created_at) },
        ]}
        emptyText={<span className="row" style={{ gap: 6, justifyContent: 'center' }}><Building2 size={14} /> {status ? 'No agencies with this status.' : 'Agencies appear here when they register.'}</span>} />
    </div>
  );
}
