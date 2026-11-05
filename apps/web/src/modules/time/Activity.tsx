import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon, Clock, Coffee, AppWindow, Image as ImageIcon, Keyboard, MousePointer2, ShieldCheck } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Avatar, KpiRow, EmptyState, ErrorState, LoadingBlock, Banner, Boundary, Drawer, DateRangePicker, PermissionDenied, Skeleton, type DateRange } from '../../components/ui';
import { ChartCard, TrendLine, TrackBars } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { qs } from '../../lib/api';
import { todayISO, addDaysISO, shortDate, date, num } from '../../lib/format';
import { hm } from '../workforce/shared';
import './time.css';

const pctFmt = (v: number) => `${Math.round(v)}%`;
const minFmt = (v: number) => hm(v);

/** "Apps & Activity": where tracked time goes (apps / URLs), activity trend, productive vs idle. Counts only — never content. */
export default function Activity() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const to = sp.get('to') || todayISO();
  const from = sp.get('from') || addDaysISO(to, -13);
  const company = sp.get('company_id') ?? '';
  const worker = sp.get('worker_id') ?? '';
  const appSel = sp.get('app');
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const range: DateRange = { from, to, label: sp.get('range_label') ?? undefined };
  const scopeQs = qs({ from, to, company_id: company, worker_id: worker });
  const ov = useApi<any>(can('time', 'view') ? `/api/v1/time/activity/overview${scopeQs}` : null);
  if (!can('time', 'view')) return <PermissionDenied text="Your role cannot view team activity." />;
  const d = ov.data;
  const k = d?.kpis;
  const filters = d?.filters ?? { companies: [], workers: [] };
  const workerName = worker ? filters.workers.find((w: any) => w.id === worker)?.name : null;
  const companyName = company ? filters.companies.find((c: any) => c.id === company)?.name : null;
  const openWorkerDay = (id: string, day?: string | null) => nav(`/time/screenshots${qs({ worker_id: id, date: day && day <= todayISO() ? day : to })}`);
  const drop = k && k.avg_activity !== null && k.prev_avg_activity !== null ? k.avg_activity - k.prev_avg_activity : null;
  const trendHasData = d?.trend?.some((t: any) => t.has_data);

  return (
    <div>
      <PageHeader title="Apps & Activity" sub={<>Which apps and URLs {workerName ?? companyName ?? 'the team'} spend tracked time in · {date(from)} – {date(to)}</>} actions={<>
        <DateRangePicker value={range} onChange={r => set({ from: r.from, to: r.to, range_label: r.label ?? null })} />
        <div className="tm-filters">
          <select className="select" aria-label="Client" value={company} onChange={e => set({ company_id: e.target.value || null, worker_id: null })}><option value="">All clients</option>{filters.companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select className="select" aria-label="Worker" value={worker} onChange={e => set({ worker_id: e.target.value || null })}><option value="">All workers</option>{filters.workers.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </div>
        <Button variant="primary" icon={<ImageIcon size={16} />} onClick={() => nav(worker ? `/time/screenshots${qs({ worker_id: worker, date: to })}` : '/time/screenshots')}>Screenshots & Activity</Button>
      </>} />

      {ov.error && !d ? <ErrorState error={ov.error} retry={ov.reload} /> : !d ? <><Skeleton h={88} style={{ marginBottom: 24 }} /><LoadingBlock rows={8} /></> : <>
        {drop !== null && drop <= -5
          ? <Banner tone="warn">Average activity is <b>{k.avg_activity}%</b>, down <b>{Math.abs(drop)} points</b> from {k.prev_avg_activity}% in the previous {d.range.days} days. <a href="#workers" onClick={e => { e.preventDefault(); document.getElementById('tm-workers')?.scrollIntoView({ behavior: 'smooth' }); }}>See who →</a></Banner>
          : <Banner tone="info" icon={<ShieldCheck size={16} />}>Activity is measured from keyboard and mouse <b>counts</b> and app / URL labels only — keystrokes, typed text and page content are never recorded.</Banner>}

        <KpiRow items={[
          { label: 'Avg. activity', icon: <ActivityIcon size={16} />, value: k.avg_activity !== null ? `${k.avg_activity}%` : '—', delta: drop, suffix: drop !== null ? `pts vs previous ${d.range.days} days` : '', deltaText: drop === null ? <span>no earlier data to compare</span> : undefined, onClick: () => document.getElementById('tm-trend')?.scrollIntoView({ behavior: 'smooth' }) },
          { label: 'Active hours', icon: <Clock size={16} />, value: hm(k.active_minutes), deltaText: <span>{hm(k.tracked_minutes)} tracked · {k.sessions} sessions</span>, suffix: '', to: `/time/timesheets${qs({ company_id: company })}` },
          { label: 'Idle hours', icon: <Coffee size={16} />, value: hm(k.idle_minutes), deltaText: <span>{k.monitored_minutes ? Math.round((k.idle_minutes * 100) / k.monitored_minutes) : 0}% of monitored time</span>, suffix: '', invert: true, onClick: () => document.getElementById('tm-split')?.scrollIntoView({ behavior: 'smooth' }) },
          { label: 'Top app', icon: <AppWindow size={16} />, value: k.top_app ? <span className="truncate" style={{ display: 'block' }} title={k.top_app.label}>{k.top_app.label}</span> : '—', deltaText: k.top_app ? <span>{hm(k.top_app.minutes)} · {k.top_app.share_pct}% of active time</span> : <span>no app data</span>, suffix: '', onClick: () => k.top_app && set({ app: k.top_app.label }) },
        ]} />

        {!d.apps.length && !trendHasData ? <Card pad><EmptyState icon={<ActivityIcon size={22} />} title="No activity in this range" text="Activity appears once workers track time with the web tracker. Try a wider date range or another client." action={<Button onClick={() => set({ from: addDaysISO(to, -89), range_label: 'Last 90 days' })}>Show last 90 days</Button>} /></Card> : <>
          <div className="grid-2" style={{ marginBottom: 24 }}>
            <div id="tm-trend"><Boundary label="Activity trend">
              <ChartCard title="Activity % trend" big={k.avg_activity !== null ? `${k.avg_activity}%` : '—'} delta={<span className="muted small">active ÷ monitored seconds per day{worker ? ' · click a day to open the timeline' : ''}</span>}>
                {trendHasData ? <TrendLine data={d.trend.map((t: any) => ({ ...t, value: t.has_data ? t.value : null }))} fmt={pctFmt} height={240} onPointClick={worker ? (p: any) => openWorkerDay(worker, p.day) : undefined} /> : <EmptyState title="No activity samples" />}
              </ChartCard>
            </Boundary></div>
            <Boundary label="Top apps">
              <ChartCard title="Top apps" big={hm(k.active_minutes)} delta={<span className="muted small">active time per app · click a bar to see who uses it</span>}>
                {d.apps.length ? <TrackBars data={d.apps.slice(0, 8).map((a: any) => ({ label: a.label, value: a.active_minutes }))} fmt={minFmt} height={240} valueName="Active" highlight={appSel ?? undefined} onBarClick={(b: any) => b?.label && set({ app: b.label })} /> : <EmptyState title="No app labels yet" />}
              </ChartCard>
            </Boundary>
          </div>

          <div className="grid-2" style={{ marginBottom: 24 }}>
            <div id="tm-split"><Boundary label="Productive vs idle"><SplitCard split={d.split} /></Boundary></div>
            <Boundary label="Apps"><Card><CardHeader title="All apps" sub="Share of active time · activity % inside the app" />
              <div className="card-b"><div className="tm-rank">{d.apps.map((a: any) => (
                <button key={a.label} className="tm-rank-row" onClick={() => set({ app: a.label })} aria-label={`Show workers using ${a.label}`}>
                  <span className="tm-rank-label">{a.label}</span>
                  <span className="small nowrap"><b>{hm(a.active_minutes)}</b> <span className="muted">· {a.share_pct}% · {a.activity_pct ?? '—'}% active · {a.workers} worker{a.workers === 1 ? '' : 's'}</span></span>
                  <span className="tm-rank-bar"><i style={{ width: `${Math.max(1, a.share_pct)}%` }} /></span>
                </button>))}</div></div>
            </Card></Boundary>
          </div>

          <div className="grid-2" style={{ marginBottom: 24 }}>
            <Boundary label="URLs"><Card><CardHeader title="Top URLs" sub="From screenshot labels, weighted by estimated active time per capture" />
              <div className="card-b">{d.urls.length ? <div className="tm-rank">{d.urls.slice(0, 10).map((u: any) => (
                <button key={u.label + u.app_label} className="tm-rank-row" onClick={() => set({ app: u.app_label })} aria-label={`Show workers using ${u.app_label}`}>
                  <span className="tm-rank-label" title={u.label}>{u.label} <span className="muted small">· {u.app_label}</span></span>
                  <span className="small nowrap"><b>≈ {hm(u.est_minutes)}</b> <span className="muted">· {u.shots} captures</span></span>
                  <span className="tm-rank-bar"><i style={{ width: `${Math.max(1, u.share_pct)}%` }} /></span>
                </button>))}</div> : <EmptyState icon={<ImageIcon size={20} />} title="No screenshot URLs in this range" text="URLs come from screenshot labels; screenshots may be off in the monitoring policy." />}</div>
            </Card></Boundary>
            <Boundary label="Input counts"><Card><CardHeader title="Input counts" sub="Totals only — no keystroke content is ever captured" />
              <div className="card-b"><div className="tm-legend">
                <div><div className="small muted"><Keyboard size={13} /> Keyboard events</div><div className="v">{num(k.keys)}</div><div className="small muted">{k.active_minutes ? num(Math.round(k.keys / k.active_minutes)) : '—'} per active minute</div></div>
                <div><div className="small muted"><MousePointer2 size={13} /> Mouse events</div><div className="v">{num(k.mouse)}</div><div className="small muted">{k.active_minutes ? num(Math.round(k.mouse / k.active_minutes)) : '—'} per active minute</div></div>
                <div><div className="small muted">Workers with activity</div><div className="v">{k.workers}</div></div>
                <div><div className="small muted">Monitored time</div><div className="v">{hm(k.monitored_minutes)}</div></div>
              </div></div>
            </Card></Boundary>
          </div>

          <div id="tm-workers"><Boundary label="Workers"><Card><CardHeader title="Workers" sub="Click a worker to open their Screenshots & Activity day view" />
            {d.workers.length ? <div className="table-wrap"><table className="table">
              <thead><tr><th>Worker</th><th>Client</th><th className="right">Active</th><th className="right">Idle</th><th className="right">Activity</th><th>Top app</th><th className="right">Keys</th><th className="right">Mouse</th><th>Last active</th></tr></thead>
              <tbody>{d.workers.map((w: any) => (
                <tr key={w.worker_id} style={{ cursor: 'pointer' }} onClick={() => openWorkerDay(w.worker_id, w.last_day)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') openWorkerDay(w.worker_id, w.last_day); }}>
                  <td><div className="row" style={{ gap: 10 }}><Avatar name={w.name} color={w.avatar_color} size={28} /><span className="bold">{w.name}</span></div></td>
                  <td className="small">{w.company_names ?? '—'}</td>
                  <td className="right num">{hm(w.active_minutes)}</td><td className="right num">{hm(w.idle_minutes)}</td>
                  <td className="right"><span className="bold" style={{ color: w.activity_pct === null ? undefined : w.activity_pct < 40 ? 'var(--warning-600)' : 'var(--success-600)' }}>{w.activity_pct !== null ? `${w.activity_pct}%` : '—'}</span></td>
                  <td className="small">{w.top_app ?? '—'}</td>
                  <td className="right num small">{num(w.keys)}</td><td className="right num small">{num(w.mouse)}</td>
                  <td className="small">{w.last_day ? shortDate(w.last_day) : '—'}</td>
                </tr>))}</tbody>
            </table></div> : <div className="card-b"><EmptyState title="No worker activity in this range" /></div>}
          </Card></Boundary></div>
        </>}
      </>}

      <AppDrawer app={appSel} scopeQs={scopeQs} onClose={() => set({ app: null })} onWorker={(id, day) => openWorkerDay(id, day)} />
    </div>
  );
}

function SplitCard({ split }: { split: any }) {
  const total = split.active_minutes + split.idle_minutes + split.break_minutes;
  const w = (v: number) => `${total ? (v * 100) / total : 0}%`;
  const share = (v: number) => (total ? `${Math.round((v * 100) / total)}%` : '—');
  return (
    <Card><CardHeader title="Productive vs idle" sub="Active and idle seconds from 10-minute samples, breaks from sessions" />
      <div className="card-b">
        {total ? <>
          <div className="tm-split" role="img" aria-label={`Active ${share(split.active_minutes)}, idle ${share(split.idle_minutes)}, breaks ${share(split.break_minutes)}`}>
            <i className="act" style={{ width: w(split.active_minutes) }} /><i className="idle" style={{ width: w(split.idle_minutes) }} /><i className="brk" style={{ width: w(split.break_minutes) }} />
          </div>
          <div className="tm-legend">
            <div><div className="small muted"><span className="sw" style={{ background: 'var(--primary)' }} />Active</div><div className="v">{hm(split.active_minutes)}</div><div className="small muted">{share(split.active_minutes)}</div></div>
            <div><div className="small muted"><span className="sw" style={{ background: 'var(--warning)' }} />Idle (no input)</div><div className="v">{hm(split.idle_minutes)}</div><div className="small muted">{share(split.idle_minutes)}</div></div>
            <div><div className="small muted"><span className="sw" style={{ background: '#C7D2FE' }} />Breaks</div><div className="v">{hm(split.break_minutes)}</div><div className="small muted">{share(split.break_minutes)}</div></div>
            <div><div className="small muted">Idle discarded by workers</div><div className="v">{hm(split.discarded_idle_minutes)}</div><div className="small muted">removed from paid time</div></div>
          </div>
        </> : <EmptyState title="No monitored time in this range" />}
      </div>
    </Card>
  );
}

function AppDrawer({ app, scopeQs, onClose, onWorker }: { app: string | null; scopeQs: string; onClose: () => void; onWorker: (id: string, day?: string | null) => void }) {
  const url = app ? `/api/v1/time/activity/app${scopeQs}${scopeQs ? '&' : '?'}app=${encodeURIComponent(app)}` : null;
  const st = useApi<any>(url);
  const d = st.data;
  const max = useMemo(() => Math.max(1, ...(d?.workers ?? []).map((w: any) => w.active_minutes)), [d]);
  return (
    <Drawer open={!!app} onClose={onClose} title={app ?? ''}>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d || st.loading ? <LoadingBlock rows={6} /> : <>
        <div className="small muted" style={{ marginBottom: 14 }}>{hm(d.active_minutes)} of active time · {d.workers.length} worker{d.workers.length === 1 ? '' : 's'} · {shortDate(d.range.from)} – {shortDate(d.range.to)}</div>
        <div className="bold" style={{ marginBottom: 6 }}>Workers using this app</div>
        {d.workers.length ? <div className="tm-rank" style={{ marginBottom: 20 }}>{d.workers.map((w: any) => (
          <button key={w.worker_id} className="tm-rank-row" onClick={() => onWorker(w.worker_id, w.last_day)} aria-label={`Open ${w.name}'s day view`}>
            <span className="row" style={{ gap: 8, minWidth: 0 }}><Avatar name={w.name} color={w.avatar_color} size={24} /><span className="tm-rank-label">{w.name}</span><span className="small muted truncate">{w.company_names ?? ''}</span></span>
            <span className="small nowrap"><b>{hm(w.active_minutes)}</b> <span className="muted">· {w.share_of_worker_pct}% of their time · {w.activity_pct ?? '—'}% active</span></span>
            <span className="tm-rank-bar"><i style={{ width: `${(w.active_minutes * 100) / max}%` }} /></span>
          </button>))}</div> : <EmptyState title="Nobody used this app in this range" />}
        <div className="bold" style={{ marginBottom: 6 }}>URLs seen in this app</div>
        {d.urls.length ? <div className="tm-rank">{d.urls.map((u: any) => <div key={u.label} className="tm-rank-row"><span className="tm-rank-label">{u.label}</span><span className="small nowrap">≈ {hm(u.est_minutes)} <span className="muted">· {u.shots} captures</span></span></div>)}</div> : <div className="small muted">No screenshot URLs for this app.</div>}
      </>}
    </Drawer>
  );
}
