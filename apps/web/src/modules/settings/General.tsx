import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Globe, Image as ImageIcon, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { dateTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Field, LoadingBlock, ErrorState, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { Gate, ReadOnlyNote, Toggle, CopyField } from './common';

const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'Europe/London', 'Europe/Madrid', 'Africa/Johannesburg', 'Africa/Nairobi', 'Asia/Manila', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'];
const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'PHP', 'MXN', 'ZAR'];
const TERMS: { key: string; label: string; placeholder: string }[] = [
  { key: 'worker', label: 'Worker', placeholder: 'e.g. Associate, VA, Talent' }, { key: 'client', label: 'Client', placeholder: 'e.g. Customer, Partner' },
  { key: 'placement', label: 'Placement', placeholder: 'e.g. Assignment, Engagement' }, { key: 'candidate', label: 'Candidate', placeholder: 'e.g. Applicant' }, { key: 'position', label: 'Position', placeholder: 'e.g. Job, Role, Requisition' },
];

export default function GeneralSettings() {
  return <div className="stack"><PageHeader title="General & Branding" sub="Your agency's name, regional defaults and how your workspace, portals and emails look." /><Gate resource="settings">{editable => <Inner editable={editable} />}</Gate></div>;
}

function Inner({ editable }: { editable: boolean }) {
  const st = useApi<any>('/api/v1/settings/general');
  const { refresh } = useAuth();
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  useEffect(() => { if (st.data) setD({ name: st.data.org.name, timezone: st.data.org.timezone, default_currency: st.data.org.default_currency, logo_text: st.data.branding?.logo_text ?? '', primary_color: st.data.branding?.primary_color ?? '#345CFF', accent_color: st.data.branding?.accent_color ?? '#7044FF', email_sender_name: st.data.branding?.email_sender_name ?? '', terminology: st.data.branding?.terminology ?? {} }); }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data || !d) return <Card><LoadingBlock rows={8} /></Card>;
  const b = st.data.branding ?? {};
  const set = (p: any) => setD((x: any) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      await api.patch('/api/v1/settings/general', { ...d, logo_text: d.logo_text || null, email_sender_name: d.email_sender_name || null, terminology: Object.fromEntries(Object.entries(d.terminology).filter(([, v]) => v)) });
      toast.success('Branding saved — the new look is live for everyone in this workspace'); await refresh(); st.reload();
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try { await api.upload('/api/v1/settings/branding/logo', fd); toast.success('Logo uploaded'); await refresh(); st.reload(); } catch (e) { toast.error(e); }
  };
  const initials = (d.logo_text || d.name).split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <ReadOnlyNote show={!editable} />
      <div className="grid-main-side">
        <div className="stack">
          <Card>
            <CardHeader title="Agency profile" sub={`Workspace URL slug: ${st.data.org.slug} · created ${dateTime(st.data.org.created_at)}`} right={editable && <Button variant="primary" size="sm" loading={busy} onClick={save}>Save changes</Button>} />
            <fieldset className="card-b st-fieldset" disabled={!editable}>
              <div className="form-grid">
                <Field label="Agency name" htmlFor="g-name" error={errors.name}><input id="g-name" className="input" value={d.name} onChange={e => set({ name: e.target.value })} /></Field>
                <Field label="Email sender name" htmlFor="g-sender" hint="Shown as the From name on invitations, invoices and reminders" error={errors.email_sender_name}><input id="g-sender" className="input" value={d.email_sender_name} placeholder={d.name} onChange={e => set({ email_sender_name: e.target.value })} /></Field>
                <Field label="Default time zone" htmlFor="g-tz" error={errors.timezone}><select id="g-tz" className="select" value={d.timezone} onChange={e => set({ timezone: e.target.value })}>{[...new Set([d.timezone, ...TZS])].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>
                <Field label="Default currency" htmlFor="g-cur" hint="Used for new rates, invoices and reports"><select id="g-cur" className="select" value={d.default_currency} onChange={e => set({ default_currency: e.target.value })}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></Field>
              </div>
            </fieldset>
          </Card>
          <Card>
            <CardHeader title="Logo & colors" sub="Applies to your sidebar, client/worker/candidate portals, the public application page and emails." right={editable && <Button variant="primary" size="sm" loading={busy} onClick={save}>Save changes</Button>} />
            <fieldset className="card-b st-fieldset stack" style={{ gap: 18 }} disabled={!editable}>
              <div className="row" style={{ gap: 16 }}>
                <span className="st-logo" style={{ width: 64, height: 64, borderRadius: 14, background: d.primary_color, fontSize: 20 }}>{b.logo_url ? <img src={b.logo_url} alt="Current logo" /> : initials}</span>
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.svg,.webp" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
                    <Button size="sm" icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>{b.logo_url ? 'Replace logo' : 'Upload logo'}</Button>
                    {b.logo_url && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={async () => { const r = await confirm({ title: 'Remove logo?', body: 'Your initials will be shown instead.', danger: true, confirmLabel: 'Remove' }); if (!r.ok) return; try { await api.del('/api/v1/settings/branding/logo'); await refresh(); st.reload(); toast.success('Logo removed'); } catch (e) { toast.error(e); } }}>Remove</Button>}
                  </div>
                  <span className="small muted">PNG, JPG, SVG or WebP, square, up to 2 MB.</span>
                </div>
              </div>
              <div className="form-grid">
                <Field label="Logo text" htmlFor="g-lt" hint="Shown next to the logo and used for initials"><input id="g-lt" className="input" value={d.logo_text} placeholder={d.name} onChange={e => set({ logo_text: e.target.value })} /></Field>
                <div />
                <ColorField id="g-pc" label="Primary color" value={d.primary_color} onChange={v => set({ primary_color: v })} error={errors.primary_color} />
                <ColorField id="g-ac" label="Accent color" value={d.accent_color} onChange={v => set({ accent_color: v })} error={errors.accent_color} />
              </div>
            </fieldset>
          </Card>
          <Card>
            <CardHeader title="Terminology" sub="Rename core objects to match how your agency talks. Leave blank to use the defaults." right={editable && <Button variant="primary" size="sm" loading={busy} onClick={save}>Save changes</Button>} />
            <fieldset className="card-b st-fieldset" disabled={!editable}><div className="form-grid">
              {TERMS.map(t => <Field key={t.key} label={`"${t.label}" is called`} htmlFor={`term-${t.key}`}><input id={`term-${t.key}`} className="input" value={d.terminology[t.key] ?? ''} placeholder={t.placeholder} onChange={e => set({ terminology: { ...d.terminology, [t.key]: e.target.value } })} /></Field>)}
            </div></fieldset>
          </Card>
          <WhiteLabel data={st.data} editable={editable} reload={() => { st.reload(); refresh(); }} />
        </div>
        <Card>
          <CardHeader title="Live preview" sub="Client portal header" />
          <div className="card-b">
            <div className="st-preview">
              <div className="bar"><span className="st-logo" style={{ background: d.primary_color }}>{b.logo_url ? <img src={b.logo_url} alt="" /> : initials}</span><b>{d.logo_text || d.name}</b><span style={{ marginLeft: 'auto' }} className="small muted">Dana Fox</span></div>
              <div className="body">
                <div className="small muted">My {d.terminology.worker || 'Worker'}s</div>
                <div className="row" style={{ gap: 8 }}><span className="pill" style={{ background: d.primary_color, color: '#fff' }}>Approve timesheet</span><span className="pill" style={{ border: `1px solid ${d.accent_color}`, color: d.accent_color }}>Request a {d.terminology.worker || 'Worker'}</span></div>
                <div className="small" style={{ color: 'var(--muted)' }}>Emails come from <b>{d.email_sender_name || d.name}</b></div>
                {!b.hide_powered_by && <div className="tiny muted" style={{ textAlign: 'center' }}>Powered by VeyroApp</div>}
              </div>
            </div>
            <p className="small muted mt-2">The VeyroApp platform brand (login page, Platform Control Center) is never changed by tenant branding.</p>
          </div>
        </Card>
      </div>
    </>
  );
}

