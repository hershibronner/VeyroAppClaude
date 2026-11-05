import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Camera, Copy, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, Field, LoadingBlock, Menu, PageHeader, StatusPill, TagInput, useConfirm } from '../../components/ui';
import { FormDrawer, type FieldDef } from '../../components/FormDrawer';
import { Gate, ReadOnlyNote, SettingsForm, Toggle, NumField, bpToPct, pctToBp } from './common';

export function PortalsPage() {
  return <div className="stack"><PageHeader title="Portals" sub="Control what clients, workers and candidates can do in their branded portals." />
    <Gate resource="settings">{editable => <><ReadOnlyNote show={!editable} />
      <SettingsForm<any> settingKey="portals" title="Portal access" editable={editable} render={(v, set) => <>
        <Toggle checked={!!v.client_enabled} onChange={x => set({ client_enabled: x })} label="Client portal" hint="Clients see their team, approve timesheets, pay invoices and review candidates" disabled={!editable} />
        <Toggle checked={v.client_can_request_workers !== false} onChange={x => set({ client_can_request_workers: x })} label="Clients can request workers" hint="“Request a Worker” creates a draft position and notifies the account manager" disabled={!editable || !v.client_enabled} />
        <Toggle checked={v.client_can_invite_users !== false} onChange={x => set({ client_can_invite_users: x })} label="Client owners can invite their colleagues" hint="Client users are always free" disabled={!editable || !v.client_enabled} />
        <Toggle checked={!!v.worker_enabled} onChange={x => set({ worker_enabled: x })} label="Worker portal & time tracker" hint="Workers clock in, see schedule, timesheets, payslips and training" disabled={!editable} />
        <Toggle checked={v.worker_can_request_time_off !== false} onChange={x => set({ worker_can_request_time_off: x })} label="Workers can request time off" disabled={!editable || !v.worker_enabled} />
        <Toggle checked={!!v.candidate_enabled} onChange={x => set({ candidate_enabled: x })} label="Candidate portal" hint="Candidates track applications, complete assessments and sign offers" disabled={!editable} />
        <Field label="Portal welcome message" htmlFor="p-welcome" hint="Shown at the top of the client and worker portal home"><textarea id="p-welcome" className="textarea" value={v.welcome_message ?? ''} maxLength={500} onChange={e => set({ welcome_message: e.target.value })} placeholder="Welcome! Message your account manager any time from the Messages tab." /></Field>
      </>} />
      <Card><CardHeader title="Branding & invitations" /><div className="card-b small muted">Portals use your logo and colors from <Link to="/settings">General & Branding</Link>. Client users are invited from the client record or by the client owner in their portal; workers are invited from the placement once it is active.</div></Card>
    </>}</Gate></div>;
}

export function AiPage() {
  return <div className="stack"><PageHeader title="AI" sub="The local, deterministic AI adapter only uses facts found in the source text and always shows its evidence." />
    <Gate resource="settings">{editable => <><ReadOnlyNote show={!editable} />
      <SettingsForm<any> settingKey="ai" title="AI assistance" editable={editable} render={(v, set, err, meta) => <>
        {v.simulate_failure && <Banner tone="warn" icon={<Bot size={18} />}>Provider failure simulation is <b>on</b>. Resume analysis, matching and drafting will return “AI provider unavailable — try again or fill fields manually”.</Banner>}
        <Toggle checked={!!v.enabled} onChange={x => set({ enabled: x })} label="Enable AI features" hint="Resume analysis, best-match ranking with explanations and template drafting" disabled={!editable} />
        <Toggle checked={v.require_human_review !== false} onChange={x => set({ require_human_review: x })} label="Require human review" hint="AI suggestions are never applied to records without a recruiter confirming them" disabled={!editable} />
        <Toggle checked={!!v.simulate_failure} onChange={x => set({ simulate_failure: x })} label="Simulate provider failure" hint="Demo the error state: every AI call fails with a friendly 503 and the AI integration shows an error" disabled={!editable} />
        <div className="form-grid mt-2">
          <Field label="Model" htmlFor="ai-model"><select id="ai-model" className="select" value={v.model ?? 'veyro-local-v1'} onChange={e => set({ model: e.target.value })}><option value="veyro-local-v1">Veyro Local v1 (deterministic)</option></select></Field>
          <NumField id="ai-th" label="Minimum match score shown" value={v.match_threshold ?? 40} min={0} max={100} suffix="/ 100" onChange={n => set({ match_threshold: n })} error={err.match_threshold} />
        </div>
        <div className="small muted mt-2">AI integration status: <StatusPill status={meta.integration?.status} /> {meta.integration?.last_error && <span>— {meta.integration.last_error}</span>} · <Link to="/settings/integrations">Integrations</Link></div>
      </>} />
    </>}</Gate></div>;
}

