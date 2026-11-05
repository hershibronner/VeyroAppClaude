import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Play, FlaskConical, Pencil, Trash2, Zap, History, Clock, ShieldCheck, X, CheckCircle2, XCircle, Radio } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { relTime, humanize } from '../../lib/format';
import { Button, Card, Drawer, EmptyState, ErrorState, Field, LoadingBlock, Menu, PageHeader, Segmented, StatusPill, useConfirm, Banner, KpiRow } from '../../components/ui';
import { Toggle } from '../home/kit';

export interface Catalog { events: { key: string; label: string; fields: string[] }[]; schedules: { key: string; label: string; fields: string[] }[]; actions: string[]; recipients: string[]; roles: { key: string; name: string }[]; templates: { key: string; name: string; channel: string }[]; statusTargets: Record<string, string[]> }
interface Auto { id?: string; name: string; description: string | null; trigger_kind: 'event' | 'schedule'; trigger_event: string; schedule: string | null; conditions: { field: string; op: string; value: any }[]; actions: any[]; requires_approval: boolean; enabled: boolean }

const ACTION_LABEL: Record<string, string> = { notify: 'Send a notification', create_task: 'Create a task', send_template: 'Send a message template', change_status: 'Change a status', assign: 'Assign to someone', webhook: 'Call a webhook', start_offboarding: 'Start offboarding checklist' };
const SCHEDULE_LABEL: Record<string, string> = { every_5m: 'Every 5 minutes', hourly: 'Every hour', daily: 'Every day' };
export const recipientLabel = (k: string, roles: { key: string; name: string }[] = []) => ({ account_manager: 'Account manager', attributed_recruiter: 'Attributed recruiter', position_recruiters: 'Position recruiters', worker: 'The worker', candidate: 'The candidate', client_contact: 'Client contact', owner_admins: 'Owners & admins' } as Record<string, string>)[k] ?? (k.startsWith('role:') ? `Everyone with role: ${roles.find(r => r.key === k.slice(5))?.name ?? humanize(k.slice(5))}` : k.startsWith('email:') ? k.slice(6) : k.startsWith('user:') ? 'Specific person' : humanize(k));
export function triggerLabel(a: { trigger_kind: string; trigger_event: string | null; schedule?: string | null }, cat?: Catalog | null) {
  const list = a.trigger_kind === 'event' ? cat?.events : cat?.schedules;
  const l = list?.find(t => t.key === a.trigger_event)?.label ?? humanize(a.trigger_event ?? '');
  return a.trigger_kind === 'schedule' ? `${l} (${(SCHEDULE_LABEL[a.schedule ?? 'hourly'] ?? 'hourly').toLowerCase()})` : l;
}

