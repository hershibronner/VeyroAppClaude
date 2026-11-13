// Shown to members of an agency that signed up but is not approved yet (or was not approved).
// Same split "workspace builder" layout as sign-up: their workspace preview, locked, on the left.
import { useState } from 'react';
import { Check, Hourglass, MailCheck, RefreshCw, LogOut, Lock, LayoutDashboard, Briefcase, Users, Inbox, BarChart3, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BrandMark } from './Auth';
import { useInterval } from '../lib/hooks';
import { dateTime } from '../lib/format';
import { toast } from '../lib/toast';
import './signup.css';

export default function PendingApproval() {
  const { me, refresh, logout } = useAuth();
  const ws = me!.workspace!;
  const ap = (ws as any).approval ?? {};
  const rejected = ap.status === 'rejected';
  const [checking, setChecking] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(ws.branding?.logo_url ?? null);
  const [hasDoc, setHasDoc] = useState<boolean>(!!ap.has_registration);
  const brand = ws.branding?.primary_color ?? '#345CFF';
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
  const first = me!.user.name.split(' ')[0];
  return (
    <div className="wb-page">
    <div className="wb" style={{ ['--brand' as any]: brand }}>
      <aside className="wb-side">
        <i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /><i className="grain" />
        <div className="wb-side-top"><BrandMark className="wb-mark" /><b>VeyroApp</b><span className="wb-tag">{rejected ? 'Not approved' : 'Under review'}</span></div>
        <div className="wb-preview" aria-hidden style={{ position: 'relative' }}>
          <div className="wb-pv-bar"><i /><i /><i /><span>app.veyro/{ws.org.slug}</span></div>
          <div className="wb-pv-body" style={{ filter: 'blur(1.5px) saturate(.7)', opacity: .8 }}>
            <div className="wb-pv-nav">
              <div className="wb-pv-logo">{logoUrl ? <img src={logoUrl} alt="" /> : <span>{ws.org.name.slice(0, 1).toUpperCase()}</span>}<b>{ws.org.name}</b></div>
              {[[LayoutDashboard, 'Dashboard'], [Briefcase, 'Positions'], [Users, 'Candidates'], [Inbox, 'Clients'], [BarChart3, 'Reports']].map(([Ic, l]: any, i) => <div key={l} className={`wb-pv-item ${i === 0 ? 'on' : ''}`}><Ic size={12} />{l}</div>)}
            </div>
            <div className="wb-pv-main"><div className="wb-pv-hello">Good morning, {first} 👋</div><div className="wb-pv-cards"><div><small>Open positions</small><b>—</b></div><div><small>Placed VAs</small><b>—</b></div><div><small>Team</small><b>1</b></div></div><div className="wb-pv-rows">{[0, 1, 2].map(i => <div key={i}><span className="av" /><i style={{ width: `${60 - i * 12}%` }} /><em /></div>)}</div></div>
          </div>
          <div style={{ position: 'absolute', inset: '34px 0 0', display: 'grid', placeItems: 'center' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 99, background: '#0B1020', color: '#fff', fontSize: 13, fontWeight: 600, boxShadow: '0 10px 30px -10px rgba(0,0,0,.5)' }}><Lock size={14} /> {rejected ? 'Not available' : 'Unlocks after approval'}</span></div>
        </div>
        <div className="wb-side-foot"><Lock size={13} /> Every agency is reviewed by our team before going live.</div>
      </aside>
      <main className="wb-main">
        <div className="wb-top"><div className="wb-meter"><i style={{ width: rejected ? '100%' : '80%', background: rejected ? '#F04438' : undefined }} /></div></div>
        <div className="wb-stage fwd wb-pending">
          <span className="wb-kicker">{rejected ? 'Application update' : 'Application submitted'}</span>
          {rejected ? <>
            <h1>We couldn't approve {ws.org.name}</h1>
            <p className="wb-lead">{ap.rejection_reason ? <>Reason: {ap.rejection_reason}</> : 'Your application was not approved.'} If you think this is a mistake, email <a href="mailto:support@veyroapp.com">support@veyroapp.com</a>.</p>
          </> : <>
            <h1>Thanks, {first} — {ws.org.name} is in review</h1>
            <p className="wb-lead">This usually takes less than one business day. We'll email <b>{me!.user.email}</b> the moment your workspace is unlocked.</p>
            <ol className="wb-timeline">
              <li className="done"><span className="dot"><Check size={16} /></span><div><b>Application received</b><small>{ap.submitted_at ? dateTime(ap.submitted_at) : 'Just now'}</small></div></li>
              <li className="now"><span className="dot"><Hourglass size={15} /></span><div><b>VeyroApp review</b><small>We check your business details{hasDoc ? ' and registration document' : ''}</small></div></li>
              <li><span className="dot"><MailCheck size={15} /></span><div><b>Workspace unlocked</b><small>You get an email, sign in, and we help you invite your team and import your data</small></div></li>
            </ol>
            {(!logoUrl || !hasDoc) && <div className="wb-links">
              {!logoUrl && <label>+ Add your logo<input type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) upload('logo', f); e.target.value = ''; }} /></label>}
              {!hasDoc && <label>+ Add business registration (faster approval)<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={e => { const f = e.target.files?.[0]; if (f) upload('registration', f); e.target.value = ''; }} /></label>}
            </div>}
          </>}
        </div>
        <div className="wb-actions">
          <button type="button" className="wb-btn ghost" onClick={() => logout()}>{rejected ? <XCircle size={16} /> : <LogOut size={16} />} Sign out</button>
          {!rejected && <button type="button" className="wb-btn" onClick={() => check()} disabled={checking}>{checking ? <span className="spinner" /> : <RefreshCw size={16} />} Check status</button>}
        </div>
      </main>
    </div>
    </div>
  );
}
