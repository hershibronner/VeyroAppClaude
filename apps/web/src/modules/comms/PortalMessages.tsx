import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Drawer, Field, PageHeader } from '../../components/ui';
import { ThreadsApp, type ThreadsConfig } from './Threads';

/** Client / worker portal messaging with the agency. */
export default function PortalMessages({ kind }: { kind: 'client' | 'worker' }) {
  const cfg = useMemo<ThreadsConfig>(() => ({ listUrl: `/api/v1/portal/${kind}/messages`, detailUrl: id => `/api/v1/portal/${kind}/messages/${id}`, postUrl: id => `/api/v1/portal/${kind}/messages/${id}`, agency: false }), [kind]);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  const [, setSp] = useSearchParams();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!subject.trim()) e.subject = 'Subject is required';
    if (!body.trim()) e.body = 'Write a message';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try { const t = await api.post<any>(`/api/v1/portal/${kind}/messages`, { subject, body }); toast.success('Message sent to your account manager'); setOpen(false); setSubject(''); setBody(''); setKey(k => k + 1); setSp(new URLSearchParams({ thread: t.id })); }
    catch (err) { if (err instanceof ApiError && err.fields) setErrors(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title="Messages" sub={kind === 'client' ? 'Talk to your account team about your staff, schedules and invoices.' : 'Talk to your account manager.'} actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>New message</Button>} />
      <ThreadsApp cfg={cfg} reloadKey={key} />
      <Drawer open={open} onClose={() => setOpen(false)} title="New message" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Send</Button></>}>
        <p className="small muted" style={{ marginTop: 0 }}>Your message goes to your account manager. You will get a notification when they reply.</p>
        <Field label="Subject *" htmlFor="pm-sub" error={errors.subject}><input id="pm-sub" className="input" value={subject} onChange={e => setSubject(e.target.value)} /></Field>
        <Field label="Message *" htmlFor="pm-body" error={errors.body}><textarea id="pm-body" className="textarea" rows={6} value={body} onChange={e => setBody(e.target.value)} /></Field>
      </Drawer>
    </div>
  );
}