export function PayrollPage() {
  return <div className="stack"><PageHeader title="Payroll settings" sub="Pay periods, overtime rules and payout currencies used when Finance runs payroll." />
    <Gate resource="settings">{editable => <><ReadOnlyNote show={!editable} />
      <SettingsForm<any> settingKey="payroll" title="Pay schedule & overtime" editable={editable} sub={undefined} render={(v, set, err, meta) => <>
        <div className="form-grid">
          <Field label="Pay frequency" htmlFor="pr-f"><select id="pr-f" className="select" value={v.frequency} onChange={e => set({ frequency: e.target.value })}><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="semi_monthly">Twice a month (1st–15th, 16th–end)</option><option value="monthly">Monthly</option></select></Field>
          <NumField id="pr-off" label="Pay day" value={v.pay_day_offset} min={0} max={30} suffix="days after period end" onChange={n => set({ pay_day_offset: n })} error={err.pay_day_offset} />
          <NumField id="pr-ot" label="Overtime multiplier" value={(v.default_ot_multiplier_bp ?? 15000) / 10000} step={0.05} min={1} max={3} suffix="× base pay" onChange={n => set({ default_ot_multiplier_bp: Math.round(n * 10000) })} error={err.default_ot_multiplier_bp} hint="Applied to approved minutes above the weekly threshold" />
          <NumField id="pr-th" label="Overtime after" value={Math.round((v.ot_threshold_minutes ?? 2400) / 60)} min={0} max={100} suffix="hours per week" onChange={n => set({ ot_threshold_minutes: n * 60 })} error={err.ot_threshold_minutes} />
          <Field label="Payout currencies" full hint="Workers can be paid in these currencies (simulated Wise)" error={err.currencies}><TagInput value={v.currencies ?? []} onChange={c => set({ currencies: c.map(x => x.toUpperCase().slice(0, 3)) })} suggestions={['USD', 'PHP', 'MXN', 'ZAR', 'COP', 'KES', 'INR', 'EUR', 'GBP']} placeholder="Add a currency code" /></Field>
        </div>
        {meta.last_run && <div className="small muted mt-2">Last payroll run: {meta.last_run.period_start} – {meta.last_run.period_end} (<StatusPill status={meta.last_run.status} />). Changes apply to the next run; past runs are never recalculated.</div>}
      </>} />
    </>}</Gate></div>;
}