export default function Workflows() {
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const cat = useApi<Catalog>('/api/v1/automations/catalog');
  const list = useApi<{ rows: any[] }>('/api/v1/automations?pageSize=200');
  const summary = useApi<any>('/api/v1/automations/runs/summary');
  const [editing, setEditing] = useState<Auto | null>(null);
  const [testFor, setTestFor] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = can('automation', 'edit'), canCreate = can('automation', 'create');
  const reload = () => { list.reload(); summary.reload(); };
  const toggle = async (a: any, on: boolean) => {
    try { await api.patch(`/api/v1/automations/${a.id}`, { enabled: on }); toast.success(`${a.name} ${on ? 'enabled' : 'disabled'}`); reload(); } catch (e) { toast.error(e); }
  };
  const runNow = async (a: any) => {
    setBusy(a.id);
    try {
      const r = await api.post<any>(`/api/v1/automations/${a.id}/run`);
      toast.success(r.kind === 'schedule' ? `Scanned ${r.scanned} record${r.scanned === 1 ? '' : 's'} · ${r.executed} new run${r.executed === 1 ? '' : 's'}` : r.executed ? 'Ran once against the latest matching record' : 'Conditions not met for the latest record — see the run log');
      reload();
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const fire = async (a: any) => {
    setBusy(a.id);
    try { const r = await api.post<any>(`/api/v1/automations/${a.id}/fire`); toast.success(`Fired a sample "${r.event}" event through the event bus`); setTimeout(reload, 2500); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const del = async (a: any) => {
    const c = await confirm({ title: `Delete “${a.name}”?`, body: 'Its run history is deleted too. Disable it instead if you may need it again.', danger: true, typeToConfirm: 'DELETE', confirmLabel: 'Delete automation' });
    if (!c.ok) return;
    try { await api.del(`/api/v1/automations/${a.id}`); toast.success('Automation deleted'); reload(); } catch (e) { toast.error(e); }
  };
  const s = summary.data;
  return (
    <div>
      <PageHeader title="Automations" sub="WHEN something happens (or on a schedule) → IF conditions match → DO actions. Every run is logged."
        actions={<>
          <Button icon={<History size={16} />} onClick={() => nav('/automation/runs')}>Run log</Button>
          {canCreate && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing({ name: '', description: '', trigger_kind: 'event', trigger_event: 'attendance.late', schedule: null, conditions: [], actions: [{ type: 'notify', to: 'account_manager', title: '' }], requires_approval: false, enabled: true })}>New automation</Button>}
        </>} />
      {s?.pending > 0 && <Banner tone="warn">{s.pending} automation run{s.pending === 1 ? ' is' : 's are'} waiting for human approval. <Link to="/automation/runs?status=pending_approval">Review approvals</Link></Banner>}
      {s && <KpiRow compact items={[
        { label: 'Succeeded (7 days)', icon: <CheckCircle2 size={16} />, value: s.succeeded_7d, deltaText: <span className="muted">actions executed</span>, suffix: '', to: '/automation/runs?status=succeeded' },
        { label: 'Failed (7 days)', icon: <XCircle size={16} />, value: s.failed_7d, deltaText: <span className="muted">retry from the run log</span>, suffix: '', to: '/automation/runs?status=failed' },
        { label: 'Awaiting approval', icon: <ShieldCheck size={16} />, value: s.pending, deltaText: <span className="muted">human-in-the-loop</span>, suffix: '', to: '/automation/runs?status=pending_approval' },
        { label: 'Active workflows', icon: <Zap size={16} />, value: (list.data?.rows ?? []).filter(a => a.enabled).length, deltaText: <span className="muted">of {(list.data?.rows ?? []).length} total</span>, suffix: '' },
      ]} />}
      {list.error && !list.data ? <ErrorState error={list.error} retry={list.reload} /> : !list.data || !cat.data ? <LoadingBlock rows={6} /> : list.data.rows.length === 0 ? <Card><EmptyState icon={<Zap size={22} />} title="No automations yet" text="Create your first workflow to automate reminders, tasks and follow-ups." /></Card> : (
        <div className="ins-auto-grid">
          {list.data.rows.map(a => (
            <Card key={a.id} pad className="ins-auto">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}><div className="bold" style={{ fontSize: 15.5 }}>{a.name}</div>{a.description && <div className="small muted mt-1">{a.description}</div>}</div>
                <Toggle on={a.enabled} label={a.enabled ? `Disable ${a.name}` : `Enable ${a.name}`} disabled={!canEdit} onChange={on => toggle(a, on)} />
              </div>
              <div className="ins-flow"><span className="k">WHEN</span><span className="chip">{a.trigger_kind === 'schedule' ? <Clock size={12} /> : <Radio size={12} />}&nbsp;{triggerLabel(a, cat.data)}</span></div>
              {a.conditions.length > 0 && <div className="ins-flow"><span className="k">IF</span>{a.conditions.map((c: any, i: number) => <span key={i} className="chip">{humanize(c.field)} {c.op} {String(c.value ?? '')}</span>)}</div>}
              <div className="ins-flow"><span className="k">DO</span>{a.requires_approval && <span className="chip"><ShieldCheck size={12} />&nbsp;Approval</span>}{a.actions.map((x: any, i: number) => <span key={i} className="chip">{ACTION_LABEL[x.type] ?? x.type}{x.to || x.assignee ? ` → ${recipientLabel(x.to ?? x.assignee, cat.data!.roles)}` : x.template ? ` (${x.template})` : ''}</span>)}</div>
              <div className="ins-stat-row"><span><b>{a.runs_30d}</b> runs (30d)</span>{a.failed_30d > 0 && <span className="down"><b className="down">{a.failed_30d}</b> failed</span>}{a.pending > 0 && <span><b>{a.pending}</b> awaiting approval</span>}<span>Last fired {a.last_fired_at ? relTime(a.last_fired_at) : 'never'}</span></div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {canEdit && <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing({ ...a })}>Edit</Button>}
                <Button size="sm" icon={<FlaskConical size={14} />} onClick={() => setTestFor(a)}>Test run</Button>
                {canEdit && a.enabled && <Button size="sm" icon={<Play size={14} />} loading={busy === a.id} onClick={() => runNow(a)}>Run now</Button>}
                <Menu items={[
                  { label: 'View run log', icon: <History size={15} />, onClick: () => nav(`/automation/runs?automation_id=${a.id}`) },
                  { label: 'Fire a sample event', icon: <Radio size={15} />, onClick: () => fire(a), hidden: !canEdit || a.trigger_kind !== 'event' || !a.enabled, title: 'Emits the trigger event through the real event bus (automations + webhooks)' },
                  { sep: true, hidden: !can('automation', 'delete') },
                  { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: () => del(a), hidden: !can('automation', 'delete') },
                ]} />
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && cat.data && <Builder initial={editing} cat={cat.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {testFor && <TestDrawer auto={testFor} onClose={() => setTestFor(null)} />}
    </div>
  );
}

function RecipientSelect({ value, onChange, cat, id, emailOk }: { value: string; onChange: (v: string) => void; cat: Catalog; id?: string; emailOk?: boolean }) {
  const custom = value?.startsWith('email:');
  return (<>
    <select id={id} className="select" value={custom ? '__email' : value ?? ''} onChange={e => onChange(e.target.value === '__email' ? 'email:' : e.target.value)}>
      <option value="">Choose…</option>
      {cat.recipients.map(r => <option key={r} value={r}>{recipientLabel(r, cat.roles)}</option>)}
      {emailOk && <option value="__email">A specific email address…</option>}
    </select>
    {custom && <input className="input mt-1" type="email" placeholder="name@example.com" value={value.slice(6)} onChange={e => onChange(`email:${e.target.value}`)} aria-label="Email address" />}
  </>);
}

function Builder({ initial, cat, onClose, onSaved }: { initial: Auto; cat: Catalog; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<Auto>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const triggers = a.trigger_kind === 'event' ? cat.events : cat.schedules;
  const fields = triggers.find(t => t.key === a.trigger_event)?.fields ?? [];
  const set = (p: Partial<Auto>) => setA(x => ({ ...x, ...p }));
  const setAction = (i: number, p: any) => set({ actions: a.actions.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  useEffect(() => { setTest(null); }, [a.trigger_event, a.trigger_kind]);
  const body = () => ({ name: a.name, description: a.description || null, trigger_kind: a.trigger_kind, trigger_event: a.trigger_event, schedule: a.trigger_kind === 'schedule' ? a.schedule ?? 'hourly' : null, conditions: a.conditions.map(c => ({ ...c, value: c.value !== '' && !Number.isNaN(Number(c.value)) && c.op !== 'contains' && c.op !== 'in' ? Number(c.value) : c.value })), actions: a.actions, requires_approval: a.requires_approval, enabled: a.enabled });
  const save = async () => {
    setSaving(true); setErrors({});
    try { if (a.id) await api.patch(`/api/v1/automations/${a.id}`, body()); else await api.post('/api/v1/automations', body()); toast.success('Automation saved'); onSaved(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  const runTest = async () => {
    setTesting(true);
    try { setTest(await api.post('/api/v1/automations/test', { automation_id: a.id, definition: body() })); } catch (e) { toast.error(e); } finally { setTesting(false); }
  };
  const err = (k: string) => errors[k];
  return (
    <Drawer open onClose={onClose} wide title={a.id ? `Edit automation` : 'New automation'} footer={<><Button onClick={onClose}>Cancel</Button><Button icon={<FlaskConical size={15} />} loading={testing} onClick={runTest}>Test run</Button><Button variant="primary" loading={saving} onClick={save}>Save automation</Button></>}>
      <div className="form-grid">
        <Field label="Name *" htmlFor="au-name" error={err('name')} full><input id="au-name" className="input" value={a.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Worker 15 minutes late" /></Field>
        <Field label="Description" htmlFor="au-desc" full><input id="au-desc" className="input" value={a.description ?? ''} onChange={e => set({ description: e.target.value })} /></Field>
      </div>
      <div className="ins-step">When</div>
      <Segmented options={[{ key: 'event', label: 'Something happens' }, { key: 'schedule', label: 'On a schedule' }]} value={a.trigger_kind} onChange={k => set({ trigger_kind: k as Auto['trigger_kind'], trigger_event: (k === 'event' ? cat.events : cat.schedules)[0].key, schedule: k === 'schedule' ? 'hourly' : null })} />
      <div className="form-grid mt-2">
        <Field label={a.trigger_kind === 'event' ? 'Event' : 'Check for'} htmlFor="au-trig" error={err('trigger_event')}><select id="au-trig" className="select" value={a.trigger_event} onChange={e => set({ trigger_event: e.target.value })}>{triggers.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
        {a.trigger_kind === 'schedule' && <Field label="How often" htmlFor="au-sched"><select id="au-sched" className="select" value={a.schedule ?? 'hourly'} onChange={e => set({ schedule: e.target.value })}>{Object.entries(SCHEDULE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
      </div>
      <div className="ins-step">If (all conditions must match)</div>
      {a.conditions.length === 0 && <div className="small muted mb-2">No conditions — runs every time the trigger fires.</div>}
      <datalist id="au-fields">{fields.map(f => <option key={f} value={f} />)}</datalist>
      {a.conditions.map((c, i) => (
        <div key={i} className="row mb-2" style={{ gap: 6 }}>
          <input className="input input-sm" list="au-fields" aria-label="Field" placeholder="field e.g. minutes" value={c.field} onChange={e => set({ conditions: a.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} />
          <select className="select input-sm" aria-label="Operator" style={{ width: 90, flex: 'none' }} value={c.op} onChange={e => set({ conditions: a.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'exists'].map(o => <option key={o} value={o}>{o}</option>)}</select>
          {c.op !== 'exists' && <input className="input input-sm" aria-label="Value" placeholder="value" value={c.value ?? ''} onChange={e => set({ conditions: a.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />}
          <button className="icon-btn" aria-label="Remove condition" onClick={() => set({ conditions: a.conditions.filter((_, j) => j !== i) })}><X size={16} /></button>
        </div>
      ))}
      <Button size="sm" icon={<Plus size={14} />} onClick={() => set({ conditions: [...a.conditions, { field: fields[0] ?? '', op: '>=', value: '' }] })}>Add condition</Button>
      <div className="ins-step">Do</div>
      {a.actions.map((x, i) => {
        const e = (k: string) => err(`actions.${i}.${k}`);
        return (
          <div key={i} className="ins-rule">
            <div className="ins-rule-h">
              <select className="select input-sm" aria-label="Action type" value={x.type} onChange={ev => setAction(i, { type: ev.target.value })} style={{ maxWidth: 280 }}>{cat.actions.map(t => <option key={t} value={t}>{ACTION_LABEL[t] ?? t}</option>)}</select>
              <button className="icon-btn" aria-label="Remove action" disabled={a.actions.length === 1} onClick={() => set({ actions: a.actions.filter((_, j) => j !== i) })}><X size={16} /></button>
            </div>
            <div className="form-grid">
              {(x.type === 'notify' || x.type === 'assign') && <Field label={x.type === 'notify' ? 'Notify' : 'Assign to'} htmlFor={`a${i}to`} error={e('to')}><RecipientSelect id={`a${i}to`} cat={cat} value={x.to ?? ''} onChange={v => setAction(i, { to: v })} /></Field>}
              {x.type === 'notify' && <Field label="Title" htmlFor={`a${i}t`} error={e('title')} hint="Merge variables: {{worker.name}}, {{company.name}}, {{minutes}}…"><input id={`a${i}t`} className="input" value={x.title ?? ''} onChange={ev => setAction(i, { title: ev.target.value })} /></Field>}
              {x.type === 'notify' && <Field label="Message (optional)" htmlFor={`a${i}b`} full><input id={`a${i}b`} className="input" value={x.body ?? ''} onChange={ev => setAction(i, { body: ev.target.value })} /></Field>}
              {x.type === 'create_task' && <>
                <Field label="Assignee" htmlFor={`a${i}as`} error={e('assignee')}><RecipientSelect id={`a${i}as`} cat={cat} value={x.assignee ?? ''} onChange={v => setAction(i, { assignee: v })} /></Field>
                <Field label="Task title" htmlFor={`a${i}tt`} error={e('title')}><input id={`a${i}tt`} className="input" value={x.title ?? ''} onChange={ev => setAction(i, { title: ev.target.value })} /></Field>
                <Field label="Priority" htmlFor={`a${i}p`}><select id={`a${i}p`} className="select" value={x.priority ?? 'medium'} onChange={ev => setAction(i, { priority: ev.target.value })}>{['low', 'medium', 'high', 'urgent'].map(p => <option key={p} value={p}>{humanize(p)}</option>)}</select></Field>
                <Field label="Due in (days)" htmlFor={`a${i}d`}><input id={`a${i}d`} type="number" min={0} className="input" value={x.due_in_days ?? 1} onChange={ev => setAction(i, { due_in_days: Number(ev.target.value) })} /></Field>
              </>}
              {x.type === 'send_template' && <>
                <Field label="Template" htmlFor={`a${i}tp`} error={e('template')}><select id={`a${i}tp`} className="select" value={x.template ?? ''} onChange={ev => setAction(i, { template: ev.target.value })}><option value="">Choose…</option>{cat.templates.map(t => <option key={t.key} value={t.key}>{t.name} ({t.channel})</option>)}</select></Field>
                <Field label="Send to" htmlFor={`a${i}to2`} error={e('to')}><RecipientSelect id={`a${i}to2`} emailOk cat={cat} value={x.to ?? ''} onChange={v => setAction(i, { to: v })} /></Field>
              </>}
              {x.type === 'change_status' && <>
                <Field label="Record" htmlFor={`a${i}en`} error={e('entity')}><select id={`a${i}en`} className="select" value={x.entity ?? ''} onChange={ev => setAction(i, { entity: ev.target.value, status: '' })}><option value="">Choose…</option>{Object.keys(cat.statusTargets).map(k => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
                <Field label="New status" htmlFor={`a${i}st`} error={e('status')}><select id={`a${i}st`} className="select" value={x.status ?? ''} onChange={ev => setAction(i, { status: ev.target.value })}><option value="">Choose…</option>{(cat.statusTargets[x.entity] ?? []).map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
              </>}
              {x.type === 'assign' && <Field label="Record" htmlFor={`a${i}ae`} error={e('entity')}><select id={`a${i}ae`} className="select" value={x.entity ?? ''} onChange={ev => setAction(i, { entity: ev.target.value })}><option value="">Choose…</option>{['application', 'company', 'placement', 'task'].map(k => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>}
              {x.type === 'webhook' && <Field label="URL" htmlFor={`a${i}u`} error={e('url')} full hint="Receives a signed JSON POST (x-veyro-signature when the URL matches a webhook endpoint)."><input id={`a${i}u`} className="input" value={x.url ?? ''} onChange={ev => setAction(i, { url: ev.target.value })} placeholder="http://localhost:4100/api/v1/dev/webhook-receiver/your-slug" /></Field>}
              {x.type === 'start_offboarding' && <div className="small muted full">Adds the offboarding checklist to the placement and moves it to Notice. The account manager completes it from the placement.</div>}
            </div>
          </div>
        );
      })}
      <Button size="sm" className="mt-2" icon={<Plus size={14} />} onClick={() => set({ actions: [...a.actions, { type: 'create_task', assignee: 'account_manager', title: '', priority: 'medium', due_in_days: 1 }] })}>Add action</Button>
      {errors.actions && <div className="err mt-1">{errors.actions}</div>}
      <div className="ins-step">Options</div>
      <label className="check"><input type="checkbox" checked={a.requires_approval} onChange={e => set({ requires_approval: e.target.checked })} /> Require human approval before actions run</label>
      <label className="check mt-1"><input type="checkbox" checked={a.enabled} onChange={e => set({ enabled: e.target.checked })} /> Enabled</label>
      {test && <div className="mt-3"><TestResult r={test} /></div>}
    </Drawer>
  );
}

export function TestResult({ r }: { r: any }) {
  return (
    <Card pad>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>Test run (dry — nothing was sent)</b>{r.wouldRun ? <StatusPill status="succeeded" label="Would run" /> : <StatusPill status="skipped" label="Would be skipped" />}</div>
      {!r.sample && <div className="small muted mt-1">No matching record exists yet, so the test used an empty payload.</div>}
      {r.conditions.length > 0 && <><div className="ins-step mt-2">Conditions</div>{r.conditions.map((c: any, i: number) => <div key={i} className="small">{c.pass ? '✅' : '❌'} {c.field} {c.op} {String(c.value)} <span className="muted">(actual: {c.actual === null ? 'empty' : String(c.actual)})</span></div>)}</>}
      <div className="ins-step mt-2">Actions{r.requiresApproval ? ' (after approval)' : ''}</div>
      {r.planned.map((p: any, i: number) => <div key={i} className="small" style={{ marginBottom: 4 }}>• {p.summary}</div>)}
      {r.variables && <details className="mt-2"><summary className="small muted" style={{ cursor: 'pointer' }}>Sample data used</summary><pre className="ins-pre">{JSON.stringify(Object.fromEntries(Object.entries(r.variables).filter(([k]) => !k.endsWith('_id'))), null, 2)}</pre></details>}
    </Card>
  );
}

function TestDrawer({ auto, onClose }: { auto: any; onClose: () => void }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { api.post('/api/v1/automations/test', { automation_id: auto.id }).then(setR).catch(setErr); }, [auto.id]);
  return (
    <Drawer open onClose={onClose} title={`Test: ${auto.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="small muted" style={{ marginTop: 0 }}>Evaluates the conditions and resolves every recipient against the most recent real record for this trigger — without sending anything. The test is recorded in the run log.</p>
      {err ? <ErrorState error={err} /> : !r ? <LoadingBlock rows={4} /> : <TestResult r={r} />}
    </Drawer>
  );
}
