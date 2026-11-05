import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Ban, FileStack, PenLine, CheckCircle2, Eye, XCircle, Copy } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, relTime } from '../../lib/format';
import { Button, KpiRow, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';

export default function Signatures() {
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [key, setKey] = useState(0);
  const counts = useApi<any>(`/api/v1/signatures?pageSize=1&k=${key}`);
  const c = counts.data?.counts;
  const columns: Column<any>[] = [
    { key: 'title', label: 'Document', mobile: 'title', render: s => <div><div className="bold">{s.title}</div><div className="small muted">{s.template_name ? `From template · ${s.template_name}` : 'Uploaded document'}</div></div> },
    { key: 'signer_name', label: 'Signer', sortable: false, render: s => <div><div>{s.signer_name}</div><div className="small muted">{s.signer_email}</div></div>, csv: s => `${s.signer_name} <${s.signer_email}>` },
    { key: 'entity_label', label: 'Record', render: s => s.entity_label ? (s.entity_link ? <Link to={s.entity_link} onClick={e => e.stopPropagation()}>{s.entity_label}</Link> : s.entity_label) : <span className="muted">—</span>, csv: s => s.entity_label },
    { key: 'status', label: 'Status', sortable: true, render: s => <div className="row" style={{ gap: 4 }}><StatusPill status={s.status} />{s.overdue && <StatusPill status="expired" label="Link expired" />}</div> },
    { key: 'created_at', label: 'Sent', sortable: true, render: s => <span title={dateTime(s.created_at)}>{relTime(s.created_at)} · {s.created_by_name ?? 'System'}</span>, csv: s => s.created_at },
    { key: 'signed_at', label: 'Signed', sortable: true, render: s => s.signed_at ? <span title={`IP ${s.signed_ip}`}>{dateTime(s.signed_at)}</span> : s.status === 'declined' ? <span className="down small">{s.declined_reason}</span> : s.expires_at ? <span className="small muted">expires {date(s.expires_at)}</span> : <span className="muted">—</span>, csv: s => s.signed_at },
  ];
  const remind = async (s: any) => { try { await api.post(`/api/v1/signatures/${s.id}/remind`); toast.success(`Reminder emailed to ${s.signer_email}`); setKey(k => k + 1); } catch (e) { toast.error(e); } };
  const cancel = async (s: any, reload: () => void) => {
    const r = await confirm({ title: 'Cancel this signature request?', body: 'The signing link stops working immediately.', danger: true, confirmLabel: 'Cancel request', reason: { label: 'Reason (optional)' } });
    if (!r.ok) return;
    try { await api.post(`/api/v1/signatures/${s.id}/cancel`, { reason: r.reason || undefined }); toast.success('Request cancelled'); reload(); setKey(k => k + 1); } catch (e) { toast.error(e); }
  };
  const copyLink = async (s: any) => { try { const r = await api.get<any>(`/api/v1/signatures/${s.id}`); if (!r.sign_url) { toast.info('This request is closed'); return; } await navigator.clipboard.writeText(r.sign_url); toast.success('Signing link copied'); } catch (e) { toast.error(e); } };
  return (
    <div>
      <PageHeader title="Signatures" sub="Every e-signature request: sent, viewed, signed (with timestamp, IP and certificate) or declined."
        actions={<>
          <Button icon={<FileStack size={16} />} onClick={() => nav('/documents/templates')}>Templates</Button>
          {can('documents', 'create') && <Button variant="primary" icon={<PenLine size={16} />} onClick={() => nav('/documents/templates')}>New from template</Button>}
        </>} />
      {c && <KpiRow items={[
        { label: 'Awaiting signature', icon: <PenLine size={16} />, value: c.open, deltaText: <span className="muted">{c.viewed} opened by signer</span>, suffix: '', to: '/documents/signatures?status=open' },
        { label: 'Signed (30 days)', icon: <CheckCircle2 size={16} />, value: c.signed_30d, deltaText: <span className="muted">{c.signed} signed all time</span>, suffix: '', to: '/documents/signatures?status=signed' },
        { label: 'Viewed, not signed', icon: <Eye size={16} />, value: c.viewed, deltaText: <span className="muted">send a reminder</span>, suffix: '', to: '/documents/signatures?status=viewed' },
        { label: 'Declined', icon: <XCircle size={16} />, value: c.declined, deltaText: <span className="muted">needs follow-up</span>, suffix: '', to: '/documents/signatures?status=declined' },
      ]} />}
      <DataTable endpoint="/api/v1/signatures" columns={columns} reloadKey={key} exportName="signatures" exportResource="documents"
        rowLink={s => (s.signed_document_id ? `/documents/${s.signed_document_id}` : s.document_id ? `/documents/${s.document_id}` : null)}
        filters={[{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Awaiting signature' }, ...opts(['sent', 'viewed', 'signed', 'declined', 'expired'])] }]}
        emptyTitle="No signature requests yet" emptyText="Generate a document from a template and send it for signature."
        rowActions={(s, reload) => [
          { label: 'Send reminder', icon: <Bell size={15} />, onClick: () => remind(s), hidden: !['sent', 'viewed'].includes(s.status) || !can('documents', 'edit') },
          { label: 'Copy signing link', icon: <Copy size={15} />, onClick: () => copyLink(s), hidden: !['sent', 'viewed'].includes(s.status) },
          { label: 'Open signed copy', icon: <CheckCircle2 size={15} />, onClick: () => nav(`/documents/${s.signed_document_id}`), hidden: !s.signed_document_id },
          { label: 'Cancel request', icon: <Ban size={15} />, danger: true, onClick: () => cancel(s, reload), hidden: !['sent', 'viewed'].includes(s.status) || !can('documents', 'edit') },
        ]} />
    </div>
  );
}