export function InvoicePage() {
  return <div className="stack"><PageHeader title="Invoice settings" sub="Numbering, payment terms and tax defaults for client invoices." />
    <Gate resource="settings">{editable => <><ReadOnlyNote show={!editable} />
      <SettingsForm<any> settingKey="invoice" title="Numbering, terms & tax" editable={editable} render={(v, set, err, meta) => <>
        <div className="form-grid">
          <Field label="Number prefix" htmlFor="iv-p" error={err.prefix} hint={meta.last_number ? `Last issued: ${meta.last_number}` : `New invoices start with ${v.prefix || 'INV'}-`}><input id="iv-p" className="input mono" value={v.prefix ?? ''} onChange={e => set({ prefix: e.target.value.toUpperCase() })} /></Field>
          <NumField id="iv-t" label="Default payment terms" value={v.terms_days} min={0} max={120} suffix="days (net)" onChange={n => set({ terms_days: n })} error={err.terms_days} hint="Clients can override this on their record" />
          <NumField id="iv-tax" label="Default tax rate" value={bpToPct(v.tax_bp)} step={0.01} min={0} max={50} suffix="%" onChange={n => set({ tax_bp: pctToBp(n) })} error={err.tax_bp} />
          <NumField id="iv-lf" label="Late fee" value={bpToPct(v.late_fee_bp)} step={0.01} min={0} max={20} suffix="% per month overdue" onChange={n => set({ late_fee_bp: pctToBp(n) })} error={err.late_fee_bp} />
          <Field label="Invoice footer" htmlFor="iv-f" full error={err.footer}><textarea id="iv-f" className="textarea" value={v.footer ?? ''} maxLength={500} onChange={e => set({ footer: e.target.value })} /></Field>
        </div>
        <div className="small muted mt-2">Tax is applied to the invoice subtotal (approved hours × bill rate per rate period). Changes affect new invoices only — issued invoices are never changed.</div>
      </>} />
    </>}</Gate></div>;
}

const policyFields: FieldDef[] = [
  { name: 'name', label: 'Policy name', required: true, full: true },
  { name: 'screenshots_enabled', label: 'Screenshots', type: 'checkbox', placeholder: 'Capture screenshots while clocked in' },
  { name: 'screenshot_interval_min', label: 'Screenshot interval (minutes)', type: 'number', required: true, hidden: v => !v.screenshots_enabled, hint: 'One random capture inside each interval' },
  { name: 'blur', label: 'Blur screenshots', type: 'checkbox', placeholder: 'Blur everywhere, including the client portal', hidden: v => !v.screenshots_enabled },
  { name: 'client_can_view', label: 'Client access', type: 'checkbox', placeholder: 'Clients can view screenshots & activity', hidden: v => !v.screenshots_enabled },
  { name: 'worker_delete_window_min', label: 'Worker can delete within (minutes)', type: 'number', required: true, hidden: v => !v.screenshots_enabled },
  { name: 'activity_tracking', label: 'Activity levels', type: 'checkbox', placeholder: 'Record keyboard/mouse activity counts (never content)' },
  { name: 'idle_minutes', label: 'Idle after (minutes)', type: 'number', required: true },
  { name: 'retention_days', label: 'Keep data for (days)', type: 'number', required: true },
];
export function MonitoringPage() {
  return <div className="stack"><PageHeader title="Time Tracking & Monitoring" sub="Attendance rules and monitoring policies. Workers accept the policy for their placement before the first clock-in." />
    <Gate resource="settings">{editable => <><ReadOnlyNote show={!editable} />
      <SettingsForm<any> settingKey="time_tracking" title="Attendance & time rules" editable={editable} render={(v, set, err) => <>
        <div className="form-grid">
          <NumField id="tt-late" label="Late after" value={v.late_grace_minutes} min={0} max={120} suffix="minutes past shift start" onChange={n => set({ late_grace_minutes: n })} error={err.late_grace_minutes} hint="Triggers the “worker late” alert and automation" />
          <NumField id="tt-abs" label="Absent after" value={v.absent_after_minutes} min={15} max={600} suffix="minutes with no clock-in" onChange={n => set({ absent_after_minutes: n })} error={err.absent_after_minutes} />
          <NumField id="tt-ret" label="Default retention" value={v.retention_days} min={7} max={730} suffix="days" onChange={n => set({ retention_days: n })} error={err.retention_days} hint="Screenshots and activity older than this are deleted by the retention job" />
          <NumField id="tt-max" label="Maximum shift" value={v.max_shift_hours ?? 12} min={1} max={24} suffix="hours (auto clock-out)" onChange={n => set({ max_shift_hours: n })} error={err.max_shift_hours} />
        </div>
        <div className="mt-2">
          <Toggle checked={v.allow_manual_time !== false} onChange={x => set({ allow_manual_time: x })} label="Allow manual time requests" hint="Workers can ask to add missed time; a manager approves it" disabled={!editable} />
          <Toggle checked={v.require_policy_acceptance !== false} onChange={x => set({ require_policy_acceptance: x })} label="Require monitoring policy acceptance" hint="The tracker stays locked until the worker accepts their placement's policy" disabled={!editable} />
        </div>
      </>} />
      <MonitoringPolicies editable={editable} />
    </>}</Gate></div>;
}

