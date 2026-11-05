import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarChart3, Plus, Activity as ActivityIcon, CheckCircle2 } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, relTime, humanize } from '../../lib/format';
import { Banner, Boundary, Button, Card, CardHeader, EmptyState, ErrorState, KpiRow, LoadingBlock, Menu, PageHeader, RangeSelect, Skeleton, Avatar, StatusPill } from '../../components/ui';
import { ChartCard, TrendLine, TrackBars, Funnel, SimpleBars, fmtMoney, fmtMoneyCompact, fmtHours } from '../../components/charts';
import { useQuickCreate } from '../../components/QuickCreate';
import { kpiItems, chunk, AttentionList, type ApiKpi, type AttentionGroup } from './kit';

function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

export default function Home() {
  const nav = useNavigate();
  const { me } = useAuth();
  const qc = useQuickCreate();
  const [months, setMonths] = useState(6);
  const home = useApi<any>('/api/v1/dashboard/home');
  const d = home.data;
  const first = me?.user.name.split(' ')[0] ?? '';
  const actions = (
    <>
      <RangeSelect value={months} onChange={setMonths} />
      <Button icon={<BarChart3 size={16} />} onClick={() => nav('/analytics')}>View analytics</Button>
      {qc.items.length > 0 && <Menu label="Create" align="right" trigger={<Button variant="primary" icon={<Plus size={16} />}>Create</Button>} items={qc.items.map(i => ({ label: `New ${i.label}`, icon: i.icon, onClick: () => qc.open(i.key) }))} />}
      {qc.element}
    </>
  );
  const header = <PageHeader title={`${greeting()}, ${first}`} sub={`${date(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })}${d ? ` · ${d.role.name} view` : ''}`} actions={actions} />;
  if (home.error && !d) return <>{header}<ErrorState error={home.error} retry={home.reload} /></>;
  if (!d) return <>{header}<div className="kpis" style={{ marginBottom: 24 }}>{[0, 1, 2, 3].map(i => <div key={i} className="kpi"><Skeleton h={14} w="60%" /><Skeleton h={38} w="70%" style={{ margin: '12px 0' }} /><Skeleton h={12} w="80%" /></div>)}</div><LoadingBlock rows={8} /></>;
  const kpis = kpiItems(d.kpis as ApiKpi[]);
  const charts = d.charts as Record<string, boolean>;
  return (
    <div>
      {header}
      {d.banners.length > 0 && (
        <div className="ins-banners">
          {d.banners.slice(0, 3).map((b: any, i: number) => <Banner key={i} tone={b.tone}>{i === 0 && b.tone === 'info' ? <b>Heads up! </b> : null}{b.text} <Link to={b.link}>{b.cta}</Link></Banner>)}
        </div>
      )}
      {kpis.length > 0 && <div className="ins-kpi-stack">{chunk(kpis, 4).map((row, i) => <KpiRow key={i} items={row} />)}</div>}
      <div className="ins-grid">
        <div className="ins-col">
          {(charts.revenue || charts.margin) && <div className="ins-charts">
            {charts.revenue && <Boundary label="Revenue vs payroll"><RevenueChart months={months} /></Boundary>}
            {charts.margin && <Boundary label="Margin by client"><MarginChart months={months} /></Boundary>}
          </div>}
          {(charts.funnel || charts.hours) && <div className="ins-charts">
            {charts.funnel && <Boundary label="Recruiting funnel"><FunnelChart months={months} /></Boundary>}
            {charts.hours && <Boundary label="Hours by day"><HoursChart /></Boundary>}
          </div>}
          <Boundary label="Recent activity"><ActivityFeed /></Boundary>
        </div>
        <div className="ins-col">
          <Boundary label="Needs attention">
            <Card>
              <CardHeader title="Needs attention" right={<Link className="small" to="/attention">View all</Link>} />
              {d.attention.length ? <AttentionList groups={d.attention as AttentionGroup[]} /> : <EmptyState icon={<CheckCircle2 size={22} />} title="All clear" text="Nothing needs your attention right now." />}
            </Card>
          </Boundary>
          <Boundary label="My tasks"><MyTasksWidget /></Boundary>
        </div>
      </div>
    </div>
  );
}

