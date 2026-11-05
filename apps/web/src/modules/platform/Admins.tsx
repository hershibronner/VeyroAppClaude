import { useEffect, useState } from 'react';
import { CalendarClock, ShieldOff, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { date, money, relTime } from '../../lib/format';
import { Button, Card, CardHeader, ErrorState, Field, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm, MoneyInput } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { Toggle, NumField } from '../settings/common';

export function AdminsPage() {
  const st = useApi<any[]>('/api/v1/platform/admins');
  const [invite, setInvite] = useState(false);
  const [expiry, setExpiry] = useState<any>(null);
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  return (
    <div className="stack">
      <PageHeader title="Platform admins" sub="VeyroApp staff with access to this control center. Platform access is separate from any agency role and can be time-limited." actions={<Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInvite(true)}>Invite platform admin</Button>} />
      <Card>
        {!st.data ? <LoadingBlock /> : <div className="table-wrap"><table className="table"><thead><tr><th>Admin</th><th>Status</th><th>Access expires</th><th>Invited by</th><th>Last sign-in</th><th>Added</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {st.data.map(a => <tr key={a.id}>
            <td><div className="bold">{a.name}{a.is_me ? ' (you)' : ''}</div><div className="small muted">{a.email}</div></td>
            <td><StatusPill status={a.effective_status} /></td>
            <td>{a.expires_at ? `${date(a.expires_at)} (${relTime(a.expires_at)})` : 'Never'}</td>
            <td>{a.invited_by_name ?? '—'}</td>
            <td>{a.last_login_at ? relTime(a.last_login_at) : a.has_password ? 'Never' : 'Invite pending'}</td>
            <td>{date(a.created_at)}</td>
            <td className="act"><Menu items={[
              { label: 'Change expiry', icon: <CalendarClock size={15} />, onClick: () => setExpiry(a), hidden: a.is_me },
              { label: 'Reactivate', onClick: async () => { try { await api.patch(`/api/v1/platform/admins/${a.id}`, { status: 'active', expires_at: null }); toast.success('Access restored'); st.reload(); } catch (e) { toast.error(e); } }, hidden: a.effective_status === 'active' },
              { label: 'Revoke access', icon: <ShieldOff size={15} />, danger: true, hidden: a.is_me || a.effective_status !== 'active', onClick: async () => { const c = await confirm({ title: `Revoke ${a.name}'s platform access?`, body: 'They are signed out of the control center immediately. Their agency memberships are not affected.', danger: true, confirmLabel: 'Revoke' }); if (!c.ok) return; try { await api.patch(`/api/v1/platform/admins/${a.id}`, { status: 'revoked' }); toast.success('Access revoked'); st.reload(); } catch (e) { toast.error(e); } } },
            ]} /></td>
          </tr>)}
        </tbody></table></div>}
      </Card>
      <FormDrawer open={invite} onClose={() => setInvite(false)} title="Invite platform admin" submitLabel="Send invitation"
        fields={[{ name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'expires_at', label: 'Access expires', type: 'date', hint: 'Leave empty for permanent access (e.g. contractors get an end date)' }]}
        onSubmit={async v => { await api.post('/api/v1/platform/admins', { name: v.name, email: v.email, expires_at: v.expires_at ? `${v.expires_at}T23:59:59Z` : null }); toast.success(`Invitation sent to ${v.email} (see Dev Outbox)`); st.reload(); }} />
      <FormDrawer open={!!expiry} onClose={() => setExpiry(null)} title={expiry ? `Access for ${expiry.name}` : ''} initial={{ expires_at: expiry?.expires_at ? String(expiry.expires_at).slice(0, 10) : '' }} submitLabel="Save"
        fields={[{ name: 'expires_at', label: 'Access expires', type: 'date', hint: 'Empty = never expires' }]}
        onSubmit={async v => { await api.patch(`/api/v1/platform/admins/${expiry.id}`, { expires_at: v.expires_at ? `${v.expires_at}T23:59:59Z` : null }); toast.success('Expiry updated'); st.reload(); }} />
    </div>
  );
}

export function SettingsPage() {
  const st = useApi<any>('/api/v1/platform/settings');
  const [d, setD] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setD(st.data); }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!d) return <Card><LoadingBlock /></Card>;
  const set = (p: any) => setD((x: any) => ({ ...x, ...p }));
  const dirty = JSON.stringify(d) !== JSON.stringify(st.data);
  return (
    <div className="stack">
      <PageHeader title="Platform settings" sub="Global defaults for VeyroApp. The platform brand is separate from every tenant's brand." actions={<><Button disabled={!dirty} onClick={() => setD(st.data)}>Discard</Button><Button variant="primary" disabled={!dirty} loading={busy} onClick={async () => { setBusy(true); setErrors({}); try { await api.put('/api/v1/platform/settings', d); toast.success('Platform settings saved (audited)'); st.reload(); } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); } }}>Save changes</Button></>} />
      <div className="grid-2">
        <Card><CardHeader title="Brand & support" /><div className="card-b form-grid">
          <Field label="Platform name" htmlFor="ps-n" error={errors.platform_name}><input id="ps-n" className="input" value={d.platform_name} onChange={e => set({ platform_name: e.target.value })} /></Field>
          <Field label="Support email" htmlFor="ps-e" error={errors.support_email}><input id="ps-e" className="input" type="email" value={d.support_email} onChange={e => set({ support_email: e.target.value })} /></Field>
          <Field label="Maintenance banner" htmlFor="ps-b" full hint="Shown at the top of every agency Help Center and this control center" error={errors.maintenance_banner}><input id="ps-b" className="input" value={d.maintenance_banner} onChange={e => set({ maintenance_banner: e.target.value })} placeholder="e.g. Scheduled maintenance Sunday 02:00–03:00 UTC" /></Field>
        </div></Card>
        <Card><CardHeader title="Billing defaults" sub={`Current default seat price ${money(d.seat_price_cents)} — plan prices override it`} /><div className="card-b form-grid">
          <Field label="Default seat price / month" htmlFor="ps-sp" error={errors.seat_price_cents}><MoneyInput id="ps-sp" cents={d.seat_price_cents} onChange={c => set({ seat_price_cents: c ?? 0 })} /></Field>
          <NumField id="ps-td" label="Trial length" value={d.default_trial_days} min={0} max={90} suffix="days" onChange={n => set({ default_trial_days: n })} error={errors.default_trial_days} />
          <NumField id="ps-tx" label="Default tax" value={d.default_tax_bp / 100} step={0.01} min={0} max={50} suffix="%" onChange={n => set({ default_tax_bp: Math.round(n * 100) })} error={errors.default_tax_bp} />
        </div></Card>
        <Card><CardHeader title="Support mode" /><div className="card-b">
          <NumField id="ps-im" label="Maximum session length" value={d.impersonation_max_minutes} min={5} max={480} suffix="minutes" onChange={n => set({ impersonation_max_minutes: n })} error={errors.impersonation_max_minutes} />
          <Toggle id="ps-rr" checked={!!d.require_impersonation_reason} onChange={v => set({ require_impersonation_reason: v })} label="Require a reason" hint="A written reason is always stored in the audit log" disabled />
        </div></Card>
      </div>
    </div>
  );
}