function MonitoringPolicies({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[] }>('/api/v1/settings/monitoring-policies');
  const [edit, setEdit] = useState<any>(null);
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock /></Card>;
  return (
    <Card>
      <CardHeader title="Monitoring policies" sub="Assigned per placement. Changes apply to new captures immediately." right={editable && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ screenshots_enabled: true, screenshot_interval_min: 10, blur: false, client_can_view: true, worker_delete_window_min: 10, activity_tracking: true, idle_minutes: 5, retention_days: 90 })}>New policy</Button>} />
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Policy</th><th>Screenshots</th><th>Activity</th><th>Idle</th><th>Retention</th><th>Client view</th><th style={{ textAlign: 'right' }}>Placements</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{st.data.rows.map(p => (
          <tr key={p.id}>
            <td><div className="bold row" style={{ gap: 6 }}>{p.name}{p.is_default && <StatusPill status="default" label="Default" tone="blue" />}</div><div className="tiny muted">created {dateTime(p.created_at)}</div></td>
            <td>{p.screenshots_enabled ? <span className="row" style={{ gap: 4 }}><Camera size={14} /> every {p.screenshot_interval_min} min{p.blur ? ' · blurred' : ''}</span> : <span className="muted">Off</span>}</td>
            <td>{p.activity_tracking ? 'Counts only' : <span className="muted">Off</span>}</td>
            <td>{p.idle_minutes} min</td><td>{p.retention_days} days</td>
            <td>{p.screenshots_enabled && p.client_can_view ? 'Yes' : <span className="muted">No</span>}</td>
            <td className="money">{p.placements}</td>
            <td className="act">{editable && <Menu items={[
              { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setEdit(p) },
              { label: 'Duplicate', icon: <Copy size={15} />, onClick: () => setEdit({ ...p, id: undefined, is_default: false, name: `${p.name} (copy)` }) },
              { label: 'Make default', icon: <Star size={15} />, hidden: p.is_default, onClick: async () => { try { await api.post(`/api/v1/settings/monitoring-policies/${p.id}/default`); toast.success(`${p.name} is now the default for new placements`); st.reload(); } catch (e) { toast.error(e); } } },
              { label: 'Delete', icon: <Trash2 size={15} />, danger: true, hidden: p.is_default, onClick: async () => { const c = await confirm({ title: `Delete ${p.name}?`, danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/settings/monitoring-policies/${p.id}`); toast.success('Policy deleted'); st.reload(); } catch (e) { toast.error(e); } } },
            ]} />}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New monitoring policy'} fields={policyFields} initial={edit ?? {}} submitLabel="Save policy"
        onSubmit={async v => { const body = { name: v.name, screenshots_enabled: !!v.screenshots_enabled, screenshot_interval_min: Number(v.screenshot_interval_min ?? 10), blur: !!v.blur, client_can_view: !!v.client_can_view, worker_delete_window_min: Number(v.worker_delete_window_min ?? 10), activity_tracking: !!v.activity_tracking, idle_minutes: Number(v.idle_minutes), retention_days: Number(v.retention_days) }; if (edit.id) await api.patch(`/api/v1/settings/monitoring-policies/${edit.id}`, body); else await api.post('/api/v1/settings/monitoring-policies', body); toast.success('Policy saved'); st.reload(); }} />
    </Card>
  );
}