function ColorField({ id, label, value, onChange, error }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label={label} htmlFor={id} error={error}>
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input type="color" className="st-swatch" aria-label={`${label} picker`} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#345CFF'} onChange={e => onChange(e.target.value.toUpperCase())} />
        <input id={id} className="input mono" value={value} onChange={e => onChange(e.target.value)} maxLength={7} />
      </div>
    </Field>
  );
}

function WhiteLabel({ data, editable, reload }: { data: any; editable: boolean; reload: () => void }) {
  const b = data.branding ?? {};
  const [w, setW] = useState({ custom_domain: b.custom_domain ?? '', hide_powered_by: !!b.hide_powered_by, support_email: b.support_email ?? '', support_phone: b.support_phone ?? '', login_headline: b.login_headline ?? '' });
  const [busy, setBusy] = useState(''); const [errors, setErrors] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<{ verified: boolean; message: string } | null>(null);
  useEffect(() => { setW({ custom_domain: b.custom_domain ?? '', hide_powered_by: !!b.hide_powered_by, support_email: b.support_email ?? '', support_phone: b.support_phone ?? '', login_headline: b.login_headline ?? '' }); }, [b.custom_domain, b.hide_powered_by, b.support_email, b.support_phone, b.login_headline]);
  if (!data.white_label_allowed) return (
    <Card>
      <CardHeader title={<span className="row" style={{ gap: 8 }}><Crown size={18} color="var(--primary)" /> White label</span>} sub="Your own domain, branded login and portals, branded emails and no “Powered by VeyroApp”." />
      <div className="card-b row" style={{ justifyContent: 'space-between' }}>
        <div className="small muted">You are on the <b>{data.plan?.plan_name ?? 'current'}</b> plan. White label is included in the White Label plan.</div>
        <Link to="/settings/billing?upgrade=white_label" className="btn btn-primary btn-sm">See White Label plan</Link>
      </div>
    </Card>
  );
  const save = async () => {
    setBusy('save'); setErrors({});
    try { await api.patch('/api/v1/settings/white-label', { custom_domain: w.custom_domain.trim() || null, hide_powered_by: w.hide_powered_by, support_email: w.support_email || null, support_phone: w.support_phone || null, login_headline: w.login_headline || null }); toast.success('White label settings saved'); setCheck(null); reload(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(''); }
  };
  const verify = async () => { setBusy('verify'); try { const r = await api.post('/api/v1/settings/white-label/verify-domain'); setCheck(r); if (r.verified) { toast.success(r.message); reload(); } } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <Card>
      <CardHeader title={<span className="row" style={{ gap: 8 }}><Crown size={18} color="var(--primary)" /> White label</span>} sub="Included in your plan." right={editable && <Button variant="primary" size="sm" loading={busy === 'save'} onClick={save}>Save changes</Button>} />
      <fieldset className="card-b st-fieldset stack" style={{ gap: 16 }} disabled={!editable}>
        <div className="form-grid">
          <Field label="Custom portal domain" htmlFor="wl-domain" error={errors.custom_domain} hint="Clients and workers sign in at this address"><input id="wl-domain" className="input" placeholder="portal.youragency.com" value={w.custom_domain} onChange={e => setW({ ...w, custom_domain: e.target.value })} /></Field>
          <Field label="Domain status">
            <div className="row" style={{ gap: 8, minHeight: 40 }}>
              {!b.custom_domain ? <span className="muted small">No domain saved</span> : b.domain_verified ? <StatusPill status="verified" label="Verified" /> : <StatusPill status="pending" label="Waiting for DNS" />}
              {b.custom_domain && !b.domain_verified && editable && <Button size="sm" icon={<RefreshCw size={14} />} loading={busy === 'verify'} onClick={verify}>Check DNS</Button>}
            </div>
          </Field>
        </div>
        {b.custom_domain && !b.domain_verified && b.domain_token && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="small">Add this DNS TXT record at your domain provider, then click <b>Check DNS</b>:</div>
            <div className="form-grid"><Field label="Host"><CopyField value={`_veyro.${b.custom_domain}`} label="TXT host" /></Field><Field label="Value"><CopyField value={b.domain_token} label="TXT value" /></Field></div>
            {check && !check.verified && <Banner tone="warn" icon={<Globe size={18} />}>{check.message}</Banner>}
          </div>
        )}
        {b.domain_verified && <Banner tone="success" icon={<ShieldCheck size={18} />}>{b.custom_domain} is verified{b.domain_checked_at ? ` (checked ${dateTime(b.domain_checked_at)})` : ''}. Portal links in emails use this domain.</Banner>}
        <Toggle checked={w.hide_powered_by} onChange={v => setW({ ...w, hide_powered_by: v })} label='Hide "Powered by VeyroApp"' hint="Removes the footer from portals, the application page and emails" disabled={!editable} />
        <div className="form-grid">
          <Field label="Support email" htmlFor="wl-se" error={errors.support_email} hint="Shown in portals and email footers"><input id="wl-se" className="input" type="email" value={w.support_email} onChange={e => setW({ ...w, support_email: e.target.value })} placeholder="help@youragency.com" /></Field>
          <Field label="Support phone" htmlFor="wl-sp" error={errors.support_phone}><input id="wl-sp" className="input" value={w.support_phone} onChange={e => setW({ ...w, support_phone: e.target.value })} placeholder="+1 555 0100" /></Field>
          <Field label="Portal sign-in headline" htmlFor="wl-h" full hint="Shown above the sign-in form on your branded portal"><input id="wl-h" className="input" value={w.login_headline} onChange={e => setW({ ...w, login_headline: e.target.value })} placeholder="Welcome to your team portal" /></Field>
        </div>
        <div className="small muted row" style={{ gap: 6 }}><ImageIcon size={14} /> Logo and colors above are used on the branded login, portals and emails.</div>
      </fieldset>
    </Card>
  );
}
