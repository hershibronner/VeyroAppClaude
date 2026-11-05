import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FileOutput, History, Archive, RotateCcw, Eye } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { dateTime, relTime, humanize } from '../../lib/format';
import { Button, Dialog, Drawer, ErrorState, Field, LoadingBlock, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { RecordPicker, type PickedRecord } from '../home/kit';
import { CATEGORIES, VISIBILITY, VIS_LABEL } from './shared';

const DOC_VARS = ['org.name', 'today', 'worker.name', 'worker.firstName', 'company.name', 'company.terms', 'placement.title', 'placement.startDate', 'candidate.name', 'position.title', 'offer.startDate', 'offer.payRate', 'party.name', 'contact.name'];

export default function DocTemplates() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const openId = sp.get('template');
  const [creating, setCreating] = useState(false);
  const [gen, setGen] = useState<any>(null);
  const [key, setKey] = useState(0);
  const setOpen = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('template', id); else n.delete('template'); setSp(n, { replace: true }); };
  const columns: Column<any>[] = [
    { key: 'name', label: 'Template', mobile: 'title', sortable: true, render: t => <div><div className="bold">{t.name}</div><div className="small muted truncate" style={{ maxWidth: 460 }}>{t.preview}</div></div> },
    { key: 'category', label: 'Category', sortable: true, render: t => <StatusPill status={t.category} label={humanize(t.category)} tone="blue" /> },
    { key: 'version', label: 'Version', render: t => `v${t.version}` },
    { key: 'sent', label: 'Sent / signed', render: t => `${t.sent} / ${t.signed}` },
    { key: 'updated_at', label: 'Updated', sortable: true, render: t => relTime(t.updated_at), csv: t => t.updated_at },
  ];
  return (
    <div>
      <PageHeader title="Document templates" sub="Contracts, NDAs, offer letters and policies with merge variables. Generate a PDF for any record and send it for e-signature."
        actions={can('documents', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New template</Button>} />
      <DataTable endpoint="/api/v1/document-templates" columns={columns} reloadKey={key} onRowClick={t => setOpen(t.id)} exportName="document-templates" exportResource="documents" defaultSort="name" defaultDir="asc"
        filters={[{ key: 'category', label: 'Category', options: opts(CATEGORIES) }, { key: 'archived', label: 'Archived', type: 'boolean' }]}
        rowActions={t => [{ label: 'Generate document', icon: <FileOutput size={15} />, onClick: () => setGen(t), hidden: !can('documents', 'create') || !!t.archived_at }, { label: 'Edit', onClick: () => setOpen(t.id) }]} />
      {(openId || creating) && <TemplateEditor id={creating ? null : openId} onClose={() => { setCreating(false); setOpen(null); }} onChanged={() => setKey(k => k + 1)} onCreated={id => { setCreating(false); setOpen(id); }} onGenerate={t => setGen(t)} />}
      {gen && <GenerateDialog tpl={gen} onClose={() => setGen(null)} onDone={() => setKey(k => k + 1)} />}
    </div>
  );
}

