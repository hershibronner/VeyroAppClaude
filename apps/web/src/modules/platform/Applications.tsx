// Platform → Agencies: self-serve sign-ups waiting for approval. Approving emails the owner that the account is active.
import { useState } from 'react';
import { Check, X, FileText, Globe, Phone, MapPin, Users, Briefcase, Inbox, ShieldCheck, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { relTime, dateTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, Card, Dialog, StatusPill } from '../../components/ui';
import '../../pages/signup.css';

const TABS = [{ key: 'pending', label: 'Waiting for approval' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Not approved' }];

export function ApplicationsPanel({ onChanged }: { onChanged?: () => void }) {
  const [tab, setTab] = useState('pending');
  const st = useApi<any>(`/api/v1/platform/applications?status=${tab}`, [tab]);
  const [busy, setBusy] = useState<string | null>(null);
  const [reject, setReject] = useState<any>(null);
  const [reason, setReason] = useState('');
  const counts = st.data?.counts ?? {};
  const resetWelcome = async (a: any) => {
    setBusy(`w${a.organization_id}`);
    try { await api.post(`/api/v1/platform/applications/${a.organization_id}/reset-welcome`, {}); toast.success(`${a.name} will see the welcome checklist again on their next visit`); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const approve = async (a: any) => {
    setBusy(a.organization_id);
    try { await api.post(`/api/v1/platform/applications/${a.organization_id}/approve`, {}); toast.success(`${a.name} approved — ${a.applicant_email} has been emailed`); st.reload(); onChanged?.(); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const doReject = async () => {
    setBusy(reject.organization_id);
    try { await api.post(`/api/v1/platform/applications/${reject.organization_id}/reject`, { reason }); toast.success(`${reject.name} was not approved — the applicant has been emailed`); setReject(null); setReason(''); st.reload(); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const rows: any[] = st.data?.rows ?? [];
  return (
    <Card pad>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div><div className="card-title-lg"><ShieldCheck size={16} /> New agency applications {counts.pending > 0 && <StatusPill status="pending" label={`${counts.pending} waiting`} />}</div>
          <div className="small muted">Agencies that sign up stay on a "pending approval" screen until you approve them here.</div></div>
        <div className="segmented" role="tablist">{TABS.map(t => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}{counts[t.key] ? ` (${counts[t.key]})` : ''}</button>)}</div>
      </div>
      {st.loading && !st.data ? <div className="small muted mt-2"><span className="spinner" /> Loading…</div> : rows.length === 0 ? (
        <div className="row small muted mt-2" style={{ gap: 6 }}><Inbox size={14} /> {tab === 'pending' ? 'No applications waiting — new sign-ups will appear here.' : 'Nothing here yet.'}</div>
      ) : rows.map(a => (
        <div key={a.organization_id} className="app-row">
          <div className="app-logo">{a.logo_url ? <img src={a.logo_url} alt="" /> : a.name.slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><b>{a.name}</b><span className="small muted">applied {relTime(a.submitted_at)}</span>{a.approval_status !== 'pending' && <StatusPill status={a.approval_status === 'approved' ? 'active' : 'at_risk'} label={a.approval_status === 'approved' ? 'Approved' : 'Not approved'} />}</div>
            <div className="small mt-1">{a.applicant_name} · <a href={`mailto:${a.applicant_email}`}>{a.applicant_email}</a></div>
            <div className="app-facts small muted">
              {a.phone && <span><Phone size={12} /> {a.phone}</span>}
              {a.country && <span><MapPin size={12} /> {a.country}</span>}
              {a.website && <span><Globe size={12} /> <a href={/^https?:/.test(a.website) ? a.website : `https://${a.website}`} target="_blank" rel="noreferrer noopener">{a.website}</a></span>}
              {a.team_size && <span><Users size={12} /> Team {a.team_size.replace('_', ' ')}</span>}
              {a.active_workers && <span><Briefcase size={12} /> {a.active_workers} placed</span>}
              {a.previous_software && <span>Uses {a.previous_software}</span>}
            </div>
            {(a.industries?.length > 0 || a.legal_name || a.registration_number || a.registration_url) && <div className="app-facts small muted">
              {a.industries?.length > 0 && <span>{a.industries.join(', ')}</span>}
              {a.legal_name && <span>Legal: {a.legal_name}</span>}
              {a.registration_number && <span>Reg #: {a.registration_number}</span>}
              {a.registration_url ? <a href={a.registration_url} target="_blank" rel="noreferrer"><FileText size={12} /> {a.registration_file_name ?? 'Business registration'}</a> : <span>No registration document</span>}
            </div>}
            {a.reviewed_at && <div className="tiny muted mt-1">{a.approval_status === 'approved' ? 'Approved' : 'Rejected'} by {a.reviewed_by_name ?? '—'} · {dateTime(a.reviewed_at)}{a.rejection_reason ? ` · “${a.rejection_reason}”` : ''}</div>}
          </div>
          {a.approval_status === 'approved' && <div className="row" style={{ gap: 8, alignSelf: 'center' }}>
            <Button size="sm" icon={<RotateCcw size={14} />} loading={busy === `w${a.organization_id}`} disabled={!!busy} onClick={() => resetWelcome(a)}>Reset welcome</Button>
          </div>}
          {a.approval_status !== 'approved' && <div className="row" style={{ gap: 8, alignSelf: 'center' }}>
            {a.approval_status === 'pending' && <Button size="sm" icon={<X size={14} />} onClick={() => { setReject(a); setReason(''); }} disabled={!!busy}>Reject</Button>}
            <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy === a.organization_id} disabled={!!busy} onClick={() => approve(a)}>Approve</Button>
          </div>}
        </div>
      ))}
      <Dialog open={!!reject} onClose={() => setReject(null)} title={`Don't approve ${reject?.name ?? ''}?`}
        footer={<><Button onClick={() => setReject(null)}>Cancel</Button><Button variant="danger" loading={!!busy} onClick={doReject}>Send and reject</Button></>}>
        <p className="small muted" style={{ marginTop: 0 }}>The applicant gets an email with this reason. They will keep seeing a "not approved" screen when they sign in.</p>
        <label className="label" htmlFor="rej-reason">Reason</label>
        <textarea id="rej-reason" className="input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="We could not verify your business — please reply with your registration document." />
      </Dialog>
    </Card>
  );
}
