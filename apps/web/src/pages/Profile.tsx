import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { relTime } from '../lib/format';
import { toast } from '../lib/toast';
import { Button, Card, CardHeader, Field, PageHeader, PhoneInput, StatusPill } from '../components/ui';

/** My Profile (avatar menu): name, phone, password, MFA, sessions, personal recruiter link. */
export default function ProfilePage() {
  const { me, refresh } = useAuth();
  const sessions = useApi<any[]>('/api/v1/auth/sessions');
  const [name, setName] = useState(me!.user.name);
  const [phone, setPhone] = useState(me!.user.phone ?? '');
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const [busy, setBusy] = useState('');
  const save = async (body: any, what: string) => { setBusy(what); try { await api.patch('/api/v1/me/profile', body); await refresh(); toast.success('Saved'); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const link = me!.workspace?.personalLinkToken ? `${window.location.origin}/apply/${me!.workspace.org.slug}/r/${me!.workspace.personalLinkToken}` : null;
  return (
    <div className="stack">
      <PageHeader title="My Profile" sub="Personal settings follow you across every agency you belong to." />
      <div className="grid-2">
        <Card><CardHeader title="Personal details" /><div className="card-b stack" style={{ gap: 14 }}>
          <Field label="Name" htmlFor="pn"><input id="pn" className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Email"><input className="input" value={me!.user.email} disabled /></Field>
          <Field label="Phone"><PhoneInput value={phone} onChange={setPhone} /></Field>
          <div><Button variant="primary" loading={busy === 'p'} onClick={() => save({ name, phone: phone || null }, 'p')}>Save details</Button></div>
        </div></Card>
        <Card><CardHeader title="Security" /><div className="card-b stack" style={{ gap: 14 }}>
          <Field label="Current password" htmlFor="cp"><input id="cp" className="input" type="password" value={cur} onChange={e => setCur(e.target.value)} /></Field>
          <Field label="New password (8+ characters)" htmlFor="np"><input id="np" className="input" type="password" value={next} onChange={e => setNext(e.target.value)} /></Field>
          <div><Button loading={busy === 'pw'} disabled={!cur || next.length < 8} onClick={async () => { await save({ currentPassword: cur, newPassword: next }, 'pw'); setCur(''); setNext(''); }}>Change password</Button></div>
          <div className="divider" />
          <div className="row" style={{ justifyContent: 'space-between' }}><div><b>Two-step sign-in (email code)</b><div className="small muted">Codes are delivered to the Dev Outbox in this local build.</div></div><Button loading={busy === 'mfa'} onClick={() => save({ mfaEnabled: !me!.user.mfa_enabled }, 'mfa')}>{me!.user.mfa_enabled ? 'Turn off' : 'Turn on'}</Button></div>
        </div></Card>
      </div>
      {link && <Card><CardHeader title="My recruiter link" sub="Candidates who apply through this link are attributed to you." /><div className="card-b row"><input className="input" readOnly value={link} style={{ flex: 1 }} /><Button onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copied'); }}>Copy</Button><img alt="QR code for my recruiter link" width={88} height={88} src={`/api/v1/qr?text=${encodeURIComponent(link)}`} /></div></Card>}
      <Card><CardHeader title="Active sessions" right={<Button size="sm" onClick={async () => { const r = await api.post('/api/v1/auth/sessions/revoke-others'); toast.success(`Signed out ${r.revoked} other session(s)`); sessions.reload(); }}>Sign out other sessions</Button>} />
        <div className="card-b">{(sessions.data ?? []).map(s => <div key={s.id} className="checklist-item"><div style={{ flex: 1 }}><b className="small">{s.user_agent?.split(' ').slice(-1)[0] || 'Browser'}</b><div className="small muted">{s.ip} · last active {relTime(s.last_seen_at)}</div></div>{s.current && <StatusPill status="active" label="This device" />}</div>)}</div>
      </Card>
    </div>
  );
}