function TemplateEditor({ id, onClose, onChanged, onCreated, onGenerate }: { id: string | null; onClose: () => void; onChanged: () => void; onCreated: (id: string) => void; onGenerate: (t: any) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const st = useApi<any>(id ? `/api/v1/document-templates/${id}` : null);
  const t = st.data;
  const [name, setName] = useState('');
  const [category, setCategory] = useState('contract');
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const [record, setRecord] = useState<PickedRecord | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const editable = id ? can('documents', 'edit') : can('documents', 'create');
  useEffect(() => { if (t) { setName(t.name); setCategory(t.category); setBody(t.body); } }, [t?.id, t?.version]);
  const dBody = useDebounced(body, 350);
  useEffect(() => {
    if (!id || !dBody) { setPreview(null); return; }
    api.post(`/api/v1/document-templates/${id}/preview`, { body: dBody, entity_type: record?.type, entity_id: record?.id }).then(setPreview).catch(() => setPreview(null));
  }, [dBody, record?.id, id]);
  const insert = (k: string) => { const el = ref.current; const tag = `{{${k}}}`; if (!el) { setBody(b => b + tag); return; } const s = el.selectionStart, e = el.selectionEnd; setBody(b => b.slice(0, s) + tag + b.slice(e)); setTimeout(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length); }, 0); };
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      if (!id) { const r = await api.post<any>('/api/v1/document-templates', { name, category, body }); toast.success('Template created'); onChanged(); onCreated(r.id); }
      else { const r = await api.patch<any>(`/api/v1/document-templates/${id}`, { name, category, body, note: note || undefined }); toast.success(r.version !== t.version ? `Saved as version ${r.version}` : 'Saved'); setNote(''); st.reload(); onChanged(); }
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  const archive = async () => {
    if (!t.archived_at) { const c = await confirm({ title: `Archive “${t.name}”?`, body: 'Archived templates cannot be used to generate new documents. Existing documents are not affected.', confirmLabel: 'Archive' }); if (!c.ok) return; }
    try { await api.post(`/api/v1/document-templates/${id}/archive`, { archived: !t.archived_at }); toast.success(t.archived_at ? 'Template restored' : 'Template archived'); st.reload(); onChanged(); } catch (e) { toast.error(e); }
  };
  const restoreVersion = (v: any) => { setBody(v.body); setNote(`Restored from version ${v.version}`); toast.info(`Loaded version ${v.version} — save to make it current`); };
  const dirty = !id || (t && (name !== t.name || category !== t.category || body !== t.body));
  return (
    <Drawer open onClose={onClose} wide title={id ? (t?.name ?? 'Template') : 'New document template'} footer={<>
      {id && t && can('documents', 'edit') && <Button icon={t.archived_at ? <RotateCcw size={15} /> : <Archive size={15} />} onClick={archive}>{t.archived_at ? 'Unarchive' : 'Archive'}</Button>}
      {id && t && !t.archived_at && can('documents', 'create') && <Button icon={<FileOutput size={15} />} disabled={!!dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => onGenerate(t)}>Generate document</Button>}
      <Button onClick={onClose}>Close</Button>
      {editable && <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>{id ? 'Save' : 'Create template'}</Button>}
    </>}>
      {id && st.error && !t ? <ErrorState error={st.error} retry={st.reload} /> : id && !t ? <LoadingBlock rows={6} /> : (<>
        {t && <div className="small muted mb-2">Version {t.version} · updated {relTime(t.updated_at)} · <a href="#" onClick={e => { e.preventDefault(); setVersions(v => !v); }}><History size={12} style={{ verticalAlign: -1 }} /> {versions ? 'Hide' : 'Show'} versions ({t.versions.length})</a></div>}
        {versions && t && <div className="mb-3">{t.versions.map((v: any) => <div key={v.id} className="ins-rule"><div className="ins-rule-h"><b>Version {v.version}{v.version === t.version ? ' (current)' : ''}</b>{v.version !== t.version && editable && <Button size="xs" icon={<RotateCcw size={13} />} onClick={() => restoreVersion(v)}>Load</Button>}</div><div className="small muted">{dateTime(v.created_at)} · {v.created_by_name ?? 'System'}{v.note ? ` · ${v.note}` : ''}</div></div>)}</div>}
        <div className="ins-split">
          <div>
            <div className="form-grid">
              <Field label="Name *" htmlFor="dt-name" error={errors.name}><input id="dt-name" className="input" disabled={!editable} value={name} onChange={e => setName(e.target.value)} /></Field>
              <Field label="Category" htmlFor="dt-cat"><select id="dt-cat" className="select" disabled={!editable} value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
              <Field label="Body *" htmlFor="dt-body" error={errors.body} full hint="Separate paragraphs with a blank line. A line in CAPITALS becomes a heading in the PDF."><textarea id="dt-body" ref={ref} className="textarea" rows={16} disabled={!editable} value={body} onChange={e => setBody(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }} /></Field>
              {id && body !== t?.body && <Field label="Change note" htmlFor="dt-note" full><input id="dt-note" className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="What changed in this version?" /></Field>}
            </div>
            <div className="small bold mt-2 mb-2">Insert merge variable</div>
            <div className="ins-chip-row">{DOC_VARS.map(v => <button key={v} type="button" className="chip" disabled={!editable} onClick={() => insert(v)} style={{ cursor: 'pointer' }}>{`{{${v}}}`}</button>)}</div>
          </div>
          <div>
            <div className="row mb-2" style={{ justifyContent: 'space-between' }}><b><Eye size={14} style={{ verticalAlign: -2 }} /> Preview</b></div>
            {id ? <>
              <Field label="Fill with a record"><RecordPicker value={record} onChange={setRecord} types={['worker', 'company', 'candidate']} placeholder="Search a worker, client or candidate" /></Field>
              {preview ? <><div className="ins-doc">{preview.body}</div>{preview.missing.length > 0 && <div className="small mt-2" style={{ color: 'var(--warning)' }}>{record ? 'Empty for this record' : 'Pick a record to fill'}: {preview.missing.map((m: string) => `{{${m}}}`).join(', ')}</div>}</> : <div className="muted small">Preview appears here.</div>}
            </> : <div className="muted small">Create the template to preview it with real records.</div>}
          </div>
        </div>
      </>)}
    </Drawer>
  );
}

