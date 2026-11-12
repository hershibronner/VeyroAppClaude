import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Field, PageHeader, StatusPill } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function ImpersonationPage() {
  const [sp] = useSearchParams();
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=500&sort=name&dir=asc');
  // Prefilled from a support ticket: ?org=&user=&reason=
  const [org, setOrg] = useState(sp.get('org') ?? '');
  const detail = useApi<any>(org ? `/api/v1/platform/agencies/${org}` : null, [org]);
  const [user, setUser] = useState(sp.get('user') ?? '');
  const [reason, setReason] = useState(sp.get('reason') ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <PageHeader title="Impersonation" sub="Support mode lets VeyroApp staff see an agency exactly as one of its users. It always requires a reason, shows a visible banner, expires automatically and is fully audited." />
      <Card>
        <CardHeader title="Start a support session" />
        <div className="card-b stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="Agency" htmlFor="im-org"><select id="im-org" className="select" value={org} onChange={e => { setOrg(e.target.value); setUser(''); }}><option value="">Choose agency…</option>{(agencies.data?.rows ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="User" htmlFor="im-user"><select id="im-user" className="select" value={user} disabled={!detail.data} onChange={e => setUser(e.target.value)}><option value="">Choose user…</option>{(detail.data?.members ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.name} — {m.role_name}</option>)}</select></Field>
            <Field label="Reason (required, 10+ characters)" htmlFor="im-reason" full><textarea id="im-reason" className="textarea" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Ticket: worker cannot clock in — reproducing" /></Field>
          </div>
          <Banner tone="warn" icon={<ShieldAlert size={18} />}>Every action you take is recorded in the agency's audit log with your name as the support agent. Use “End support session” in the banner to return here.</Banner>
          <div><Button variant="danger" icon={<ShieldAlert size={16} />} disabled={!org || !user || reason.trim().length < 10} loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/api/v1/platform/impersonation/start', { user_id: user, organization_id: org, reason }); window.location.href = r.redirect; } catch (e) { toast.error(e); setBusy(false); } }}>Start support session</Button></div>
        </div>
      </Card>
      <DataTable<any> title="Session history" endpoint="/api/v1/platform/impersonations" exportName="impersonation-sessions"
        columns={[
          { key: 'started_at', label: 'Started', sortable: true, mobile: 'subtitle', render: r => dateTime(r.started_at) },
          { key: 'platform_user_name', label: 'Support agent' },
          { key: 'target_name', label: 'Viewed as', mobile: 'title', render: r => <span><b>{r.target_name}</b><div className="tiny muted">{r.target_email}</div></span> },
          { key: 'org_name', label: 'Agency' },
          { key: 'reason', label: 'Reason' },
          { key: 'seconds', label: 'Duration', render: r => `${Math.floor(r.seconds / 60)}m ${r.seconds % 60}s` },
          { key: 'ended_at', label: 'Status', render: r => r.ended_at ? <StatusPill status="completed" label={`Ended ${relTime(r.ended_at)}`} /> : <StatusPill status="active" label="Active now" /> },
        ]} />
    </div>
  );
}
