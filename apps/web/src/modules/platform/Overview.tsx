import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Armchair, Building2, CheckCircle2, ChevronRight, CreditCard, LifeBuoy, ShieldAlert, Users } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { date, dateTime, money, relTime } from '../../lib/format';
import { Banner, Card, CardHeader, ErrorState, KpiRow, LoadingBlock, PageHeader, Boundary, EmptyState, StatusPill } from '../../components/ui';
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
      <Attention a={d.attention} failedJobs={d.jobs.failed_7d} />
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

/** What a platform admin should act on today: urgent / overdue tickets, billing problems, live support sessions. */
function Attention({ a, failedJobs }: { a: any; failedJobs: number }) {
  const total = a.tickets.length + a.billing.length + a.sessions.length + (failedJobs ? 1 : 0);
  if (!total) return <div className="st-allclear"><CheckCircle2 size={18} /> <b>All clear.</b> No urgent tickets, billing problems or live support sessions right now.</div>;
  const billingReason = (b: any) => b.status === 'suspended' ? `Suspended ${b.suspended_at ? relTime(b.suspended_at) : ''}` : b.status === 'grace' ? `Grace period ends ${b.grace_ends_at ? date(b.grace_ends_at) : 'soon'}` : b.failed_invoices ? `${b.failed_invoices} failed invoice${b.failed_invoices === 1 ? '' : 's'}` : `Trial ends ${b.trial_ends_at ? relTime(b.trial_ends_at) : 'soon'}`;
  return (
    <Card>
      <CardHeader title={<span className="row" style={{ gap: 8 }}><AlertTriangle size={16} color="var(--warning)" /> Needs attention <span className="st-count">{total}</span></span>} />
      <div className="st-attn">
        <div>
          <div className="st-attn-h"><LifeBuoy size={14} /> Support <Link to="/platform/tickets?view=urgent">Open inbox</Link></div>
          {a.tickets.length === 0 ? <div className="st-attn-empty">No urgent or overdue tickets</div> : a.tickets.map((t: any) => (
            <Link key={t.id} to={`/platform/tickets?view=all&ticket=${t.id}`} className="st-attn-row">
              <span className={`hd-prio hd-prio-${t.priority}`} />
              <span className="st-attn-main"><b className="truncate">#{t.number} {t.subject}</b><span className="tiny muted">{t.org_name ?? 'No agency'} · {relTime(t.last_activity_at)}</span></span>
              {t.overdue ? <StatusPill status="overdue" label="Overdue" tone="red" /> : <StatusPill status={t.priority} />}
              <ChevronRight size={15} />
            </Link>))}
        </div>
        <div>
          <div className="st-attn-h"><CreditCard size={14} /> Billing <Link to="/platform/invoices">Invoices</Link></div>
          {a.billing.length === 0 ? <div className="st-attn-empty">No billing problems</div> : a.billing.map((b: any) => (
            <Link key={b.id} to={`/platform/agencies/${b.id}`} className="st-attn-row">
              <span className="st-attn-main"><b className="truncate">{b.name}</b><span className="tiny muted">{billingReason(b)}</span></span>
              <StatusPill status={b.status} />
              <ChevronRight size={15} />
            </Link>))}
        </div>
        <div>
          <div className="st-attn-h"><ShieldAlert size={14} /> Live & system <Link to="/platform/impersonation">Sessions</Link></div>
          {a.sessions.map((x: any) => (
            <Link key={x.id} to="/platform/impersonation" className="st-attn-row">
              <span className="st-attn-main"><b className="truncate">{x.agent} → {x.target}</b><span className="tiny muted">{x.org_name} · started {relTime(x.started_at)}</span></span>
              <StatusPill status="active" label="Live" />
              <ChevronRight size={15} />
            </Link>))}
          {failedJobs > 0 && <Link to="/platform/system" className="st-attn-row"><span className="st-attn-main"><b>{failedJobs} failed background job{failedJobs === 1 ? '' : 's'}</b><span className="tiny muted">In the last 7 days</span></span><StatusPill status="failed" /><ChevronRight size={15} /></Link>}
          {!a.sessions.length && !failedJobs && <div className="st-attn-empty">No live sessions or failed jobs</div>}
        </div>
      </div>
    </Card>
  );
}
