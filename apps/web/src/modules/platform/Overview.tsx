import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Armchair, Building2, CreditCard, LifeBuoy, ShieldAlert, Users } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { Banner, Card, CardHeader, ErrorState, KpiRow, LoadingBlock, PageHeader, Boundary, EmptyState } from '../../components/ui';
import { ChartCard, TrackBars, TrendLine, fmtMoney } from '../../components/charts';

export default function PlatformOverview() {
  const st = useApi<any>('/api/v1/platform/overview');
  const info = useApi<any>('/api/v1/platform/public-settings');
  const nav = useNavigate();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Control center" /><Card><LoadingBlock rows={8} /></Card></div>;
  const d = st.data;
  const hist = d.seat_history;
  const prev = hist[hist.length - 2]?.avg_seats; const cur = hist[hist.length - 1]?.avg_seats;
  return (
    <div className="stack">
      <PageHeader title="Control center" sub={`${d.agencies} agencies · ${d.staff_users} staff users on VeyroApp`} />
      {info.data?.maintenance_banner && <Banner tone="warn">Maintenance banner is live for all agencies: “{info.data.maintenance_banner}”</Banner>}
      {d.invoices.failed > 0 && <Banner tone="danger">{d.invoices.failed} SaaS invoice{d.invoices.failed === 1 ? '' : 's'} failed payment. <a href="/platform/invoices?status=failed" onClick={e => { e.preventDefault(); nav('/platform/invoices?status=failed'); }}>Review dunning</a>.</Banner>}
      {d.active_impersonations > 0 && <Banner tone="warn" icon={<ShieldAlert size={18} />}>{d.active_impersonations} support session{d.active_impersonations === 1 ? ' is' : 's are'} active right now.</Banner>}
      {d.tickets.urgent > 0 && <Banner>{d.tickets.urgent} high-priority support ticket{d.tickets.urgent === 1 ? '' : 's'} need attention.</Banner>}
      <KpiRow items={[
        { label: 'Agencies', value: d.agencies, icon: <Building2 size={16} />, deltaText: Object.entries(d.statuses).map(([k, v]) => `${v} ${k}`).join(' · '), suffix: '', to: '/platform/agencies' },
        { label: 'Active seats', value: d.seats, icon: <Armchair size={16} />, delta: prev ? ((cur - prev) / prev) * 100 : null, suffix: 'avg vs last month', to: '/platform/seats?status=active' },
        { label: 'MRR (billable)', value: money(d.mrr_net_cents, 'USD', { noCents: true }), icon: <CreditCard size={16} />, deltaText: `${money(d.mrr_gross_cents, 'USD', { noCents: true })} before comps & trials`, suffix: '', to: '/platform/invoices' },
        { label: 'Open tickets', value: d.tickets.open + d.tickets.pending, icon: <LifeBuoy size={16} />, deltaText: `${d.tickets.open} waiting on us`, suffix: '', to: '/platform/tickets?status=open' },
      ]} />
      <div className="grid-2">
        <Boundary label="Seats chart"><ChartCard title="Average active seats" big={cur ?? 0} delta={<span className="muted">this month across all agencies</span>}>
          <TrackBars data={hist.map((h: any) => ({ label: h.label, value: h.avg_seats }))} fmt={v => `${v} seats`} height={240} onBarClick={() => nav('/platform/seats')} />
        </ChartCard></Boundary>
        <Boundary label="Billing chart"><ChartCard title="Billed per month (SaaS invoices)" big={money(d.billed_trend[d.billed_trend.length - 1]?.billed ?? 0, 'USD', { noCents: true })} delta={<span className="muted">{money(d.invoices.outstanding)} outstanding · {money(d.invoices.collected)} collected since last month</span>}>
          {d.billed_trend.length ? <TrendLine data={d.billed_trend.map((r: any) => ({ label: r.label, value: r.billed, gross: r.gross }))} series={[{ key: 'gross', name: 'Seat value' }, { key: 'value', name: 'Billed' }]} fmt={fmtMoney} height={240} onPointClick={() => nav('/platform/invoices')} /> : <EmptyState title="No invoices yet" />}
        </ChartCard></Boundary>
      </div>
      <div className="grid-2">
        <Card>
          <CardHeader title="Background jobs" right={<a className="small" href="/platform/system" onClick={e => { e.preventDefault(); nav('/platform/system'); }}>System health</a>} />
          <div className="card-b"><KpiRow compact items={[{ label: 'Queued', value: d.jobs.queued, to: '/platform/system' }, { label: 'Running', value: d.jobs.running, to: '/platform/system' }, { label: 'Failed (7d)', value: d.jobs.failed_7d, icon: d.jobs.failed_7d ? <AlertTriangle size={16} /> : undefined, to: '/platform/system' }]} /></div>
        </Card>
        <Card>
          <CardHeader title="Recent platform activity" right={<a className="small" href="/platform/security" onClick={e => { e.preventDefault(); nav('/platform/security'); }}>Audit & security</a>} />
          {d.recent.length === 0 ? <EmptyState icon={<Users size={22} />} title="Nothing yet" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.recent.map((r: any) => <div key={r.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="small"><b>{r.actor_label ?? 'System'}</b> <span className="mono">{r.action}</span> {r.entity_label ?? ''}</div><div className="tiny muted">{r.org_name ?? 'Platform'} · {dateTime(r.created_at)}</div></div></div>)}</div>}
        </Card>
      </div>
    </div>
  );
}
