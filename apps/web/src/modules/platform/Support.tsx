import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send, ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, humanize, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Drawer, ErrorState, Field, LoadingBlock, PageHeader, StatusPill } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';

export function TicketsPage() {
  const [sp, setSp] = useSearchParams();
  const [rk, setRk] = useState(0);
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=200');
  const ticket = sp.get('ticket');
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  return (
    <div className="stack">
      <PageHeader title="Support tickets" sub="Tickets opened by agencies from their Help Center. Replies notify the person who opened the ticket." />
      <DataTable<any> title="Tickets" endpoint="/api/v1/platform/tickets" reloadKey={rk} exportName="support-tickets" onRowClick={r => set({ ticket: r.id })}
        filters={[{ key: 'status', label: 'Status', options: opts(['open', 'pending', 'resolved'], { pending: 'Waiting on agency' }) }, { key: 'priority', label: 'Priority', options: opts(['urgent', 'high', 'normal', 'low']) }, { key: 'organization_id', label: 'Agency', options: (agencies.data?.rows ?? []).map((a: any) => ({ value: a.id, label: a.name })) }]}
        columns={[
          { key: 'subject', label: 'Subject', mobile: 'title', render: r => <span className="bold">{r.subject}</span> },
          { key: 'org_name', label: 'Agency', mobile: 'subtitle' },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} label={r.status === 'pending' ? 'Waiting on agency' : undefined} /> },
          { key: 'priority', label: 'Priority', sortable: true, render: r => <StatusPill status={r.priority} /> },
          { key: 'category', label: 'Category', render: r => humanize(r.category) },
          { key: 'created_by_name', label: 'Opened by' }, { key: 'assigned_to_name', label: 'Assignee' },
          { key: 'replies', label: 'Replies', align: 'right' },
          { key: 'updated_at', label: 'Updated', sortable: true, render: r => relTime(r.updated_at) },
        ]} />
      <TicketDrawer id={ticket} onClose={() => set({ ticket: null })} onChange={() => setRk(k => k + 1)} />
    </div>
  );
}

function TicketDrawer({ id, onClose, onChange }: { id: string | null; onClose: () => void; onChange: () => void }) {
  const st = useApi<any>(id ? `/api/v1/platform/tickets/${id}` : null, [id]);
  const [body, setBody] = useState('');
  const [resolve, setResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = st.data;
  const patch = async (p: any) => { try { await api.patch(`/api/v1/platform/tickets/${id}`, p); st.reload(); onChange(); toast.success('Ticket updated'); } catch (e) { toast.error(e); } };
  return (
    <Drawer open={!!id} onClose={onClose} title={t?.subject ?? 'Ticket'} wide footer={t && <><Button variant="primary" icon={<Send size={16} />} disabled={!body.trim()} loading={busy} onClick={async () => { setBusy(true); try { await api.post(`/api/v1/platform/tickets/${id}/replies`, { body, status: resolve ? 'resolved' : undefined }); setBody(''); setResolve(false); st.reload(); onChange(); toast.success('Reply sent — the agency user was notified'); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Send reply</Button></>}>
      {st.error && !t ? <ErrorState error={st.error} retry={st.reload} /> : !t ? <LoadingBlock /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="small muted">{t.org_name ?? 'No agency'} · opened by {t.created_by_name ?? '—'} ({t.created_by_email ?? '—'}) · {dateTime(t.created_at)}</div>
          <div className="form-grid">
            <Field label="Status" htmlFor="pt-s"><select id="pt-s" className="select" value={t.status} onChange={e => patch({ status: e.target.value })}>{['open', 'pending', 'resolved'].map(s => <option key={s} value={s}>{s === 'pending' ? 'Waiting on agency' : humanize(s)}</option>)}</select></Field>
            <Field label="Priority" htmlFor="pt-p"><select id="pt-p" className="select" value={t.priority} onChange={e => patch({ priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
            <Field label="Assignee" htmlFor="pt-a"><select id="pt-a" className="select" value={t.assigned_to ?? ''} onChange={e => patch({ assigned_to: e.target.value || null })}><option value="">Unassigned</option>{t.admins.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          </div>
          <div className="st-thread">
            <div className="st-msg"><div className="small bold">{t.created_by_name ?? '—'} <span className="muted" style={{ fontWeight: 400 }}>· {dateTime(t.created_at)}</span></div><div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{t.body}</div></div>
            {t.replies.map((r: any) => <div key={r.id} className={`st-msg ${r.is_staff ? 'staff' : ''}`}><div className="small bold">{r.author_name ?? '—'}{r.is_staff ? ' (VeyroApp)' : ''} <span className="muted" style={{ fontWeight: 400 }}>· {dateTime(r.created_at)}</span></div><div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.body}</div></div>)}
          </div>
          <Field label="Reply to the agency" htmlFor="pt-r"><textarea id="pt-r" className="textarea" value={body} onChange={e => setBody(e.target.value)} /></Field>
          <label className="check small"><input type="checkbox" checked={resolve} onChange={e => setResolve(e.target.checked)} /> Mark as resolved when sending</label>
        </div>
      )}
    </Drawer>
  );
}

export function ImpersonationPage() {
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=200');
  const [org, setOrg] = useState('');
  const detail = useApi<any>(org ? `/api/v1/platform/agencies/${org}` : null, [org]);
  const [user, setUser] = useState('');
  const [reason, setReason] = useState('');
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
