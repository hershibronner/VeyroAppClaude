import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, UserX, UserCheck, Image as ImageIcon, FileText, ExternalLink, Mail, Phone, MapPin } from 'lucide-react';
import { Card, CardHeader, Button, StatusPill, Avatar, Tabs, Menu, KV, EmptyState, ErrorState, LoadingBlock, Boundary, useConfirm, PermissionDenied } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { BackButton } from '../../components/ui';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, money, humanize } from '../../lib/format';
import { LivePill, SinceTimer, ActivityMeter, scheduleText, hrs, Lightbox, ShotThumb, Progress, IssueDrawer } from './shared';

type TabKey = 'overview' | 'recruiting' | 'onboarding' | 'documents' | 'screenshots' | 'timesheets' | 'pay' | 'issues' | 'activity';

export default function Worker360() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as TabKey) || 'overview';
  const st = useApi<any>(`/api/v1/workers/${id}`);
  const confirm = useConfirm();
  const [lb, setLb] = useState<number | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  if (st.error && !st.data) return <div><BackButton fallback="/workforce/workers" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const w = st.data;
  const current = w.placements.find((p: any) => ['active', 'notice', 'on_leave'].includes(p.status)) ?? w.placements.find((p: any) => p.status === 'onboarding') ?? null;
  const setStatus = async (status: 'inactive' | 'available') => {
    const r = await confirm({ title: status === 'inactive' ? 'Mark worker inactive?' : 'Mark worker available?', body: status === 'inactive' ? 'Inactive workers are hidden from placement suggestions. History is kept.' : 'The worker becomes available for a new placement.', reason: { label: 'Reason', required: true } });
    if (!r.ok) return;
    try { await api.post(`/api/v1/workers/${id}/status`, { status, reason: r.reason }); toast.success('Worker status updated'); st.reload(); } catch (e) { toast.error(e); }
  };
  const open = w.placements.filter((p: any) => p.status !== 'ended');
  return (
    <div>
      <BackButton fallback="/workforce/workers" />
      <Card>
        <div className="detail-head">
          <Avatar name={w.name} color={w.avatar_color} size={64} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><h1 style={{ margin: 0 }}>{w.name}</h1><StatusPill status={w.status} />{w.presence && w.presence.state !== 'offline' && <LivePill status={w.presence.state} />}</div>
            <div className="muted mt-1">{w.headline ?? '—'} · {w.employee_code ?? '—'}{current ? <> · <Link to={`/workforce/placements/${current.id}`}>{current.title} @ {current.company_name}</Link></> : null}</div>
            <div className="row small muted" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
              {w.email && <span><Mail size={13} /> {w.email}</span>}{w.phone && <span><Phone size={13} /> {w.phone}</span>}<span><MapPin size={13} /> {[w.city, w.country].filter(Boolean).join(', ') || '—'}</span>
              {current?.account_manager_name && <span>AM: <b>{current.account_manager_name}</b></span>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {w.can.placements_create && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav(`/workforce/placements/new?candidateId=${w.candidate_id}`)}>New placement</Button>}
            <Menu items={[
              { label: 'View candidate profile', icon: <ExternalLink size={15} />, onClick: () => nav(`/recruiting/candidates/${w.candidate_id}`) },
              { label: 'Log an issue', onClick: () => setIssueOpen(true), hidden: !w.can.issues_create || !open.length },
              { sep: true, hidden: !w.can.edit },
              { label: 'Mark available', icon: <UserCheck size={15} />, onClick: () => setStatus('available'), hidden: !w.can.edit || w.status === 'available' || open.length > 0 },
              { label: 'Mark inactive', icon: <UserX size={15} />, danger: true, onClick: () => setStatus('inactive'), hidden: !w.can.edit || w.status === 'inactive' || open.length > 0 },
            ]} />
          </div>
        </div>
        <div style={{ padding: '0 24px' }}>
          <Tabs value={tab} onChange={k => setSp({ tab: k }, { replace: true })} tabs={[
            { key: 'overview', label: 'Overview' }, { key: 'recruiting', label: 'Recruiting history', count: w.recruiting.applications.length + w.recruiting.submissions.length },
            { key: 'onboarding', label: 'Onboarding', count: w.onboarding.filter((i: any) => !i.done_at).length || null }, { key: 'documents', label: 'Documents', count: w.documents?.length ?? null, hidden: w.documents === null },
            { key: 'screenshots', label: 'Screenshots', hidden: w.screenshots === null }, { key: 'timesheets', label: 'Timesheets' }, { key: 'pay', label: 'Pay history', hidden: w.pay_history === null },
            { key: 'issues', label: 'Issues', count: w.issues.filter((i: any) => ['open', 'investigating'].includes(i.status)).length || null }, { key: 'activity', label: 'Activity' },
          ]} />
        </div>
      </Card>
      <div style={{ marginTop: 20 }}>
        <Boundary label="Worker tab">
          {tab === 'overview' && <div className="grid-main-side">
            <div className="stack" style={{ gap: 20 }}>
              <Card><CardHeader title="Placements" sub={`${w.placements.length} total · history is always preserved`} />
                {w.placements.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Role</th><th>Status</th><th>Schedule</th><th>Dates</th>{w.can.view_comp && <th className="right">Pay / Bill</th>}</tr></thead><tbody>
                  {w.placements.map((p: any) => <tr key={p.id} className="clickable" onClick={() => nav(`/workforce/placements/${p.id}`)}><td><div className="bold">{p.title}</div><div className="small muted">{p.company_name}{p.replaces_placement_id ? ' · replacement' : ''}</div></td><td><StatusPill status={p.status} /></td><td className="small">{scheduleText(p.schedule_days, p.schedule_start, p.schedule_end)}<div className="muted">{p.timezone}</div></td><td className="small">{date(p.start_date)} → {p.end_date ? date(p.end_date) : 'present'}{p.end_reason && <div className="muted">{p.end_reason}</div>}</td>{w.can.view_comp && <td className="right money">{money(p.pay_rate_cents, p.currency)} / {money(p.bill_rate_cents, p.currency)}</td>}</tr>)}
                </tbody></table></div> : <EmptyState title="No placements yet" />}
              </Card>
              <Card><CardHeader title="Recent timesheets" right={<Button size="sm" onClick={() => nav(`/time/timesheets?worker_id=${id}`)}>All timesheets</Button>} />
                {w.timesheets.length ? <div className="table-wrap"><table className="table"><tbody>{w.timesheets.slice(0, 5).map((t: any) => <tr key={t.id} className="clickable" onClick={() => nav(`/time/timesheets/${t.id}`)}><td>Week of {date(t.week_start)}</td><td className="small muted">{t.company_name}</td><td><StatusPill status={t.status} /></td><td className="right num">{hrs(t.total_minutes)}</td></tr>)}</tbody></table></div> : <EmptyState title="No timesheets yet" />}
              </Card>
            </div>
            <div className="stack" style={{ gap: 20 }}>
              <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Live status</div>
                {w.presence && w.presence.state !== 'offline' ? <div className="stack" style={{ gap: 8, marginTop: 10 }}><div className="row" style={{ justifyContent: 'space-between' }}><LivePill status={w.presence.state} /><SinceTimer from={w.presence.session_started_at} /></div><div className="small muted">{w.presence.company_name}</div><ActivityMeter value={w.presence.activity_pct} /><Link className="small" to={`/time/screenshots?worker_id=${id}`}>Open today's timeline →</Link></div>
                  : <div className="muted small" style={{ marginTop: 8 }}>Not clocked in.{w.presence?.last_heartbeat_at ? ` Last seen ${dateTime(w.presence.last_heartbeat_at)}.` : ''}</div>}
              </Card>
              <Card pad><KV items={[
                ['This week', hrs(w.stats.week_minutes)], ['Activity (30 days)', w.stats.activity_30d !== null ? `${w.stats.activity_30d}%` : '—'],
                ['Late (30 days)', w.attendance_30d.late], ['Absent (30 days)', w.attendance_30d.absent], ['Screen share declined', w.attendance_30d.screen_declined],
                ['Worker Portal', w.user_id ? 'Active login' : w.invite ? `Invite ${w.invite.status}` : 'Not invited'], ['Payout', w.payout_account_label ?? '—'],
                ...(w.can.view_comp ? [['Rate expectation', w.rate_target_cents ? `${money(w.rate_target_cents, w.rate_currency)}/${w.rate_unit}` : '—'] as [string, string]] : []),
              ]} /></Card>
              <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Upcoming & recent time off</div>
                {w.time_off.length ? <div className="stack" style={{ gap: 6, marginTop: 10 }}>{w.time_off.map((t: any) => <div key={t.id} className="row small" style={{ justifyContent: 'space-between' }}><span>{humanize(t.kind)} · {date(t.start_date)} → {date(t.end_date)}</span><StatusPill status={t.status} /></div>)}</div> : <div className="small muted" style={{ marginTop: 8 }}>No time off in the last 60 days.</div>}
              </Card>
            </div>
          </div>}
          {tab === 'recruiting' && <div className="grid-2">
            <Card><CardHeader title="Applications" />{w.recruiting.applications.length ? <table className="table"><tbody>{w.recruiting.applications.map((a: any) => <tr key={a.id}><td>{a.position_title ?? 'General application'}<div className="small muted">{a.source ?? '—'} · {a.recruiter_name ?? 'No recruiter'}</div></td><td><StatusPill status={a.status} /></td><td className="small muted">{date(a.created_at)}</td></tr>)}</tbody></table> : <EmptyState title="No applications" />}</Card>
            <Card><CardHeader title="Submissions" />{w.recruiting.submissions.length ? <table className="table"><tbody>{w.recruiting.submissions.map((a: any) => <tr key={a.id}><td>{a.position_title}<div className="small muted">{a.company_name}</div></td><td><StatusPill status={a.status} /></td><td className="small muted">{date(a.created_at)}</td></tr>)}</tbody></table> : <EmptyState title="No submissions" />}</Card>
            <Card><CardHeader title="Interviews" />{w.recruiting.interviews.length ? <table className="table"><tbody>{w.recruiting.interviews.map((a: any) => <tr key={a.id}><td>{a.position_title ?? '—'}<div className="small muted">{humanize(a.kind)}</div></td><td><StatusPill status={a.outcome ?? a.status} /></td><td className="small muted">{dateTime(a.scheduled_at)}</td></tr>)}</tbody></table> : <EmptyState title="No interviews" />}</Card>
            <Card><CardHeader title="Offers" />{w.recruiting.offers.length ? <table className="table"><tbody>{w.recruiting.offers.map((a: any) => <tr key={a.id}><td>{a.position_title ?? '—'}<div className="small muted">Start {date(a.start_date)}{a.signed_at ? ` · signed ${date(a.signed_at)}` : ''}</div></td><td><StatusPill status={a.status} /></td>{w.can.view_comp && <td className="right money">{money(a.pay_rate_cents, a.currency)}</td>}</tr>)}</tbody></table> : <EmptyState title="No offers" />}</Card>
          </div>}
          {tab === 'onboarding' && <Card><CardHeader title="Onboarding items" sub="Across current placements" />
            {w.onboarding.length ? <div style={{ padding: '0 20px 10px' }}>{w.onboarding.map((i: any) => <div key={i.id} className="checklist-item"><input type="checkbox" checked={!!i.done_at} readOnly aria-label={i.title} /><div style={{ flex: 1 }}><div className={i.done_at ? 'muted' : 'bold'}>{i.title}</div><div className="small muted">{i.company_name} · {humanize(i.source)} · {i.required ? 'Required' : 'Optional'} · owner {i.owner}{i.done_at ? ` · done ${dateTime(i.done_at)}${i.done_by_name ? ` by ${i.done_by_name}` : ''}` : ''}</div></div><Link className="small" to={`/workforce/placements/${i.placement_id}?tab=onboarding`}>Open</Link></div>)}
              <div style={{ padding: '12px 0' }}><Progress done={w.onboarding.filter((i: any) => i.done_at).length} total={w.onboarding.length} /></div></div> : <EmptyState title="No onboarding items" text="Items appear when the worker has an onboarding or active placement." />}
          </Card>}
          {tab === 'documents' && (w.documents === null ? <PermissionDenied /> : <Card><CardHeader title="Documents" />{w.documents.length ? <table className="table"><thead><tr><th>Name</th><th>Category</th><th>Verification</th><th>Expires</th><th /></tr></thead><tbody>{w.documents.map((d: any) => <tr key={d.id}><td><FileText size={14} /> {d.name}{d.signature_status && <div className="small muted">Signature: {d.signature_status}</div>}</td><td>{humanize(d.category)}</td><td><StatusPill status={d.verification} /></td><td>{d.expires_at ? date(d.expires_at) : '—'}</td><td className="right">{d.url && <a href={d.url} target="_blank" rel="noreferrer">Open</a>}</td></tr>)}</tbody></table> : <EmptyState title="No documents" />}</Card>)}
          {tab === 'screenshots' && <Card><CardHeader title="Recent screenshots" right={<Button size="sm" icon={<ImageIcon size={14} />} onClick={() => nav(`/time/screenshots?worker_id=${id}`)}>Full timeline</Button>} />
            <div className="card-b">{w.screenshots?.length ? <div className="shot-grid">{w.screenshots.map((s: any, i: number) => <ShotThumb key={s.id} s={s} onOpen={() => setLb(i)} />)}</div> : <EmptyState title="No screenshots" text="Screenshots appear while the worker is clocked in (per monitoring policy)." />}</div>
          </Card>}
          {tab === 'timesheets' && <Card><CardHeader title="Timesheets" right={<Button size="sm" onClick={() => nav(`/time/timesheets?worker_id=${id}`)}>Open in Timesheets</Button>} />{w.timesheets.length ? <table className="table"><thead><tr><th>Week</th><th>Client</th><th>Status</th><th className="right">Hours</th></tr></thead><tbody>{w.timesheets.map((t: any) => <tr key={t.id} className="clickable" onClick={() => nav(`/time/timesheets/${t.id}`)}><td>{date(t.week_start)}</td><td>{t.company_name}</td><td><StatusPill status={t.status} /></td><td className="right num">{hrs(t.total_minutes)}</td></tr>)}</tbody></table> : <EmptyState title="No timesheets yet" />}</Card>}
          {tab === 'pay' && <Card><CardHeader title="Pay history" sub="Restricted — visible to roles with compensation access" />{w.pay_history?.length ? <table className="table"><thead><tr><th>Period</th><th>Payslip</th><th>Run</th><th className="right">Hours</th><th className="right">Gross</th><th className="right">Net</th></tr></thead><tbody>{w.pay_history.map((p: any) => <tr key={p.id}><td>{date(p.period_start)} – {date(p.period_end)}</td><td>{p.payslip_number ?? '—'}</td><td><StatusPill status={p.run_status} /></td><td className="right num">{hrs((p.regular_minutes ?? 0) + (p.ot_minutes ?? 0))}</td><td className="right money">{money(p.gross_cents, p.currency)}</td><td className="right money">{money(p.net_cents, p.currency)}</td></tr>)}</tbody></table> : <EmptyState title="No payroll yet" />}</Card>}
          {tab === 'issues' && <Card><CardHeader title="Issues" sub={w.can.issues_create && open.length ? 'Log a new issue from the More menu (⋮) above.' : undefined} />{w.issues.length ? <table className="table"><tbody>{w.issues.map((i: any) => <tr key={i.id}><td><div className="bold">{i.title}</div><div className="small muted">{humanize(i.kind)} · {i.created_by_name ?? '—'} · {date(i.created_at)}</div>{i.resolution && <div className="small">Resolution: {i.resolution}</div>}</td><td><StatusPill status={i.severity} /></td><td><StatusPill status={i.status} /></td></tr>)}</tbody></table> : <EmptyState title="No issues logged" />}</Card>}
          {tab === 'activity' && <Card pad><Timeline type="worker" id={id!} /></Card>}
        </Boundary>
      </div>
      {lb !== null && w.screenshots && <Lightbox shots={w.screenshots.map((s: any) => ({ ...s, worker_name: w.name }))} index={lb} onIndex={setLb} onClose={() => setLb(null)} canFlag onFlagged={() => st.reload()} />}
      <IssueDrawer open={issueOpen} onClose={() => setIssueOpen(false)} placementId={current?.id} onSaved={st.reload} />
    </div>
  );
}
