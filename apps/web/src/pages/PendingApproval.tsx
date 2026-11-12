// Shown to members of an agency that signed up but is not approved yet (or was not approved).
import { useState, type CSSProperties } from 'react';
import { Check, Hourglass, MailCheck, RefreshCw, LogOut, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useInterval } from '../lib/hooks';
import { dateTime } from '../lib/format';
import { toast } from '../lib/toast';
import '../components/flow.css';
import './signup.css';

export default function PendingApproval() {
  const { me, refresh, logout } = useAuth();
  const ws = me!.workspace!;
  const ap = (ws as any).approval ?? {};
  const rejected = ap.status === 'rejected';
  const [checking, setChecking] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(ws.branding?.logo_url ?? null);
  const [hasDoc, setHasDoc] = useState<boolean>(!!ap.has_registration);
  const check = async (quiet = false) => {
    setChecking(true);
    try { const m = await refresh(); if (!quiet && (m?.workspace as any)?.approval?.status === 'pending') toast.info('Still under review — we will email you the moment it is approved.'); }
    finally { setChecking(false); }
  };
  useInterval(() => { check(true); }, 30_000);
  const upload = async (field: 'logo' | 'registration', f: File) => {
    const fd = new FormData(); fd.append(field, f, f.name);
    try { const r = await api.upload('/api/v1/onboarding/application/files', fd); if (r.logo_url) setLogoUrl(r.logo_url); if (r.registration_file_name) setHasDoc(true); toast.success(field === 'logo' ? 'Logo uploaded' : 'Document uploaded — thank you'); }
    catch (e) { toast.error(e); }
  };
  const vars = { '--fa': '#345CFF', '--fb': '#7044FF' } as CSSProperties;
  return (
    <div className="flow" style={vars}>
      <div className="flow-bg" aria-hidden><i /><i /><i /></div>
      <header className="flow-top"><span className="flow-brand"><span className="flow-logo">V</span><b>VeyroApp</b></span></header>
      <div className="pending-wrap">
        <div className="pending-card">
          <div className="pending-logo">{logoUrl ? <img src={logoUrl} alt="" /> : ws.org.name.slice(0, 1).toUpperCase()}</div>
          {rejected ? <>
            <h1>We couldn't approve {ws.org.name}</h1>
            <p>{ap.rejection_reason ? <>Reason: {ap.rejection_reason}</> : 'Your application was not approved.'} If you think this is a mistake, email <a href="mailto:support@veyroapp.com">support@veyroapp.com</a>.</p>
          </> : <>
            <h1>Thanks, {me!.user.name.split(' ')[0]}! You're on the list.</h1>
            <p>Our team is reviewing <b>{ws.org.name}</b>. This usually takes less than one business day — we'll email <b>{me!.user.email}</b> as soon as your account is active.</p>
            <ol className="pending-steps">
              <li className="done" style={{ ['--d' as any]: '200ms' }}><span className="dot"><Check size={18} /></span><div><b>Application received</b><small>{ap.submitted_at ? dateTime(ap.submitted_at) : 'Just now'}</small></div></li>
              <li className="now" style={{ ['--d' as any]: '320ms' }}><span className="dot"><Hourglass size={17} /></span><div><b>VeyroApp review</b><small>We check your business details{hasDoc ? ' and registration document' : ''}</small></div></li>
              <li style={{ ['--d' as any]: '440ms' }}><span className="dot"><MailCheck size={17} /></span><div><b>You're in</b><small>You get an email, sign in, and a short checklist helps you invite your team and import your data</small></div></li>
            </ol>
            {(!logoUrl || !hasDoc) && <div className="pending-files">
              {!logoUrl && <label>+ Add your logo<input type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) upload('logo', f); e.target.value = ''; }} /></label>}
              {!hasDoc && <label>+ Add business registration (faster approval)<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={e => { const f = e.target.files?.[0]; if (f) upload('registration', f); e.target.value = ''; }} /></label>}
            </div>}
          </>}
          <div className="pending-actions">
            {!rejected && <button type="button" className="primary" onClick={() => check()} disabled={checking}>{checking ? <span className="spinner" /> : <RefreshCw size={16} />} Check status</button>}
            <button type="button" onClick={() => logout()}>{rejected ? <XCircle size={16} /> : <LogOut size={16} />} Sign out</button>
          </div>
        </div>
      </div>
    </div>
  );
}