function RevenueChart({ months }: { months: number }) {
  const nav = useNavigate();
  const st = useApi<any>(`/api/v1/dashboard/revenue-trend?months=${months}`);
  const d = st.data;
  return (
    <ChartCard title="Revenue vs payroll" big={d ? fmtMoney(d.totals.revenue) : undefined} delta={d ? <span>{d.totals.delta !== null ? <><b className={d.totals.delta >= 0 ? 'up' : 'down'}>{d.totals.delta >= 0 ? '+' : ''}{d.totals.delta.toFixed(1)}%</b> vs previous {months} months</> : <span className="muted">Invoiced over the last {months} months</span>}</span> : undefined}>
      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <Skeleton h={240} /> : d.rows.some((r: any) => r.revenue || r.payroll) ?
        <TrendLine data={d.rows} fmt={fmtMoneyCompact} series={[{ key: 'revenue', name: 'Revenue' }, ...(d.showPayroll ? [{ key: 'payroll', name: 'Payroll' }] : [])]} onPointClick={(p: any) => { const to = new Date(Date.UTC(+p.month.slice(0, 4), +p.month.slice(5, 7), 0)).toISOString().slice(0, 10); nav(`/finance/invoices?from=${p.month}&to=${to}`); }} />
        : <div className="ins-empty-chart">No invoices in this period</div>}
    </ChartCard>
  );
}
function MarginChart({ months }: { months: number }) {
  const nav = useNavigate();
  const st = useApi<any>(`/api/v1/dashboard/margin-by-client?months=${months}`);
  const d = st.data;
  return (
    <ChartCard title="Gross margin by client" big={d ? (d.total.pct !== null ? `${d.total.pct.toFixed(1)}%` : '—') : undefined} delta={d ? <span className="muted">{fmtMoney(d.total.rev - d.total.cost)} gross profit on approved hours</span> : undefined}>
      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <Skeleton h={240} /> : d.rows.length ?
        <TrackBars data={d.rows.slice(0, 6).map((r: any) => ({ ...r, label: r.label.split(/\s+/)[0] }))} fmt={v => `${v.toFixed(1)}%`} valueName="Margin" onBarClick={(r: any) => r.link && nav(r.link)} /> : <div className="ins-empty-chart">No approved hours in this period</div>}
    </ChartCard>
  );
}
function FunnelChart({ months }: { months: number }) {
  const nav = useNavigate();
  const st = useApi<any>(`/api/v1/dashboard/funnel?months=${months}`);
  const d = st.data;
  const hired = d?.steps.find((s: any) => s.key === 'hired')?.value ?? 0;
  const applied = d?.steps[0]?.value ?? 0;
  return (
    <ChartCard title="Recruiting funnel" big={d ? applied.toLocaleString() : undefined} delta={d ? <span className="muted">applications · {applied ? ((hired / applied) * 100).toFixed(1) : '0.0'}% hired</span> : undefined}>
      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <Skeleton h={220} /> : <Funnel steps={d.steps} onStepClick={(s: any) => { const st2 = d.steps.find((x: any) => x.key === s.key); if (st2?.link) nav(st2.link); }} />}
    </ChartCard>
  );
}
function HoursChart() {
  const nav = useNavigate();
  const [days, setDays] = useState(14);
  const st = useApi<any>(`/api/v1/dashboard/hours-by-day?days=${days}`);
  const d = st.data;
  return (
    <ChartCard title="Hours by day" big={d ? fmtHours(d.total) : undefined} delta={d ? (d.delta !== null ? <span><b className={d.delta >= 0 ? 'up' : 'down'}>{d.delta >= 0 ? '+' : ''}{d.delta.toFixed(1)}%</b> vs previous {days} days</span> : <span className="muted">tracked</span>) : undefined}
      control={<select className="select input-sm" style={{ width: 'auto', height: 32, fontSize: 13 }} value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Range"><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select>}>
      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <Skeleton h={220} /> : <SimpleBars data={d.rows} fmt={fmtHours} onBarClick={(r: any) => r.link && nav(r.link)} />}
    </ChartCard>
  );
}

function MyTasksWidget() {
  const st = useApi<any>('/api/v1/dashboard/my-tasks?status=open&pageSize=8');
  const [busy, setBusy] = useState<string | null>(null);
  const complete = async (id: string) => {
    setBusy(id);
    try { await api.post(`/api/v1/dashboard/my-tasks/${id}/status`, { status: 'done' }); toast.success('Task completed'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const d = st.data;
  return (
    <Card>
      <CardHeader title="My tasks" sub={d ? `${d.counts.open} open${d.counts.overdue ? ` · ${d.counts.overdue} overdue` : ''}` : undefined} right={<Link className="small" to="/my-tasks">View all</Link>} />
      {st.error && !d ? <div style={{ padding: 16 }}><ErrorState error={st.error} retry={st.reload} /></div> : !d ? <LoadingBlock rows={4} /> : d.rows.length === 0 ? <EmptyState icon={<CheckCircle2 size={22} />} title="You're all caught up" text="No open tasks are assigned to you." /> : (
        <div>
          {d.rows.map((t: any) => (
            <div key={t.id} className="ins-task">
              <input type="checkbox" aria-label={`Complete ${t.title}`} disabled={busy === t.id} onChange={() => complete(t.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link to={`/my-tasks?task=${t.id}`} className="t" style={{ color: 'inherit', textDecoration: 'none' }}>{t.title}</Link>
                <div className="small muted">{t.due_date ? <span className={t.overdue ? 'down' : ''}>{t.overdue ? 'Overdue · ' : 'Due '}{date(t.due_date, { month: 'short', day: 'numeric' })}</span> : 'No due date'}{t.related_label && <> · {t.related_link ? <Link to={t.related_link}>{t.related_label}</Link> : t.related_label}</>}</div>
              </div>
              {['high', 'urgent'].includes(t.priority) && <StatusPill status={t.priority} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityFeed() {
  const st = useApi<any>('/api/v1/dashboard/activity?limit=12');
  const d = st.data;
  return (
    <Card>
      <CardHeader title="Recent activity" right={<Link className="small" to="/crm/activities">View all</Link>} />
      <div className="card-b">
        {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock rows={5} /> : d.rows.length === 0 ? <EmptyState icon={<ActivityIcon size={22} />} title="No activity yet" /> : (
          <div className="timeline">
            {d.rows.map((a: any) => (
              <div key={a.id} className="tl-item">
                {a.actor_name ? <Avatar name={a.actor_name} color={a.actor_color} size={30} /> : <span className="tl-ic"><ActivityIcon size={14} /></span>}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="tl-title">{a.title}{a.entity_label && <> · {a.link ? <Link to={a.link}>{a.entity_label}</Link> : a.entity_label}</>}</div>
                  {a.body && <div className="tl-body">{a.body}</div>}
                  <div className="tl-meta">{a.actor_name ?? 'System'} · {humanize(a.entity_type)} · {relTime(a.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
