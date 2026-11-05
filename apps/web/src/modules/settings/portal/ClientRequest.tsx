import { useState } from 'react';
import { CheckCircle2, Send, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { useApi } from '../../../lib/hooks';
import { useAuth } from '../../../lib/auth';
import { toast } from '../../../lib/toast';
import { date, humanize } from '../../../lib/format';
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingBlock, MoneyInput, PageHeader, StatusPill, TagInput } from '../../../components/ui';

const EMPTY = { title: '', openings: 1, employment_type: 'full_time', weekly_hours: 40, schedule: 'Mon–Fri 9:00–17:00', timezone: 'America/New_York', start_date: '', skills: [] as string[], software: [] as string[], languages: ['English'], budget_cents: null as number | null, urgency: 'normal', description: '' };
const STATUS_LABEL: Record<string, string> = { draft: 'Received — being reviewed', open: 'Recruiting', on_hold: 'On hold', filled: 'Filled', closed: 'Closed' };

export default function ClientRequest() {
  const { me } = useAuth();
  const st = useApi<any>('/api/v1/portal/client/request');
  const [v, setV] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<any>(null);
  const set = (p: Partial<typeof EMPTY>) => setV(x => ({ ...x, ...p }));
  const viewer = me?.workspace?.role.key === 'client_viewer';
  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const r = await api.post('/api/v1/portal/client/request', { ...v, start_date: v.start_date || null, weekly_hours: v.weekly_hours || null, schedule: v.schedule || null, timezone: v.timezone || null });
      setSent(r); setV({ ...EMPTY }); st.reload(); toast.success('Request sent to your account manager');
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  return (
    <div className="stack">
      <PageHeader title="Request a Worker" sub={`Tell ${me?.workspace?.org.name} who you need. Your account manager${st.data.account_manager ? ` (${st.data.account_manager.name})` : ''} is notified right away and starts recruiting.`} />
      {!st.data.enabled && <Banner tone="warn">Worker requests through the portal are turned off. Please message your account manager.</Banner>}
      {sent && <Banner tone="success" icon={<CheckCircle2 size={18} />}>“{sent.title}” was sent. You'll see candidates under <b>Candidates</b> as soon as they are submitted.</Banner>}
      <div className="grid-main-side">
        <Card>
          <CardHeader title="Role details" />
          <fieldset className="card-b st-fieldset" disabled={!st.data.enabled || viewer}>
            {viewer && <Banner>Viewers can't submit requests — ask your client owner to change your role.</Banner>}
            <div className="form-grid">
              <Field label="Role title *" htmlFor="rq-t" error={errors.title} full><input id="rq-t" className="input" value={v.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Dental Front Desk Assistant" /></Field>
              <Field label="Number of people" htmlFor="rq-o" error={errors.openings}><input id="rq-o" type="number" min={1} max={50} className="input" value={v.openings} onChange={e => set({ openings: Number(e.target.value) || 1 })} /></Field>
              <Field label="Employment" htmlFor="rq-e"><select id="rq-e" className="select" value={v.employment_type} onChange={e => set({ employment_type: e.target.value })}><option value="full_time">Full time</option><option value="part_time">Part time</option><option value="contract">Contract / project</option></select></Field>
              <Field label="Hours per week" htmlFor="rq-h" error={errors.weekly_hours}><input id="rq-h" type="number" min={1} max={80} className="input" value={v.weekly_hours} onChange={e => set({ weekly_hours: Number(e.target.value) })} /></Field>
              <Field label="Desired start date" htmlFor="rq-s" error={errors.start_date}><input id="rq-s" type="date" className="input" value={v.start_date} onChange={e => set({ start_date: e.target.value })} /></Field>
              <Field label="Schedule" htmlFor="rq-sc"><input id="rq-sc" className="input" value={v.schedule} onChange={e => set({ schedule: e.target.value })} /></Field>
              <Field label="Your time zone" htmlFor="rq-tz"><select id="rq-tz" className="select" value={v.timezone} onChange={e => set({ timezone: e.target.value })}>{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'Europe/London', 'Australia/Sydney'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>
              <Field label="Urgency" htmlFor="rq-u"><select id="rq-u" className="select" value={v.urgency} onChange={e => set({ urgency: e.target.value })}><option value="low">Low — exploring</option><option value="normal">Normal</option><option value="high">High — within 2 weeks</option><option value="critical">Critical — ASAP</option></select></Field>
              <Field label="Budget (hourly, optional)" htmlFor="rq-b" hint="Helps us shortlist the right candidates"><MoneyInput id="rq-b" cents={v.budget_cents} onChange={c => set({ budget_cents: c })} /></Field>
              <Field label="Key skills" full><TagInput value={v.skills} onChange={s => set({ skills: s })} placeholder="e.g. Scheduling, Insurance verification" /></Field>
              <Field label="Software" full><TagInput value={v.software} onChange={s => set({ software: s })} placeholder="e.g. Dentrix, Google Workspace" /></Field>
              <Field label="Languages" full><TagInput value={v.languages} onChange={s => set({ languages: s })} /></Field>
              <Field label="What will they do? *" htmlFor="rq-d" error={errors.description} full><textarea id="rq-d" className="textarea" style={{ minHeight: 120 }} value={v.description} onChange={e => set({ description: e.target.value })} placeholder="Daily responsibilities, tools, who they report to, anything that matters." /></Field>
            </div>
            <div className="row mt-3"><Button variant="primary" icon={<Send size={16} />} loading={busy} disabled={!v.title || !v.description} onClick={submit}>Send request</Button></div>
          </fieldset>
        </Card>
        <Card>
          <CardHeader title="Your requests" sub={`${st.data.requests.length} from ${st.data.company ?? 'your company'}`} />
          {st.data.requests.length === 0 ? <EmptyState icon={<UserPlus size={22} />} title="No requests yet" text="Requests you send appear here with their progress." /> : (
            <div className="card-b" style={{ paddingTop: 4 }}>{st.data.requests.map((r: any) => (
              <div key={r.id} className="checklist-item">
                <div style={{ flex: 1, minWidth: 0 }}><div className="small bold">{r.openings} × {r.title}</div><div className="tiny muted">{humanize(r.employment_type)} · {date(r.created_at)} · by {r.requested_by_name ?? '—'}{r.submissions ? ` · ${r.submissions} candidate${r.submissions === 1 ? '' : 's'} submitted` : ''}</div></div>
                <StatusPill status={r.status} label={STATUS_LABEL[r.status] ?? humanize(r.status)} />
              </div>
            ))}</div>
          )}
        </Card>
      </div>
    </div>
  );
}
