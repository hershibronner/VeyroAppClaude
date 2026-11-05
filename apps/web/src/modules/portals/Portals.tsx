import { Link } from 'react-router-dom';
import { Building2, UserRound, UserSearch, Users, Mail, Clock, Link2, Copy, Settings2, ExternalLink } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { num, relTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Async, Button, Card, CardHeader, EmptyState, KpiRow, PageHeader, Person, StatusPill } from '../../components/ui';

interface Overview {
  canManage: boolean;
  apply: { url: string; applications30d: number; activeLinks: number };
  portals: { kind: 'client' | 'worker' | 'candidate'; enabled: boolean; activeUsers: number; active30d: number; lastLogin: string | null; pendingInvites: number; eligible: number }[];
  recent: { name: string; last_login_at: string; kind: string; role_name: string; company_name: string | null }[];
}

const META = {
  client: { title: 'Client portal', icon: Building2, who: 'clients', blurb: 'Clients see their team live, approve timesheets, review candidates and pay invoices.', invite: { to: '/crm/clients', label: 'Invite from a client' } },
  worker: { title: 'Worker portal', icon: UserRound, who: 'active workers', blurb: 'Workers clock in with the web tracker, submit timesheets and download payslips.', invite: { to: '/workforce/placements', label: 'Invite from a placement' } },
  candidate: { title: 'Candidate portal', icon: UserSearch, who: 'open candidates', blurb: 'Candidates track applications, complete assessments and sign offers.', invite: { to: '/recruiting/candidates', label: 'Open candidates' } },
} as const;

export default function PortalsPage() {
  const state = useApi<Overview>('/api/v1/portals/overview');
  return (
    <div>
      <PageHeader title="Portals" sub="Client, worker and candidate portals — who has access and how they use it."
        actions={state.data?.canManage && <Link to="/settings/portals" className="btn"><Settings2 size={16} /> Portal settings</Link>} />
      <Async state={state}>{d => {
        const total = d.portals.reduce((a, p) => a + p.activeUsers, 0);
        const active30 = d.portals.reduce((a, p) => a + p.active30d, 0);
        const pending = d.portals.reduce((a, p) => a + p.pendingInvites, 0);
        return (<>
          <KpiRow items={[
            { label: 'Portal users', icon: <Users size={16} />, value: num(total), deltaText: <span>across {d.portals.filter(p => p.enabled).length} enabled portals</span>, suffix: '' },
            { label: 'Signed in, last 30 days', icon: <Clock size={16} />, value: num(active30), deltaText: <span className={total ? (active30 / total >= 0.5 ? 'up' : 'down') : ''}><b>{total ? Math.round((active30 / total) * 100) : 0}%</b></span>, suffix: 'of portal users' },
            { label: 'Pending invitations', icon: <Mail size={16} />, value: num(pending), deltaText: <span>not yet accepted</span>, suffix: '', to: '/settings/team' },
            { label: 'Applications, 30 days', icon: <Link2 size={16} />, value: num(d.apply.applications30d), deltaText: <span>{d.apply.activeLinks} active sourcing links</span>, suffix: '', to: '/recruiting/applications' },
          ]} />
          <div className="grid-3 mb-3">
            {d.portals.map(p => { const m = META[p.kind]; const Ic = m.icon; const reach = p.eligible ? Math.min(100, Math.round((p.activeUsers / p.eligible) * 100)) : 0; return (
              <Card key={p.kind} pad>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="row" style={{ gap: 10 }}><span className="tl-ic" style={{ background: 'var(--primary-50)', color: 'var(--primary)' }}><Ic size={16} /></span><b style={{ fontSize: 15 }}>{m.title}</b></span>
                  <StatusPill status={p.enabled ? 'enabled' : 'disabled'} tone={p.enabled ? 'green' : 'gray'} label={p.enabled ? 'Enabled' : 'Disabled'} />
                </div>
                <p className="small muted" style={{ margin: '12px 0 16px', lineHeight: 1.6 }}>{m.blurb}</p>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <div><div className="kpi-value" style={{ fontSize: 28, margin: 0 }}>{num(p.activeUsers)}</div><div className="small muted">users · {reach}% of {num(p.eligible)} {m.who}</div></div>
                  <div className="small muted right">{p.pendingInvites ? <div><b className="num" style={{ color: 'var(--text)' }}>{p.pendingInvites}</b> pending</div> : null}<div>Last sign-in {p.lastLogin ? relTime(p.lastLogin) : '—'}</div></div>
                </div>
                <div className="meter mt-2"><i style={{ width: `${reach}%` }} /></div>
                <div className="mt-3"><Link to={m.invite.to} className="btn btn-sm">{m.invite.label}</Link></div>
              </Card>
            ); })}
          </div>
          <div className="grid-2">
            <Card>
              <CardHeader title="Public application page" sub="Share it anywhere — recruiter and position links add attribution." />
              <div className="card-b">
                <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                  <img src={`/api/v1/qr?text=${encodeURIComponent(d.apply.url)}`} alt="QR code for the public application page" width={96} height={96} style={{ borderRadius: 8, border: '1px solid var(--border)', flex: 'none' }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <input className="input" readOnly value={d.apply.url} aria-label="Public application link" />
                    <div className="row mt-2"><Button size="sm" icon={<Copy size={14} />} onClick={() => { navigator.clipboard.writeText(d.apply.url); toast.success('Link copied'); }}>Copy link</Button><a className="btn btn-sm" href={d.apply.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a></div>
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <CardHeader title="Recent portal sign-ins" />
              <div className="card-b" style={{ paddingTop: 8 }}>
                {d.recent.length === 0 ? <EmptyState title="No portal sign-ins yet" text="Invite clients and workers to their portals to see activity here." /> : d.recent.map((r, i) => (
                  <div key={i} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><Person name={r.name} sub={`${r.role_name}${r.company_name ? ' · ' + r.company_name : ''}`} size={30} /></div><span className="small muted nowrap">{relTime(r.last_login_at)}</span></div>
                ))}
              </div>
            </Card>
          </div>
        </>);
      }}</Async>
    </div>
  );
}