function GenerateDialog({ tpl, onClose, onDone }: { tpl: any; onClose: () => void; onDone: () => void }) {
  const nav = useNavigate();
  const [record, setRecord] = useState<PickedRecord | null>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('');
  const [send, setSend] = useState(true);
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (record) { setName(`${tpl.name} — ${record.title}`); if (!signerName) setSignerName(record.type === 'company' ? '' : record.title); } }, [record?.id]);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!record) e.record = 'Choose who this document is for';
    if (send && !signerName.trim()) e['send.signer_name'] = 'Signer name is required';
    if (send && !/^\S+@\S+\.\S+$/.test(signerEmail)) e['send.signer_email'] = 'Enter a valid email';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api.post<any>(`/api/v1/document-templates/${tpl.id}/generate`, { entity_type: record!.type, entity_id: record!.id, name: name || undefined, visibility: visibility || undefined, send: send ? { signer_name: signerName, signer_email: signerEmail, message: message || undefined } : undefined });
      toast.success(send ? 'PDF generated and sent for signature' : 'PDF generated');
      onDone(); onClose(); nav(`/documents/${r.document.id}`);
    } catch (err) { if (err instanceof ApiError && err.fields) setErrors(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} wide title={`Generate “${tpl.name}”`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<FileOutput size={15} />} loading={busy} onClick={submit}>{send ? 'Generate & send' : 'Generate PDF'}</Button></>}>
      <div className="form-grid">
        <Field label="For *" full error={errors.record}><RecordPicker value={record} onChange={setRecord} types={['worker', 'company', 'candidate']} placeholder="Search a worker, client or candidate" /></Field>
        <Field label="Document name" htmlFor="gd-name" full><input id="gd-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder={tpl.name} /></Field>
        <Field label="Visibility" htmlFor="gd-vis"><select id="gd-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value)}><option value="">Automatic (record owner)</option>{VISIBILITY.map(v => <option key={v} value={v}>{VIS_LABEL[v]}</option>)}</select></Field>
        <Field label=" "><label className="check"><input type="checkbox" checked={send} onChange={e => setSend(e.target.checked)} /> Send for e-signature now</label></Field>
        {send && <>
          <Field label="Signer name *" htmlFor="gd-sn" error={errors['send.signer_name']}><input id="gd-sn" className="input" value={signerName} onChange={e => setSignerName(e.target.value)} /></Field>
          <Field label="Signer email *" htmlFor="gd-se" error={errors['send.signer_email']}><input id="gd-se" type="email" className="input" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} /></Field>
          <Field label="Message" htmlFor="gd-m" full><input id="gd-m" className="input" value={message} onChange={e => setMessage(e.target.value)} placeholder="Optional note shown on the signing page" /></Field>
        </>}
      </div>
    </Dialog>
  );
}
