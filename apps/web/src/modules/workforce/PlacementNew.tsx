import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, X, CheckCircle2, Info } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Field, MemberSelect, EntitySelect, MoneyInput, Banner, LoadingBlock, ErrorState, StatusPill } from '../../components/ui';
import { useApi } from '../../lib/hooks';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { humanize, date } from '../../lib/format';
import { DOW } from './shared';

export const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'Europe/Madrid', 'Africa/Johannesburg', 'Africa/Nairobi', 'Asia/Manila', 'Asia/Kolkata', 'Australia/Sydney', 'America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires', 'America/Lima', 'America/Sao_Paulo'];

export default function PlacementNew() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { can } = useAuth();
  const viewComp = can('rates', 'view_comp') || can('placements', 'view_comp');
  const offerId = sp.get('offerId'), replacesId = sp.get('replacesId'), candidateId = sp.get('candidateId');
  const pre = useApi<any>(`/api/v1/placements/prefill${offerId ? `?offerId=${offerId}` : replacesId ? `?replacesId=${replacesId}` : candidateId ? `?candidateId=${candidateId}` : ''}`);
  const policies = useApi<any[]>('/api/v1/time/policies');
  const [v, setV] = useState<any>(null);
  const [items, setItems] = useState<{ title: string; required: boolean }[]>([]);
  const [newItem, setNewItem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (pre.data && !v) setV({ ...pre.data.defaults, title: pre.data.defaults.title ?? '' }); }, [pre.data, v]);
  const preview = useApi<any[]>(v?.company_id ? `/api/v1/placements/onboarding-preview?company_id=${v.company_id}${v.position_id ? `&position_id=${v.position_id}` : ''}` : null, [v?.company_id, v?.position_id]);
  if (pre.error) return <div><PageHeader title="New placement" back="/workforce/placements" /><ErrorState error={pre.error} retry={pre.reload} /></div>;
  if (!pre.data || !v) return <LoadingBlock rows={8} />;
  const d = pre.data;
  const set = (k: string, val: any) => setV((s: any) => ({ ...s, [k]: val }));
  const lockedPerson = d.source === 'offer' || d.source === 'candidate';
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!v.candidate_id && !v.worker_id) e.candidate_id = 'Choose the person to place';
    if (!v.company_id) e.company_id = 'Choose the client';
    if (!v.title?.trim()) e.title = 'Role title is required';
    if (!v.start_date) e.start_date = 'Start date is required';
    if (!v.schedule_days?.length) e.schedule_days = 'Pick at least one workday';
    if (v.schedule_end <= v.schedule_start) e.schedule_end = 'Shift must end after it starts';
    if (viewComp && (v.pay_rate_cents === null || v.pay_rate_cents === undefined)) e.pay_rate_cents = 'Pay rate is required';
    if (viewComp && (v.bill_rate_cents === null || v.bill_rate_cents === undefined)) e.bill_rate_cents = 'Bill rate is required';
    setErrors(e);
    if (Object.keys(e).length) { toast.error('Please check the highlighted fields'); return; }
    setBusy(true);
    try {
      const body = { ...v, weekly_hours: Number(v.weekly_hours), manual_items: items, position_id: v.position_id || null };
      const r = await api.post('/api/v1/placements', body);
      toast.success(r.worker_reused ? 'Placement created — existing worker record reused' : 'Placement created');
      nav(`/workforce/placements/${r.id}?tab=onboarding`, { replace: true });
    } catch (x) {
      if (x instanceof ApiError && x.fields) setErrors(x.fields);
      if (x instanceof ApiError && x.status === 409 && x.details?.placement_id) { toast.error(x); nav(`/workforce/placements/${x.details.placement_id}`); return; }
      toast.error(x);
    } finally { setBusy(false); }
  };
  const err = (k: string) => errors[k];
  const person = d.candidate;
  return (
    <div>
      <PageHeader title={d.source === 'replacement' ? 'Start a replacement' : 'New placement'} back="/workforce/placements" sub={d.source === 'offer' ? 'Prefilled from the accepted offer — the candidate becomes a worker as the same person.' : d.source === 'replacement' ? `Replacing ${d.replaces.worker_name} at ${d.replaces.company_name}. The current placement stays active (overlap) until you offboard it.` : 'Place a candidate or existing worker with a client.'}
        actions={<><Button onClick={() => nav(-1)}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Create placement</Button></>} />
      {d.existing_placement_id && <Banner tone="warn">A placement was already created from this offer. <a href={`/workforce/placements/${d.existing_placement_id}`} onClick={e => { e.preventDefault(); nav(`/workforce/placements/${d.existing_placement_id}`); }}>Open it →</a></Banner>}
      {person?.worker_id && <Banner tone="info" icon={<Info size={20} />}><b>{person.first_name} {person.last_name}</b> already has a worker record ({person.employee_code ?? 'no code'}, {humanize(person.worker_status)}{person.open_placements ? `, ${person.open_placements} open placement${person.open_placements === 1 ? '' : 's'}` : ''}). It will be reused — no duplicate person is created.</Banner>}
      <div className="grid-main-side">
        <div className="stack" style={{ gap: 20 }}>
          <Card><CardHeader title="Person & client" />
            <div className="card-b"><div className="form-grid">
              <Field label="Person *" htmlFor="pn-cand" error={err('candidate_id')} full>
                {lockedPerson && person ? <div className="row" style={{ gap: 10 }}><b>{person.first_name} {person.last_name}</b><span className="muted small">{person.email}</span><StatusPill status={person.status} /></div>
                  : <EntitySelect id="pn-cand" endpoint="/api/v1/candidates?sort=first_name&dir=asc" extra="exclude_status=blacklisted" value={v.candidate_id} onChange={val => set('candidate_id', val)} labelOf={r => `${r.first_name} ${r.last_name ?? ''} — ${r.email ?? r.headline ?? ''}`} placeholder="Search and choose a candidate…" />}
              </Field>
              <Field label="Client *" htmlFor="pn-co" error={err('company_id')}>
                {d.source === 'replacement' ? <div className="bold">{d.company.name}</div> : <EntitySelect id="pn-co" endpoint="/api/v1/companies?stage=client&sort=name&dir=asc" value={v.company_id} onChange={val => setV((s: any) => ({ ...s, company_id: val, position_id: null }))} labelOf={r => r.name} placeholder="Choose a client…" />}
              </Field>
              <Field label="Position" htmlFor="pn-pos" hint="Optional — links requirements and fills the position">
                {v.company_id ? <EntitySelect key={v.company_id} id="pn-pos" endpoint={`/api/v1/positions?company_id=${v.company_id}`} value={v.position_id} onChange={(val, row) => setV((s: any) => ({ ...s, position_id: val, title: s.title || row?.title || '' }))} labelOf={r => `${r.title} (${humanize(r.status)})`} placeholder="No position" /> : <select id="pn-pos" className="select" disabled><option>Choose a client first</option></select>}
              </Field>
              <Field label="Role title *" htmlFor="pn-title" error={err('title')}><input id="pn-title" className="input" value={v.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Dental Front Desk VA" /></Field>
              <Field label="Start date *" htmlFor="pn-start" error={err('start_date')}><input id="pn-start" type="date" className="input" value={v.start_date ?? ''} onChange={e => set('start_date', e.target.value)} /></Field>
            </div></div>
          </Card>
          <Card><CardHeader title="Schedule" />
            <div className="card-b"><div className="form-grid">
              <Field label="Workdays *" error={err('schedule_days')} full>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{DOW.map((n, i) => { const on = v.schedule_days.includes(i + 1); return <button key={n} type="button" className={`btn btn-sm ${on ? 'btn-primary' : ''}`} aria-pressed={on} onClick={() => set('schedule_days', on ? v.schedule_days.filter((x: number) => x !== i + 1) : [...v.schedule_days, i + 1].sort())}>{n}</button>; })}</div>
              </Field>
              <Field label="Shift start" htmlFor="pn-ss"><input id="pn-ss" type="time" className="input" value={v.schedule_start} onChange={e => set('schedule_start', e.target.value)} /></Field>
              <Field label="Shift end" htmlFor="pn-se" error={err('schedule_end')}><input id="pn-se" type="time" className="input" value={v.schedule_end} onChange={e => set('schedule_end', e.target.value)} /></Field>
              <Field label="Timezone (client)" htmlFor="pn-tz"><select id="pn-tz" className="select" value={v.timezone} onChange={e => set('timezone', e.target.value)}>{[...new Set([v.timezone, ...TIMEZONES])].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
              <Field label="Weekly hours" htmlFor="pn-wh"><input id="pn-wh" type="number" min={1} max={80} className="input" value={v.weekly_hours ?? ''} onChange={e => set('weekly_hours', e.target.value)} /></Field>
            </div></div>
          </Card>
          <Card><CardHeader title="Rates" sub="Effective from the start date. Later changes create new effective-dated rows (Finance)." />
            <div className="card-b">{viewComp ? <div className="form-grid">
              <Field label="Pay rate *" htmlFor="pn-pay" error={err('pay_rate_cents')}><MoneyInput id="pn-pay" cents={v.pay_rate_cents} onChange={c => set('pay_rate_cents', c)} /></Field>
              <Field label="Bill rate *" htmlFor="pn-bill" error={err('bill_rate_cents')} hint={v.pay_rate_cents && v.bill_rate_cents ? `Margin ${(((v.bill_rate_cents - v.pay_rate_cents) / v.bill_rate_cents) * 100).toFixed(1)}%` : undefined}><MoneyInput id="pn-bill" cents={v.bill_rate_cents} onChange={c => set('bill_rate_cents', c)} /></Field>
              <Field label="Currency" htmlFor="pn-cur"><select id="pn-cur" className="select" value={v.currency} onChange={e => set('currency', e.target.value)}>{['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'PHP', 'MXN', 'ZAR'].map(c => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Per" htmlFor="pn-unit"><select id="pn-unit" className="select" value={v.unit} onChange={e => set('unit', e.target.value)}>{['hour', 'day', 'week', 'month'].map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
            </div> : <Banner tone="info">Rates are restricted for your role. {d.source === 'offer' ? 'The accepted offer’s rates will be used.' : 'Ask someone with compensation access to set rates.'}</Banner>}</div>
          </Card>
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <Card><CardHeader title="Team & monitoring" />
            <div className="card-b stack" style={{ gap: 12 }}>
              <Field label="Account manager" htmlFor="pn-am"><MemberSelect id="pn-am" value={v.account_manager_id} onChange={x => set('account_manager_id', x)} placeholder="Client's account manager" /></Field>
              <Field label="Recruiter" htmlFor="pn-rec"><MemberSelect id="pn-rec" value={v.recruiter_id} onChange={x => set('recruiter_id', x)} /></Field>
              <Field label="Sales" htmlFor="pn-sales"><MemberSelect id="pn-sales" value={v.sales_id} onChange={x => set('sales_id', x)} /></Field>
              <Field label="Monitoring policy" htmlFor="pn-pol" hint="The worker accepts it before their first clock-in.">
                <select id="pn-pol" className="select" value={v.monitoring_policy_id ?? ''} onChange={e => set('monitoring_policy_id', e.target.value)}>{(policies.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}</option>)}</select>
              </Field>
              {(() => { const p = (policies.data ?? []).find(x => x.id === v.monitoring_policy_id); return p ? <div className="small muted">{p.screenshots_enabled ? `Screenshots every ${p.screenshot_interval_min} min${p.blur ? ', blurred' : ''}` : 'No screenshots'} · activity {p.activity_tracking ? 'on' : 'off'} · idle after {p.idle_minutes} min · kept {p.retention_days} days · client view {p.client_can_view ? 'yes' : 'no'}</div> : null; })()}
            </div>
          </Card>
          <Card><CardHeader title="Onboarding checklist" sub="Agency template + client requirements + position requirements + your additions" />
            <div className="card-b">
              {!v.company_id ? <div className="muted small">Choose a client to preview the checklist.</div> : (preview.data ?? []).map((it, i) => <div key={i} className="checklist-item"><CheckCircle2 size={16} color="var(--muted-2)" /><div style={{ flex: 1 }}><div>{it.title}</div><div className="small muted">{humanize(it.source)} · {it.required ? 'Required' : 'Optional'} · {it.owner}</div></div></div>)}
              {items.map((it, i) => <div key={`m${i}`} className="checklist-item"><CheckCircle2 size={16} color="var(--primary)" /><div style={{ flex: 1 }}><div>{it.title}</div><div className="small muted">Manual · <label className="check" style={{ display: 'inline-flex' }}><input type="checkbox" checked={it.required} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} /> Required</label></div></div><button className="icon-btn" aria-label={`Remove ${it.title}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><X size={14} /></button></div>)}
              <div className="row" style={{ gap: 8, marginTop: 10 }}><input className="input input-sm" aria-label="New checklist item" placeholder="Add a manual item" value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newItem.trim().length > 1) { setItems([...items, { title: newItem.trim(), required: false }]); setNewItem(''); } }} /><Button size="sm" icon={<Plus size={14} />} disabled={newItem.trim().length < 2} onClick={() => { setItems([...items, { title: newItem.trim(), required: false }]); setNewItem(''); }}>Add</Button></div>
            </div>
          </Card>
          {d.offer && <Card pad><div className="small muted">From offer · signed {d.offer.signed_at ? date(d.offer.signed_at) : '—'} · start {date(d.offer.start_date)}</div></Card>}
        </div>
      </div>
    </div>
  );
}
