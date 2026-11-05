import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, FileText, Download, Eye, ShieldCheck, PenLine, Archive, FileStack, AlertTriangle, Clock, FileSignature } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, humanize, relTime } from '../../lib/format';
import { Button, KpiRow, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { CATEGORIES, VISIBILITY, VIS_LABEL, ExpiryPill, UploadDrawer, SendForSignature, openDocument } from './shared';

export default function Library() {
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [upload, setUpload] = useState(false);
  const [sign, setSign] = useState<any>(null);
  const [key, setKey] = useState(0);
  const comp = useApi<any>(`/api/v1/documents/compliance?k=${key}`);
  const c = comp.data?.counts;
  const reload = () => setKey(k => k + 1);
  const verify = async (d: any, r: () => void) => { try { await api.post(`/api/v1/documents/${d.id}/verify`); toast.success('Document verified'); r(); reload(); } catch (e) { toast.error(e); } };
  const archive = async (d: any, r: () => void) => {
    const x = await confirm({ title: `Archive “${d.name}”?`, body: 'Archived documents are hidden from portals and lists but kept for history. You can restore them later.', confirmLabel: 'Archive', reason: { label: 'Reason (optional)' } });
    if (!x.ok) return;
    try { await api.post(`/api/v1/documents/${d.id}/archive`, { reason: x.reason || undefined }); toast.success('Document archived'); r(); reload(); } catch (e) { toast.error(e); }
  };
  const columns: Column<any>[] = [
    { key: 'name', label: 'Document', mobile: 'title', sortable: true, render: d => <div className="row" style={{ gap: 10, minWidth: 0 }}><span className="tl-ic"><FileText size={15} /></span><div style={{ minWidth: 0 }}><div className="bold truncate">{d.name}</div><div className="small muted">{humanize(d.category)}{d.superseded ? ' · superseded' : ''}</div></div></div> },
    { key: 'entity_label', label: 'Attached to', render: d => d.entity_label ? (d.entity_link ? <Link to={d.entity_link} onClick={e => e.stopPropagation()}>{d.entity_label}</Link> : d.entity_label) : <span className="muted">—</span>, csv: d => d.entity_label },
    { key: 'visibility', label: 'Visibility', render: d => <span className="small">{VIS_LABEL[d.visibility] ?? humanize(d.visibility)}</span> },
    { key: 'verification', label: 'Status', render: d => <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}><StatusPill status={d.verification} />{d.signature_status && <StatusPill status={d.signature_status === 'signed' ? 'signed' : 'pending'} label={d.signature_status === 'signed' ? 'Signed' : 'Awaiting signature'} />}</div>, csv: d => `${d.verification}${d.signature_status ? ` / ${d.signature_status}` : ''}` },
    { key: 'expires_at', label: 'Expires', sortable: true, render: d => d.expires_at ? <div><div className="small">{date(d.expires_at)}</div><ExpiryPill d={d} /></div> : <span className="muted">—</span>, csv: d => d.expires_at },
    { key: 'created_at', label: 'Uploaded', sortable: true, mobile: 'hidden', render: d => <span className="small">{relTime(d.created_at)}{d.created_by_name ? ` · ${d.created_by_name}` : ''}</span>, csv: d => d.created_at },
  ];
  return (
    <div>
      <PageHeader title="Documents" sub="Contracts, IDs, tax forms and policies attached to clients, workers and candidates — with visibility, verification and expiry."
        actions={<>
          <Button icon={<FileStack size={16} />} onClick={() => nav('/documents/templates')}>Generate from template</Button>
          {can('documents', 'create') && <Button variant="primary" icon={<Upload size={16} />} onClick={() => setUpload(true)}>Upload</Button>}
        </>} />
      {c && <KpiRow items={[
        { label: 'Documents', icon: <FileText size={16} />, value: c.total.toLocaleString(), deltaText: <span className="muted">current versions</span>, suffix: '', to: '/documents' },
        { label: 'Expiring ≤ 30 days', icon: <Clock size={16} />, value: c.expiring, deltaText: <span className={c.expired ? 'down' : 'muted'}>{c.expired} already expired</span>, suffix: '', to: '/documents/compliance' },
        { label: 'Unverified', icon: <AlertTriangle size={16} />, value: c.unverified, deltaText: <span className="muted">need review</span>, suffix: '', to: '/documents?verification=unverified' },
        { label: 'Awaiting signature', icon: <FileSignature size={16} />, value: c.pending_signature, deltaText: <span className="muted">open requests</span>, suffix: '', to: '/documents/signatures?status=open' },
      ]} />}
      <DataTable endpoint="/api/v1/documents" columns={columns} reloadKey={key} rowLink={d => `/documents/${d.id}`} exportName="documents" exportResource="documents"
        filters={[{ key: 'category', label: 'Category', options: opts(CATEGORIES) }, { key: 'visibility', label: 'Visibility', options: VISIBILITY.map(v => ({ value: v, label: VIS_LABEL[v] })) }, { key: 'verification', label: 'Verification', options: opts(['unverified', 'verified', 'rejected']) },
          { key: 'expiry', label: 'Expiry', options: opts(['expired', 'expiring', 'valid', 'none'], { expiring: 'Expiring ≤ 30 days', none: 'No expiry' }) }, { key: 'entity_type', label: 'Attached to', options: opts(['worker', 'company', 'candidate', 'placement', 'position', 'contact', 'invoice']) }, { key: 'signature_status', label: 'Signature', options: opts(['pending', 'signed']) }, { key: 'archived', label: 'Archived', type: 'boolean' }]}
        emptyTitle="No documents yet" emptyText="Upload a document or generate one from a template." emptyAction={can('documents', 'create') ? <Button size="sm" icon={<Upload size={14} />} onClick={() => setUpload(true)}>Upload</Button> : undefined}
        rowActions={(d, r) => [
          { label: 'Open', icon: <Eye size={15} />, onClick: () => openDocument(`/api/v1/documents/${d.id}/download`), hidden: !d.has_file },
          { label: 'Download', icon: <Download size={15} />, onClick: () => openDocument(`/api/v1/documents/${d.id}/download`, true), hidden: !d.has_file },
          { label: 'Verify', icon: <ShieldCheck size={15} />, onClick: () => verify(d, r), hidden: d.verification === 'verified' || !can('documents', 'edit') },
          { label: 'Send for signature', icon: <PenLine size={15} />, onClick: () => setSign(d), hidden: d.signature_status === 'signed' || !can('documents', 'create') },
          { sep: true },
          { label: 'Archive', icon: <Archive size={15} />, danger: true, onClick: () => archive(d, r), hidden: !!d.archived_at || !can('documents', 'delete') },
        ]}
        bulkActions={can('documents', 'edit') ? [{ label: 'Verify', icon: <ShieldCheck size={14} />, onClick: async (ids, r) => { let n = 0; for (const id of ids) { try { await api.post(`/api/v1/documents/${id}/verify`); n++; } catch { /* already verified */ } } toast.success(`${n} document${n === 1 ? '' : 's'} verified`); r(); reload(); } }] : undefined}
      />
      <UploadDrawer open={upload} onClose={() => setUpload(false)} onDone={d => { reload(); nav(`/documents/${d.id}`); }} />
      <SendForSignature open={!!sign} doc={sign} onClose={() => setSign(null)} onDone={reload} />
    </div>
  );
}
