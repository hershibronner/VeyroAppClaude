import { useEffect, useState } from 'react';
import { Lock, Wallet } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { useApi } from '../../../lib/hooks';
import { useAuth } from '../../../lib/auth';
import { toast } from '../../../lib/toast';
import { date, humanize } from '../../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, Field, KV, LoadingBlock, PageHeader, PhoneInput } from '../../../components/ui';
import '../settings.css';

export default function WorkerProfile() {
  const st = useApi<any>('/api/v1/portal/worker/profile');
  const { refresh } = useAuth();
  const [p, setP] = useState<any>(null);
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [prefs, setPrefs] = useState<any[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => { if (st.data) { const w = st.data.worker; setP({ first_name: w.first_name, last_name: w.last_name ?? '', phone: w.phone ?? '', country: w.country ?? '', city: w.city ?? '', timezone: w.timezone ?? '', headline: w.headline ?? '', payout_method: w.payout_method, payout_account_label: w.payout_account_label ?? '' }); setPrefs(st.data.notifications); } }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data || !p) return <Card><LoadingBlock rows={6} /></Card>;
  const w = st.data.worker;
  const save = async (keys: string[], tag: string, msg: string) => {
    setBusy(tag); setErrors({});
    try { await api.patch('/api/v1/portal/worker/profile', Object.fromEntries(keys.map(k => [k, p[k] === '' ? null : p[k]]))); toast.success(msg); st.reload(); refresh(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(''); }
  };
  const changePw = async () => {
    if (pw.new_password !== pw.confirm) { setErrors({ confirm: 'Passwords do not match' }); return; }
    setBusy('pw'); setErrors({});
    try { await api.post('/api/v1/portal/worker/profile/password', { current_password: pw.current_password, new_password: pw.new_password }); toast.success('Password changed — other devices were signed out'); setPw({ current_password: '', new_password: '', confirm: '' }); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(''); }
  };
  return (
    <div className="stack">
      <PageHeader title="Profile" sub={st.data.placement ? `${st.data.placement.title} at ${st.data.placement.company_name} · since ${date(st.data.placement.start_date)}` : humanize(w.status)} />
      <div className="grid-2">
        <Card>
          <CardHeader title="Personal details" right={<Button size="sm" variant="primary" loading={busy === 'p'} onClick={() => save(['first_name', 'last_name', 'phone', 'country', 'city', 'timezone', 'headline'], 'p', 'Profile saved')}>Save</Button>} />
          <div className="card-b form-grid">
            <Field label="First name" htmlFor="wp-f" error={errors.first_name}><input id="wp-f" className="input" value={p.first_name} onChange={e => setP({ ...p, first_name: e.target.value })} /></Field>
            <Field label="Last name" htmlFor="wp-l" error={errors.last_name}><input id="wp-l" className="input" value={p.last_name} onChange={e => setP({ ...p, last_name: e.target.value })} /></Field>
            <Field label="Email" hint="Contact your agency to change your sign-in email"><input className="input" value={w.email ?? st.data.user?.email ?? ''} disabled /></Field>
            <Field label="Phone" error={errors.phone}><PhoneInput value={p.phone} onChange={v => setP({ ...p, phone: v })} /></Field>
            <Field label="Country" htmlFor="wp-c"><input id="wp-c" className="input" value={p.country} onChange={e => setP({ ...p, country: e.target.value })} /></Field>
            <Field label="City" htmlFor="wp-ci"><input id="wp-ci" className="input" value={p.city} onChange={e => setP({ ...p, city: e.target.value })} /></Field>
            <Field label="Time zone" htmlFor="wp-tz"><input id="wp-tz" className="input" value={p.timezone} onChange={e => setP({ ...p, timezone: e.target.value })} placeholder="Asia/Manila" /></Field>
            <Field label="Headline" htmlFor="wp-h"><input id="wp-h" className="input" value={p.headline} onChange={e => setP({ ...p, headline: e.target.value })} placeholder="e.g. Dental office assistant" /></Field>
          </div>
        </Card>
        <div className="stack">
          <Card>
            <CardHeader title={<span className="row" style={{ gap: 8 }}><Wallet size={16} /> Payout details</span>} right={<Button size="sm" variant="primary" loading={busy === 'pay'} onClick={() => save(['payout_method', 'payout_account_label'], 'pay', 'Payout details saved — Finance has been notified')}>Save</Button>} />
            <div className="card-b stack" style={{ gap: 12 }}>
              <Banner icon={<Lock size={18} />}>For your security we only store a <b>label</b> for your payout account (for example “Wise •••• 4821”). Never enter full account or card numbers here.</Banner>
              <div className="form-grid">
                <Field label="Payout method" htmlFor="wp-pm"><select id="wp-pm" className="select" value={p.payout_method} onChange={e => setP({ ...p, payout_method: e.target.value })}><option value="wise">Wise</option><option value="bank">Bank transfer</option><option value="paypal">PayPal</option><option value="payoneer">Payoneer</option></select></Field>
                <Field label="Account label" htmlFor="wp-pl" error={errors.payout_account_label}><input id="wp-pl" className="input" value={p.payout_account_label} onChange={e => setP({ ...p, payout_account_label: e.target.value })} placeholder="Wise •••• 4821" /></Field>
              </div>
              <KV items={[['Employee code', w.employee_code ?? '—'], ['Status', humanize(w.status)]]} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Password" />
            <div className="card-b form-grid">
              <Field label="Current password" htmlFor="wp-cp" error={errors.current_password} full><input id="wp-cp" type="password" autoComplete="current-password" className="input" value={pw.current_password} onChange={e => setPw({ ...pw, current_password: e.target.value })} /></Field>
              <Field label="New password" htmlFor="wp-np" error={errors.new_password} hint="At least 8 characters"><input id="wp-np" type="password" autoComplete="new-password" className="input" value={pw.new_password} onChange={e => setPw({ ...pw, new_password: e.target.value })} /></Field>
              <Field label="Confirm new password" htmlFor="wp-cf" error={errors.confirm}><input id="wp-cf" type="password" autoComplete="new-password" className="input" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} /></Field>
              <div><Button loading={busy === 'pw'} disabled={!pw.current_password || pw.new_password.length < 8} onClick={changePw}>Change password</Button></div>
            </div>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader title="Notifications" right={<Button size="sm" loading={busy === 'n'} onClick={async () => { setBusy('n'); try { await api.put('/api/v1/portal/worker/profile/notifications', { prefs }); toast.success('Preferences saved'); } catch (e) { toast.error(e); } finally { setBusy(''); } }}>Save preferences</Button>} />
        <div className="table-wrap"><table className="table"><thead><tr><th>Event</th><th style={{ textAlign: 'center' }}>In portal</th><th style={{ textAlign: 'center' }}>Email</th></tr></thead><tbody>
          {prefs.map((x, i) => <tr key={x.key}><td>{x.label}</td><td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${x.label} in portal`} checked={x.in_app} onChange={e => setPrefs(a => a.map((y, j) => j === i ? { ...y, in_app: e.target.checked } : y))} /></td><td style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${x.label} by email`} checked={x.email} onChange={e => setPrefs(a => a.map((y, j) => j === i ? { ...y, email: e.target.checked } : y))} /></td></tr>)}
        </tbody></table></div>
      </Card>
    </div>
  );
}
