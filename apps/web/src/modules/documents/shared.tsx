import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { humanize } from '../../lib/format';
import { Button, Dialog, Drawer, Field, StatusPill } from '../../components/ui';
import { RecordPicker, type PickedRecord } from '../home/kit';
import '../home/insights.css';

export const CATEGORIES = ['contract', 'nda', 'offer_letter', 'policy', 'id', 'compliance', 'resume', 'invoice', 'payslip', 'general'];
export const VISIBILITY = ['internal', 'client', 'worker', 'candidate'];
export const VIS_LABEL: Record<string, string> = { internal: 'Internal only', client: 'Visible to client', worker: 'Visible to worker', candidate: 'Visible to candidate' };

export function ExpiryPill({ d }: { d: { expires_at: string | null; expiry_status?: string | null } }) {
  if (!d.expires_at) return <span className="muted">—</span>;
  const s = d.expiry_status;
  return <StatusPill status={s === 'expired' ? 'expired' : s === 'expiring' ? 'pending' : 'active'} label={s === 'expired' ? 'Expired' : s === 'expiring' ? 'Expiring soon' : 'Valid'} />;
}
export const fileSize = (n: number | null | undefined) => (!n ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Upload a document and attach it to a record (agency) — also used for renewals (replacesId). */
export function UploadDrawer({ open, onClose, onDone, preset, replaces, endpoint = '/api/v1/documents', portal }: { open: boolean; onClose: () => void; onDone: (doc: any) => void; preset?: PickedRecord | null; replaces?: { id: string; name: string } | null; endpoint?: string; portal?: 'client' | 'worker' }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(portal === 'worker' ? 'id' : 'general');
  const [visibility, setVisibility] = useState('internal');
  const [record, setRecord] = useState<PickedRecord | null>(preset ?? null);
  const [issue, setIssue] = useState('');
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setFile(null); setName(replaces ? replaces.name : ''); setRecord(preset ?? null); setErrors({}); setIssue(''); setExpires(''); } }, [open]);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!file) e.file = 'Choose a file';
    if (file && file.size > 20 * 1024 * 1024) e.file = 'File is larger than 20 MB';
    setErrors(e);
    if (Object.keys(e).length) return;
    const fd = new FormData();
    if (name) fd.append('name', name);
    if (!replaces) fd.append('category', category);
    if (!portal && !replaces) fd.append('visibility', visibility);
    if (!portal && record && !replaces) { fd.append('entity_type', record.type); fd.append('entity_id', record.id); }
    if (replaces) fd.append('replaces_id', replaces.id);
    if (issue && !portal) fd.append('issue_date', issue);
    if (expires) fd.append('expires_at', expires);
    fd.append('file', file!);
    setBusy(true);
    try { const d = await api.upload(endpoint, fd); toast.success(replaces ? 'Renewed copy uploaded' : 'Document uploaded'); onDone(d); onClose(); }
    catch (err) { if (err instanceof ApiError && err.fields) setErrors(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onClose={onClose} title={replaces ? `Upload renewal: ${replaces.name}` : 'Upload document'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Upload size={15} />} loading={busy} onClick={submit}>Upload</Button></>}>
      <Field label="File *" error={errors.file} hint="PDF, image, Word, CSV or text · max 20 MB">
        <div className="row" style={{ gap: 8 }}><Button icon={<Upload size={15} />} onClick={() => input.current?.click()}>{file ? 'Change file' : 'Choose file'}</Button><span className="small truncate">{file ? `${file.name} · ${fileSize(file.size)}` : 'No file chosen'}</span></div>
        <input ref={input} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx,.csv" onChange={e => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '')); }} aria-label="File" />
      </Field>
      <div className="form-grid">
        <Field label="Name" htmlFor="up-name" full><input id="up-name" className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        {!replaces && <Field label="Category" htmlFor="up-cat"><select id="up-cat" className="select" value={category} onChange={e => setCategory(e.target.value)}>{(portal === 'worker' ? ['id', 'compliance', 'contract', 'general'] : portal === 'client' ? ['contract', 'policy', 'general'] : CATEGORIES).map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>}
        {!portal && !replaces && <Field label="Visibility" htmlFor="up-vis" error={errors.visibility}><select id="up-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value)}>{VISIBILITY.map(v => <option key={v} value={v}>{VIS_LABEL[v]}</option>)}</select></Field>}
        {!portal && !replaces && <Field label="Attach to record" full error={errors.entity_id} hint="Client, worker, candidate, position, contact or invoice"><RecordPicker value={record} onChange={setRecord} /></Field>}
        {!portal && <Field label="Issue date" htmlFor="up-iss"><input id="up-iss" type="date" className="input" value={issue} onChange={e => setIssue(e.target.value)} /></Field>}
        <Field label="Expires" htmlFor="up-exp" hint="For IDs, permits and tax forms"><input id="up-exp" type="date" className="input" value={expires} onChange={e => setExpires(e.target.value)} /></Field>
      </div>
    </Drawer>
  );
}

/** Send an existing document for e-signature. */
export function SendForSignature({ doc, open, onClose, onDone, defaultSigner }: { doc: { id: string; name: string } | null; open: boolean; onClose: () => void; onDone: () => void; defaultSigner?: { name?: string | null; email?: string | null } }) {
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(14);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setSignerName(defaultSigner?.name ?? ''); setSignerEmail(defaultSigner?.email ?? ''); setMessage(''); setErrors({}); } }, [open]);
  const submit = async () => {
    if (!doc) return;
    setBusy(true); setErrors({});
    try { await api.post('/api/v1/signatures', { document_id: doc.id, signer_name: signerName, signer_email: signerEmail, message: message || undefined, expires_in_days: days }); toast.success(`Signature request emailed to ${signerEmail} (see Dev Outbox)`); onDone(); onClose(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Send “${doc?.name ?? ''}” for signature`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Send request</Button></>}>
      <div className="form-grid">
        <Field label="Signer name *" htmlFor="sg-n" error={errors.signer_name}><input id="sg-n" className="input" value={signerName} onChange={e => setSignerName(e.target.value)} /></Field>
        <Field label="Signer email *" htmlFor="sg-e" error={errors.signer_email}><input id="sg-e" type="email" className="input" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} /></Field>
        <Field label="Message" htmlFor="sg-m" full><textarea id="sg-m" className="textarea" rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Optional note shown on the signing page" /></Field>
        <Field label="Link expires after (days)" htmlFor="sg-d"><input id="sg-d" type="number" min={1} max={90} className="input" value={days} onChange={e => setDays(Number(e.target.value))} /></Field>
      </div>
    </Dialog>
  );
}

/** Opens a permission-checked, short-lived signed URL for a document. */
export async function openDocument(url: string, download = false) {
  try { const r = await api.get<{ url: string }>(`${url}${download ? '' : '?inline=1'}`); window.open(r.url, '_blank', 'noopener'); } catch (e) { toast.error(e); }
}
