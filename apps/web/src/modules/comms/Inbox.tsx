import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Mail } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Drawer, Field, PageHeader, Segmented, useMembers } from '../../components/ui';
import { ThreadsApp, type ThreadsConfig } from './Threads';

const CFG: ThreadsConfig = {
  listUrl: '/api/v1/threads', detailUrl: id => `/api/v1/threads/${id}`, postUrl: id => `/api/v1/threads/${id}/messages`, agency: true,
  kinds: [{ key: 'internal', label: 'Internal' }, { key: 'client', label: 'Clients' }, { key: 'worker', label: 'Workers' }, { key: 'candidate', label: 'Candidates' }],
};

export default function Inbox() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <div>
      <PageHeader title="Inbox" sub="Internal conversations and threads with clients, workers and candidates. Email / SMS / WhatsApp copies go to the Dev Outbox and the record timeline."
        actions={<>
          <Button icon={<Mail size={16} />} onClick={() => nav('/comms/templates')}>Templates</Button>
          {can('messages', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>New conversation</Button>}
        </>} />
      <ThreadsApp cfg={CFG} reloadKey={key} />
      {open && <NewThread onClose={() => setOpen(false)} onCreated={() => setKey(k => k + 1)} />}
    </div>
  );
}

function NewThread({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { me, can } = useAuth();
  const [, setSp] = useSearchParams();
  const members = useMembers();
  const [kind, setKind] = useState<'internal' | 'client' | 'worker' | 'candidate'>('internal');
  const [people, setPeople] = useState<string[]>([]);
  const [party, setParty] = useState<any>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const recips = useApi<any[]>(kind !== 'internal' ? `/api/v1/threads/recipients?kind=${kind}&search=${encodeURIComponent(dq)}` : null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState('in_app');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const kinds = [{ key: 'internal', label: 'Team' }, ...(can('clients') ? [{ key: 'client', label: 'Client' }] : []), ...(can('workers') ? [{ key: 'worker', label: 'Worker' }] : []), ...(can('candidates') ? [{ key: 'candidate', label: 'Candidate' }] : [])];
  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!subject.trim()) errs.subject = 'Subject is required';
    if (!body.trim()) errs.body = 'Write a message';
    if (kind === 'internal' && !people.length) errs.people = 'Choose at least one teammate';
    if (kind !== 'internal' && !party) errs.party = `Choose a ${kind}`;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const t = await api.post<any>('/api/v1/threads', { subject, body, kind, participant_ids: people, party_id: party?.id, channel });
      toast.success(t.delivered_via !== 'in_app' ? `Conversation started — also sent by ${t.delivered_via}${t.portal_recipients ? '' : ' (no portal access yet)'}` : 'Conversation started');
      onCreated(); onClose(); setSp(new URLSearchParams({ thread: t.id }));
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Drawer open onClose={onClose} title="New conversation" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Send</Button></>}>
      <Field label="With"><Segmented options={kinds as any} value={kind} onChange={k => { setKind(k as any); setParty(null); setQ(''); }} /></Field>
      {kind === 'internal' ? (
        <Field label="Teammates *" error={errors.people}>
          <div className="stack" style={{ gap: 4, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
            {(members.data ?? []).filter(m => m.id !== me?.user.id).map(m => <label key={m.id} className="check"><input type="checkbox" checked={people.includes(m.id)} onChange={e => setPeople(p => (e.target.checked ? [...p, m.id] : p.filter(x => x !== m.id)))} /> {m.name} <span className="muted small">— {m.role_name}</span></label>)}
          </div>
        </Field>
      ) : (
        <Field label={`${kind === 'client' ? 'Client' : kind === 'worker' ? 'Worker' : 'Candidate'} *`} error={errors.party} htmlFor="nt-party">
          {party ? <div className="row" style={{ gap: 8 }}><span className="chip"><b>{party.name}</b>{party.sub ? <span className="muted small">&nbsp;· {party.sub}</span> : null}</span><Button size="xs" variant="ghost" onClick={() => setParty(null)}>Change</Button></div> : <>
            <input id="nt-party" className="input" placeholder={`Search ${kind}s`} value={q} onChange={e => setQ(e.target.value)} />
            <div className="stack mt-1" style={{ gap: 2, maxHeight: 220, overflowY: 'auto' }}>{(recips.data ?? []).map(r => <button key={r.id} type="button" className="ins-item" style={{ border: 'none', background: 'none', textAlign: 'left', width: '100%', cursor: 'pointer' }} onClick={() => setParty(r)}><div style={{ flex: 1, minWidth: 0 }}><div className="t">{r.name}</div><div className="s">{r.sub ?? '—'} · {r.portal_users ? 'has portal access' : 'no portal access — will be emailed'}</div></div></button>)}</div>
          </>}
          {party && !party.portal_users && <div className="hint">No portal access yet — the message will be delivered by email (Dev Outbox) and logged on their timeline.</div>}
        </Field>
      )}
      <Field label="Subject *" htmlFor="nt-sub" error={errors.subject}><input id="nt-sub" className="input" value={subject} onChange={e => setSubject(e.target.value)} /></Field>
      <Field label="Message *" htmlFor="nt-body" error={errors.body}><textarea id="nt-body" className="textarea" rows={5} value={body} onChange={e => setBody(e.target.value)} /></Field>
      {kind !== 'internal' && <Field label="Also send via" htmlFor="nt-ch"><select id="nt-ch" className="select" value={channel} onChange={e => setChannel(e.target.value)}><option value="in_app">In-app only</option><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></Field>}
    </Drawer>
  );
}
