import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, ShieldCheck, ShieldX, PenLine, Archive, RotateCcw, Upload, Pencil, Mail } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, humanize } from '../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, KV, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm, Boundary } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { Timeline } from '../../components/Timeline';
import { CATEGORIES, VISIBILITY, VIS_LABEL, ExpiryPill, UploadDrawer, SendForSignature, fileSize, openDocument } from './shared';

export default function DocumentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const st = useApi<any>(`/api/v1/documents/${id}`);
  const [renew, setRenew] = useState(false);
  const [sign, setSign] = useState(false);
  const [edit, setEdit] = useState(false);
  const [tl, setTl] = useState(0);
  const d = st.data;
  const reload = () => { st.reload(); setTl(k => k + 1); };
  if (st.error && !d) return <><PageHeader title="Document" back="/documents" /><ErrorState error={st.error} retry={st.reload} /></>;
  if (!d) return <><PageHeader title="Document" back="/documents" /><LoadingBlock rows={8} /></>;
  const run = async (path: string, msg: string, body?: unknown) => { try { await api.post(`/api/v1/documents/${d.id}/${path}`, body ?? {}); toast.success(msg); reload(); } catch (e) { toast.error(e); } };
  const reject = async () => { const c = await confirm({ title: 'Reject this document?', body: 'The owner is asked to upload a corrected copy.', danger: true, confirmLabel: 'Reject', reason: { label: 'What needs fixing?', required: true } }); if (c.ok) run('reject', 'Document rejected', { reason: c.reason }); };
  const archive = async () => { const c = await confirm({ title: 'Archive this document?', confirmLabel: 'Archive', reason: { label: 'Reason (optional)' } }); if (c.ok) run('archive', 'Document archived', { reason: c.reason || undefined }); };
  const isImg = /^image\//.test(d.mime ?? '');
  const isPdf = d.mime === 'application/pdf';
  const isText = /^text\//.test(d.mime ?? '');
  const primaryKind: 'verify' | 'sign' | null = d.verification !== 'verified' && can('documents', 'edit') ? 'verify' : d.signature_status !== 'signed' && can('documents', 'create') && d.category !== 'id' ? 'sign' : null;
  const canSign = d.signature_status !== 'signed' && can('documents', 'create');
  const primary = primaryKind === 'verify'
    ? <Button variant="primary" icon={<ShieldCheck size={16} />} onClick={() => run('verify', 'Document verified')}>Verify</Button>
    : primaryKind === 'sign' ? <Button variant="primary" icon={<PenLine size={16} />} onClick={() => setSign(true)}>Send for signature</Button> : null;
  return (
    <div>
      <PageHeader back="/documents" title={d.name} sub={<span className="row" style={{ gap: 8, flexWrap: 'wrap' }}><StatusPill status={d.verification} />{d.signature_status && <StatusPill status={d.signature_status === 'signed' ? 'signed' : 'pending'} label={d.signature_status === 'signed' ? 'Signed' : 'Awaiting signature'} />}{d.expires_at && <ExpiryPill d={d} />}<span className="muted">{humanize(d.category)} · {VIS_LABEL[d.visibility]}</span></span>}
        actions={<>
          {d.has_file && <Button icon={<Download size={16} />} onClick={() => openDocument(`/api/v1/documents/${d.id}/download`, true)}>Download</Button>}
          {primary}
          <Menu items={[
            { label: 'Edit details', icon: <Pencil size={15} />, onClick: () => setEdit(true), hidden: !can('documents', 'edit') },
            { label: 'Upload renewed copy', icon: <Upload size={15} />, onClick: () => setRenew(true), hidden: !can('documents', 'create') },
            { label: 'Email renewal request', icon: <Mail size={15} />, onClick: async () => { try { const r = await api.post<any>(`/api/v1/documents/${d.id}/request-renewal`); toast.success(`Renewal request sent to ${r.to}`); setTl(k => k + 1); } catch (e) { toast.error(e); } }, hidden: !d.expires_at || !can('documents', 'edit') },
            { label: 'Send for signature', icon: <PenLine size={15} />, onClick: () => setSign(true), hidden: !canSign || primaryKind === 'sign' },
            { label: 'Reject', icon: <ShieldX size={15} />, onClick: reject, hidden: d.verification === 'rejected' || !can('documents', 'edit') },
            { sep: true },
            d.archived_at ? { label: 'Restore', icon: <RotateCcw size={15} />, onClick: () => run('restore', 'Document restored'), hidden: !can('documents', 'edit') } : { label: 'Archive', icon: <Archive size={15} />, danger: true, onClick: archive, hidden: !can('documents', 'delete') },
          ]} />
        </>} />
      {d.archived_at && <Banner tone="warn">This document is archived and hidden from portals.</Banner>}
      {d.superseded && <Banner>A renewed copy of this document exists — see Versions.</Banner>}
      {d.verification === 'rejected' && d.rejection_reason && <Banner tone="danger">Rejected: {d.rejection_reason}</Banner>}
      <div className="grid-main-side">
        <div className="stack" style={{ gap: 20 }}>
          <Card>
            <CardHeader title="Preview" right={d.has_file && <Button size="sm" onClick={() => openDocument(`/api/v1/documents/${d.id}/download`)}>Open in new tab</Button>} />
            <div className="card-b">
              {!d.url ? <div className="muted">No file attached.</div> : isImg ? <img src={d.url} alt={d.name} style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)' }} /> : isPdf || isText ? <iframe title={d.name} src={d.url} className="ins-frame" /> : <div className="muted">Preview not available for this file type — download it to view.</div>}
            </div>
          </Card>
          <Boundary label="Timeline"><Card><CardHeader title="Activity" /><div className="card-b"><Timeline key={tl} type="document" id={d.id} /></div></Card></Boundary>
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <Card>
            <CardHeader title="Details" />
            <div className="card-b"><KV items={[
              ['Attached to', d.entity_label ? (d.entity_link ? <Link to={d.entity_link}>{d.entity_label}</Link> : d.entity_label) : '—'],
              ['Category', humanize(d.category)], ['Visibility', VIS_LABEL[d.visibility]], ['File', d.has_file ? `${humanize((d.mime ?? '').split('/')[1] ?? 'file')} · ${fileSize(d.size_bytes)}` : '—'],
              ['Issued', d.issue_date ? date(d.issue_date) : '—'], ['Expires', d.expires_at ? date(d.expires_at) : '—'],
              ['Verification', d.verified_at ? `${humanize(d.verification)} by ${d.verified_by_name ?? 'system'} · ${date(d.verified_at)}` : humanize(d.verification)],
              ['Uploaded', `${dateTime(d.created_at)}${d.created_by_name ? ` · ${d.created_by_name}` : ''}`],
            ]} /></div>
          </Card>
          <Card>
            <CardHeader title="Signatures" />
            {d.signatures.length === 0 ? <div className="card-b muted small">No signature requests.</div> : <div className="ins-list">{d.signatures.map((s: any) => (
              <div key={s.id} className="ins-item"><div style={{ flex: 1, minWidth: 0 }}><div className="t">{s.signer_name}</div><div className="s">{s.signer_email} · sent {date(s.created_at)}{s.signed_at ? ` · signed ${dateTime(s.signed_at)} from ${s.signed_ip}` : s.viewed_at ? ` · viewed ${dateTime(s.viewed_at)}` : ''}</div>{s.signed_document_id && s.signed_document_id !== d.id && <Link className="small" to={`/documents/${s.signed_document_id}`}>Open signed copy</Link>}</div><StatusPill status={s.status} /></div>
            ))}</div>}
          </Card>
          <Card>
            <CardHeader title="Versions" />
            {d.versions.length === 0 ? <div className="card-b muted small">This is the only version.</div> : <div className="ins-list">{d.versions.map((v: any) => (
              <Link key={v.id} to={`/documents/${v.id}`} className="ins-item"><div style={{ flex: 1 }}><div className="t">{v.name}</div><div className="s">Uploaded {date(v.created_at)}{v.expires_at ? ` · expires ${date(v.expires_at)}` : ''}</div></div></Link>
            ))}</div>}
          </Card>
        </div>
      </div>
      <UploadDrawer open={renew} onClose={() => setRenew(false)} replaces={{ id: d.id, name: d.name }} onDone={n => nav(`/documents/${n.id}`)} />
      <SendForSignature open={sign} doc={d} onClose={() => setSign(false)} onDone={reload} />
      <FormDrawer open={edit} onClose={() => setEdit(false)} title="Edit document" initial={{ name: d.name, category: d.category, visibility: d.visibility, issue_date: d.issue_date ?? '', expires_at: d.expires_at ?? '' }}
        fields={[{ name: 'name', label: 'Name', required: true, full: true }, { name: 'category', label: 'Category', type: 'select', options: CATEGORIES.map(c => ({ value: c, label: humanize(c) })) }, { name: 'visibility', label: 'Visibility', type: 'select', options: VISIBILITY.map(v => ({ value: v, label: VIS_LABEL[v] })) }, { name: 'issue_date', label: 'Issue date', type: 'date' }, { name: 'expires_at', label: 'Expires', type: 'date' }]}
        onSubmit={async v => { await api.patch(`/api/v1/documents/${d.id}`, { ...v, issue_date: v.issue_date || null, expires_at: v.expires_at || null }); toast.success('Document updated'); reload(); }} />
    </div>
  );
}
