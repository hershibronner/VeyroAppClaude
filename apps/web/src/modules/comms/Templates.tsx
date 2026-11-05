import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Send, Archive, RotateCcw, History, Eye } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { dateTime, relTime, humanize } from '../../lib/format';
import { Button, Drawer, Field, LoadingBlock, PageHeader, StatusPill, useConfirm, Banner, ErrorState } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { RecordPicker, type PickedRecord } from '../home/kit';

const CHANNELS = ['email', 'sms', 'whatsapp', 'offer', 'onboarding'];

export default function Templates() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const openId = sp.get('template');
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState(0);
  const setOpen = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('template', id); else n.delete('template'); setSp(n, { replace: true }); };
  const columns: Column<any>[] = [
    { key: 'name', label: 'Template', mobile: 'title', sortable: true, render: t => <div><div className="bold">{t.name}</div><div className="small muted">{t.key}</div></div> },
    { key: 'channel', label: 'Channel', sortable: true, render: t => <StatusPill status={t.channel} label={humanize(t.channel)} tone="blue" /> },
    { key: 'subject', label: 'Subject / preview', render: t => <span className="small muted" style={{ display: 'inline-block', maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || t.preview}</span>, csv: t => t.subject },
    { key: 'current_version', label: 'Version', render: t => `v${t.current_version} of ${t.versions}` },
    { key: 'updated_at', label: 'Updated', sortable: true, render: t => <span title={dateTime(t.updated_at)}>{relTime(t.version_at ?? t.updated_at)}{t.version_by ? ` · ${t.version_by}` : ''}</span>, csv: t => t.updated_at },
  ];
  return (
    <div>
      <PageHeader title="Templates" sub="Email, SMS, WhatsApp, offer and onboarding messages with merge variables. Every save creates a new version."
        actions={can('templates', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New template</Button>} />
      <DataTable endpoint="/api/v1/templates" columns={columns} reloadKey={key} onRowClick={t => setOpen(t.id)} exportName="templates" exportResource="templates"
        filters={[{ key: 'channel', label: 'Channel', options: opts(CHANNELS) }, { key: 'archived', label: 'Archived', type: 'boolean' }]} defaultSort="name" defaultDir="asc" />
      {openId && <Editor id={openId} onClose={() => setOpen(null)} onChanged={() => setKey(k => k + 1)} />}
      {creating && <Editor id={null} onClose={() => setCreating(false)} onChanged={() => setKey(k => k + 1)} onCreated={id => { setCreating(false); setOpen(id); }} />}
    </div>
  );
}

function Editor({ id, onClose, onChanged, onCreated }: { id: string | null; onClose: () => void; onChanged: () => void; onCreated?: (id: string) => void }) {
  const { can, me } = useAuth();
  const confirm = useConfirm();
  const st = useApi<any>(id ? `/api/v1/templates/${id}` : null);
  const vars = useApi<{ key: string; label: string; sample: string }[]>('/api/v1/templates/variables');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [record, setRecord] = useState<PickedRecord | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const t = st.data;
  const editable = id ? can('templates', 'edit') : can('templates', 'create');
  useEffect(() => { if (t) { setName(t.name); setChannel(t.channel); setSubject(t.current?.subject ?? ''); setBody(t.current?.body ?? ''); } }, [t?.id, t?.current_version]);
  const dBody = useDebounced(body, 300), dSubject = useDebounced(subject, 300);
  useEffect(() => {
    if (!dBody) { setPreview(null); return; }
    api.post('/api/v1/templates/preview', { subject: dSubject, body: dBody, entity_type: record?.type, entity_id: record?.id }).then(setPreview).catch(() => {});
  }, [dBody, dSubject, record?.id]);
  const insert = (k: string) => {
    const el = bodyRef.current; const tag = `{{${k}}}`;
    if (!el) { setBody(b => b + tag); return; }
    const s = el.selectionStart, e = el.selectionEnd;
    setBody(b => b.slice(0, s) + tag + b.slice(e));
    setTimeout(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length); }, 0);
  };
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      if (!id) { const r = await api.post<any>('/api/v1/templates', { name, channel, subject: subject || null, body }); toast.success('Template created'); onChanged(); onCreated?.(r.id); }
      else {
        if (name !== t.name || channel !== t.channel) await api.patch(`/api/v1/templates/${id}`, { name, channel });
        if (body !== (t.current?.body ?? '') || subject !== (t.current?.subject ?? '')) { const v = await api.post<any>(`/api/v1/templates/${id}/versions`, { subject: subject || null, body }); toast.success(`Saved as version ${v.version}`); } else toast.success('Saved');
        st.reload(); onChanged();
      }
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  const restore = async (v: number) => {
    const c = await confirm({ title: `Restore version ${v}?`, body: 'This creates a new version with the content of the selected one. Nothing is deleted.', confirmLabel: 'Restore' });
    if (!c.ok) return;
    try { const r = await api.post<any>(`/api/v1/templates/${id}/restore`, { version: v }); toast.success(`Restored as version ${r.version}`); st.reload(); onChanged(); } catch (e) { toast.error(e); }
  };
  const sendTest = async () => {
    try { const r = await api.post<any>(`/api/v1/templates/${id}/send-test`, { entity_type: record?.type, entity_id: record?.id }); toast.success(`Test sent to ${r.to} — open the Dev Outbox to view it`); } catch (e) { toast.error(e); }
  };
  const archive = async () => {
    const isArchived = !!t?.archived_at;
    if (!isArchived) { const c = await confirm({ title: `Archive “${t.name}”?`, body: t.key ? 'System messages that use this key fall back to the built-in default text while it is archived.' : undefined, confirmLabel: 'Archive' }); if (!c.ok) return; }
    try { await api.post(`/api/v1/templates/${id}/${isArchived ? 'unarchive' : 'archive'}`); toast.success(isArchived ? 'Template restored' : 'Template archived'); st.reload(); onChanged(); } catch (e) { toast.error(e); }
  };
  const dirty = !id || (t && (name !== t.name || channel !== t.channel || body !== (t.current?.body ?? '') || subject !== (t.current?.subject ?? '')));
  return (
    <Drawer open onClose={onClose} wide title={id ? (t?.name ?? 'Template') : 'New template'} footer={<>
      {id && t && <Button icon={<Send size={15} />} onClick={sendTest}>Send test to {me?.user.email}</Button>}
      {id && t && can('templates', 'edit') && <Button icon={t.archived_at ? <RotateCcw size={15} /> : <Archive size={15} />} onClick={archive}>{t.archived_at ? 'Unarchive' : 'Archive'}</Button>}
      <Button onClick={onClose}>Close</Button>
      {editable && <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>{id ? 'Save new version' : 'Create template'}</Button>}
    </>}>
      {id && st.error && !t ? <ErrorState error={st.error} retry={st.reload} /> : id && !t ? <LoadingBlock rows={6} /> : (<>
        {t?.archived_at && <Banner tone="warn">This template is archived.</Banner>}
        {t && <div className="small muted mb-2">Key <code>{t.key}</code> · version {t.current_version} · sent {t.usage.sent} time{t.usage.sent === 1 ? '' : 's'}{t.usage.last_sent_at ? ` (last ${relTime(t.usage.last_sent_at)})` : ''} · <a href="#" onClick={e => { e.preventDefault(); setShowVersions(s => !s); }}><History size={12} style={{ verticalAlign: -1 }} /> {showVersions ? 'Hide' : 'Show'} versions</a></div>}
        {showVersions && t && <div className="mb-3">{t.versions.map((v: any) => (
          <div key={v.id} className="ins-rule"><div className="ins-rule-h"><b>Version {v.version}{v.version === t.current_version ? ' (current)' : ''}</b>{v.version !== t.current_version && can('templates', 'edit') && <Button size="xs" icon={<RotateCcw size={13} />} onClick={() => restore(v.version)}>Restore</Button>}</div><div className="small muted">{dateTime(v.created_at)} · {v.created_by_name ?? 'System'}</div><div className="small mt-1 truncate">{v.subject || v.body.slice(0, 120)}</div></div>
        ))}</div>}
        <div className="ins-split">
          <div>
            <div className="form-grid">
              <Field label="Name *" htmlFor="tp-name" error={errors.name}><input id="tp-name" className="input" disabled={!editable} value={name} onChange={e => setName(e.target.value)} /></Field>
              <Field label="Channel" htmlFor="tp-ch"><select id="tp-ch" className="select" disabled={!editable} value={channel} onChange={e => setChannel(e.target.value)}>{CHANNELS.map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
              {!['sms', 'whatsapp'].includes(channel) && <Field label="Subject" htmlFor="tp-sub" full><input id="tp-sub" className="input" disabled={!editable} value={subject} onChange={e => setSubject(e.target.value)} /></Field>}
              <Field label="Body *" htmlFor="tp-body" error={errors.body} full hint={channel === 'sms' ? `${body.length} characters` : undefined}><textarea id="tp-body" ref={bodyRef} className="textarea" rows={12} disabled={!editable} value={body} onChange={e => setBody(e.target.value)} /></Field>
            </div>
            <div className="small bold mt-2 mb-2">Insert merge variable</div>
            <div className="ins-chip-row">{(vars.data ?? []).map(v => <button key={v.key} type="button" className="chip" disabled={!editable} title={`${v.label} — e.g. ${v.sample}`} onClick={() => insert(v.key)} style={{ cursor: 'pointer' }}>{`{{${v.key}}}`}</button>)}</div>
          </div>
          <div>
            <div className="row mb-2" style={{ justifyContent: 'space-between' }}><b><Eye size={14} style={{ verticalAlign: -2 }} /> Preview</b><span className="small muted">{preview?.source === 'record' ? 'with real record data' : 'with sample data'}</span></div>
            <Field label="Preview with a record (optional)"><RecordPicker value={record} onChange={setRecord} types={['worker', 'candidate', 'company', 'invoice']} /></Field>
            {preview ? <div className="card card-pad">
              {preview.subject && <div className="bold mb-2">{preview.subject}</div>}
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{preview.body}</div>
              {preview.missing.length > 0 && <div className="small mt-2" style={{ color: 'var(--warning)' }}>Empty for this data: {preview.missing.map((m: string) => `{{${m}}}`).join(', ')}</div>}
            </div> : <div className="muted small">Start typing to see the rendered message.</div>}
          </div>
        </div>
      </>)}
    </Drawer>
  );
}
