import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useApi } from '../../../lib/hooks';
import { toast } from '../../../lib/toast';
import { humanize } from '../../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, Field, KV, LoadingBlock, PageHeader } from '../../../components/ui';
import { Toggle } from '../common';

export default function ClientSettings() {
  const st = useApi<any>('/api/v1/portal/client/settings');
  const [s, setS] = useState<any>(null);
  const [prefs, setPrefs] = useState<any[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => { if (st.data) { setS(st.data.settings); setPrefs(st.data.notifications); } }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data || !s) return <Card><LoadingBlock rows={6} /></Card>;
  const d = st.data;
  const saveCompany = async () => { setBusy('c'); setErrors({}); try { await api.put('/api/v1/portal/client/settings', { timesheet_contact_user_id: s.timesheet_contact_user_id || null, invoice_email: s.invoice_email || null, weekly_digest: !!s.weekly_digest }); toast.success('Company settings saved'); st.reload(); } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(''); } };
  const savePrefs = async () => { setBusy('n'); try { await api.put('/api/v1/portal/client/settings/notifications', { prefs }); toast.success('Notification preferences saved'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <div className="stack">
      <PageHeader title="Settings" sub={d.company?.name} />
      <div className="grid-2">
        <Card>
          <CardHeader title="Approvals & billing contacts" right={d.can_edit_company && <Button size="sm" variant="primary" loading={busy === 'c'} onClick={saveCompany}>Save</Button>} />
          <fieldset className="card-b st-fieldset stack" style={{ gap: 14 }} disabled={!d.can_edit_company}>
            {!d.can_edit_company && <Banner>Only your client owner can change company settings.</Banner>}
            <Field label="Timesheet approval contact" htmlFor="cs-ts" error={errors.timesheet_contact_user_id} hint="Gets the weekly “timesheets ready for approval” reminder">
              <select id="cs-ts" className="select" value={s.timesheet_contact_user_id ?? ''} onChange={e => setS({ ...s, timesheet_contact_user_id: e.target.value || null })}><option value="">Any owner, manager or supervisor</option>{d.approvers.map((a: any) => <option key={a.id} value={a.id}>{a.name} — {a.role_name}</option>)}</select>
            </Field>
            <Field label="Invoice email" htmlFor="cs-ie" error={errors.invoice_email} hint="Where invoices and payment receipts are sent"><input id="cs-ie" className="input" type="email" value={s.invoice_email ?? ''} onChange={e => setS({ ...s, invoice_email: e.target.value })} placeholder="ap@yourcompany.com" /></Field>
            <Toggle id="cs-wd" checked={!!s.weekly_digest} onChange={v => setS({ ...s, weekly_digest: v })} label="Weekly team summary" hint="Hours, attendance and open items every Monday" disabled={!d.can_edit_company} />
          </fieldset>
        </Card>
        <Card>
          <CardHeader title="Agreement" sub="Set by your agency" />
          <div className="card-b"><KV items={[['Timesheets approved by', humanize(d.company?.timesheet_approval)], ['Payment terms', `Net ${d.company?.payment_terms_days} days`], ['Screenshots in portal', d.company?.portal_screenshots ? 'Visible to your team' : 'Hidden'], ['Company email', d.company?.email], ['Phone', d.company?.phone], ['Address', d.company?.address]]} /></div>
        </Card>
      </div>
      <Card>
        <CardHeader title="My notifications" sub="Choose how you hear about activity. These apply only to you." right={<Button size="sm" variant="primary" loading={busy === 'n'} onClick={savePrefs}>Save preferences</Button>} />
        <div className="table-wrap"><table className="table"><thead><tr><th>Event</th><th style={{ textAlign: 'center' }}>In portal</th><th style={{ textAlign: 'center' }}>Email</th></tr></thead><tbody>
          {prefs.map((p, i) => <tr key={p.key}><td>{p.label}</td>
            <td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${p.label} in portal`} checked={p.in_app} onChange={e => setPrefs(x => x.map((y, j) => j === i ? { ...y, in_app: e.target.checked } : y))} /></td>
            <td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${p.label} by email`} checked={p.email} onChange={e => setPrefs(x => x.map((y, j) => j === i ? { ...y, email: e.target.checked } : y))} /></td></tr>)}
        </tbody></table></div>
      </Card>
    </div>
  );
}
