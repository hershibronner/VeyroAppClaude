import { useState } from 'react';
import { CandidateLinksDialog } from './CandidateLinks';
import { Link, useNavigate } from 'react-router-dom';
import { Briefcase, Users, Inbox, CalendarClock, Plus, Link2 } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { num, humanize } from '../../lib/format';
import { Banner, Boundary, Button, Card, CardHeader, DateRangePicker, EmptyState, ErrorState, KpiRow, LoadingBlock, PageHeader, RangeSelect, StatusPill, presetRange, type DateRange } from '../../components/ui';
import { ChartCard, Funnel, TrackBars, TrendLine, fmtNum } from '../../components/charts';
import { CandidateForm, PositionForm, CANDIDATE_STATUSES } from './shared';

const FUNNEL_LINK: Record<string, string> = { applied: '', screened: '&exclude_status=new_applicant', qualified: '&stage=qualified', submitted: '&stage=submitted', client_interview: '&stage=client_interview', offer: '&stage=offer', hired: '&stage=hired' };

export default function Overview() {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const [range, setRange] = useState<DateRange>(presetRange(91, 'Last 3 months'));
  const [months, setMonths] = useState(6);
  const [newCand, setNewCand] = useState(false);
  const [newPos, setNewPos] = useState(false);
  const [linking, setLinking] = useState(false);
  const st = useApi<any>(`/api/v1/recruiting/overview?from=${range.from}&to=${range.to}&months=${months}`, [range.from, range.to, months]);
  const d = st.data;
  const rq = `from=${range.from}&to=${range.to}`;
  const personal = me?.workspace?.personalLinkToken;
  return (
    <div>
      <PageHeader title="Recruiting" sub="Positions, candidates and every step from application to hire."
        actions={<>
          <DateRangePicker value={range} onChange={setRange} />
          {can('positions', 'create') && <Button icon={<Briefcase size={16} />} onClick={() => setNewPos(true)}>New position</Button>}
          {can('candidates', 'create') && <Button icon={<Link2 size={16} />} onClick={() => setLinking(true)}>Generate link</Button>}
          {can('candidates', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setNewCand(true)}>New candidate</Button>}
        </>} />
      <CandidateLinksDialog open={linking} onClose={() => setLinking(false)} />
      {d && (d.banner.stale_apps > 0 || d.banner.requested_interviews > 0 || d.banner.accepted_unplaced > 0 || d.banner.today_interviews > 0) && (
        <Banner tone={d.banner.stale_apps > 0 ? 'warn' : 'info'}>
          <b>Heads up!</b>{' '}
          {[
            d.banner.stale_apps > 0 && <Link key="a" to="/recruiting/applications?status=new&stale=1">{d.banner.stale_apps} application{d.banner.stale_apps > 1 ? 's' : ''} waiting more than 48h for review</Link>,
            d.banner.requested_interviews > 0 && <Link key="b" to="/recruiting/interviews?status=requested">{d.banner.requested_interviews} client interview request{d.banner.requested_interviews > 1 ? 's' : ''} to confirm</Link>,
            d.banner.today_interviews > 0 && <Link key="c" to="/recruiting/interviews?when=today">{d.banner.today_interviews} interview{d.banner.today_interviews > 1 ? 's' : ''} today</Link>,
            d.banner.accepted_unplaced > 0 && <Link key="d" to="/recruiting/offers?needs_placement=true">{d.banner.accepted_unplaced} accepted offer{d.banner.accepted_unplaced > 1 ? 's' : ''} need a placement</Link>,
          ].filter(Boolean).reduce((acc: any[], el, i) => (i ? [...acc, ' · ', el] : [el]), [])}
        </Banner>
      )}
      <Boundary label="Recruiting KPIs">
        {st.error ? <ErrorState error={st.error} retry={st.reload} /> : (
          <KpiRow items={[
            { label: 'Open positions', icon: <Briefcase size={16} />, value: d ? num(d.kpis.open_positions) : '…', deltaText: d ? <span className="muted">{num(d.kpis.in_pipeline)} candidates in pipeline</span> : undefined, suffix: '', to: '/recruiting/positions?status=open' },
            { label: 'Applications', icon: <Inbox size={16} />, value: d ? num(d.kpis.applications) : '…', delta: d?.kpis.applications_delta, suffix: 'vs previous period', to: `/recruiting/applications?${rq}` },
            { label: 'Submitted to clients', icon: <Users size={16} />, value: d ? num(d.kpis.submissions) : '…', delta: d?.kpis.submissions_delta, suffix: 'vs previous period', to: `/recruiting/submissions?${rq}` },
            { label: 'Upcoming interviews', icon: <CalendarClock size={16} />, value: d ? num(d.kpis.upcoming_interviews) : '…', deltaText: d ? <span className="muted">{d.kpis.open_offers} open offers · {d.kpis.accepted_offers} accepted</span> : undefined, suffix: '', to: '/recruiting/interviews?when=upcoming' },
          ]} />
        )}
      </Boundary>
      <div className="grid-2 mb-3">
        <Boundary label="Funnel"><Card pad>
          <div className="card-title-lg">Recruiting funnel</div>
          <div className="small muted mb-2">Candidates who applied in the selected range and how far they got. Click a step to open exactly those candidates.</div>
          {!d ? <LoadingBlock /> : d.funnel[0].value === 0 ? <EmptyState title="No candidates in this range" /> : <Funnel steps={d.funnel} onStepClick={s => nav(`/recruiting/candidates?${rq}${FUNNEL_LINK[s.key!] ?? ''}`)} />}
        </Card></Boundary>
        <Boundary label="Trend"><ChartCard title="Applications per month" big={d ? num(d.trend.reduce((a: number, b: any) => a + b.value, 0)) : '…'} delta={d ? <span className="muted">{num(d.trend.reduce((a: number, b: any) => a + b.submissions, 0))} submissions in the same months</span> : undefined} control={<RangeSelect value={months} onChange={setMonths} />}>
          {!d ? <LoadingBlock /> : <TrendLine data={d.trend} fmt={fmtNum} height={220} onPointClick={p => { const [y, m] = p.ym.split('-').map(Number); const last = new Date(y, m, 0).getDate(); nav(`/recruiting/applications?from=${p.ym}-01&to=${p.ym}-${String(last).padStart(2, '0')}`); }} />}
        </ChartCard></Boundary>
      </div>
      <div className="grid-2 mb-3">
        <Boundary label="Sources"><Card pad>
          <div className="card-title-lg">Candidates by source</div>
          {!d ? <LoadingBlock /> : d.sources.length === 0 ? <EmptyState title="No candidates in this range" /> : <TrackBars data={d.sources} fmt={fmtNum} height={220} valueName="Candidates" onBarClick={(x: any) => nav(`/recruiting/candidates?${rq}&source=${encodeURIComponent(x.label)}`)} />}
        </Card></Boundary>
        <Boundary label="Status"><Card>
          <CardHeader title="Candidates by status" sub="All candidates right now" right={personal ? <Link to="/recruiting/my-sourced" className="btn btn-sm"><Link2 size={14} /> My link</Link> : undefined} />
          <div className="card-b">{!d ? <LoadingBlock /> : <div className="rec-chips">{CANDIDATE_STATUSES.filter(s => d.statuses[s]).map(s => <Link key={s} to={`/recruiting/candidates?status=${s}`} className="chip" style={{ padding: '6px 12px', fontSize: 13 }}><StatusPill status={s} /> <b style={{ marginLeft: 4 }}>{d.statuses[s]}</b></Link>)}</div>}</div>
        </Card></Boundary>
      </div>
      <Boundary label="Open positions"><Card>
        <CardHeader title="Open positions to watch" sub="Most urgent first, fewest active candidates first" right={<Link to="/recruiting/positions?status=open" className="small">View all</Link>} />
        {!d ? <LoadingBlock /> : d.positions.length === 0 ? <EmptyState title="No open positions in your scope" action={can('positions', 'create') ? <Button size="sm" onClick={() => setNewPos(true)}>Create a position</Button> : undefined} /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Position</th><th>Client</th><th>Urgency</th><th>Health</th><th style={{ textAlign: 'right' }}>Openings</th><th style={{ textAlign: 'right' }}>Active pipeline</th><th style={{ textAlign: 'right' }}>New applications</th></tr></thead>
            <tbody>{d.positions.map((p: any) => <tr key={p.id} className="clickable" onClick={() => nav(`/recruiting/positions/${p.id}`)}><td className="bold">{p.title}</td><td>{p.company_name ?? '—'}</td><td><StatusPill status={p.urgency} /></td><td><StatusPill status={p.health} label={humanize(p.health)} /></td><td className="money">{p.openings}</td><td className="money">{p.active_pipeline === 0 ? <span style={{ color: 'var(--danger)' }}>0</span> : p.active_pipeline}</td><td className="money">{p.new_applications}</td></tr>)}</tbody></table></div>
        )}
      </Card></Boundary>
      <CandidateForm open={newCand} onClose={() => setNewCand(false)} onSaved={c => nav(`/recruiting/candidates/${c.id}`)} />
      <PositionForm open={newPos} onClose={() => setNewPos(false)} onSaved={p => nav(`/recruiting/positions/${p.id}`)} />
    </div>
  );
}
