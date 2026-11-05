import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Download, Upload, PenLine, CheckCircle2, RefreshCw } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { date, humanize } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, StatusPill, Banner } from '../../components/ui';
import { ExpiryPill, UploadDrawer, fileSize, openDocument } from './shared';

/** Client / worker portal: documents shared with me, signature requests, uploads and renewals. */
export default function PortalDocuments({ kind }: { kind: 'client' | 'worker' }) {
  const st = useApi<{ documents: any[]; signatures: any[] }>(`/api/v1/portal/${kind}/documents`);
  const [upload, setUpload] = useState<{ replaces?: { id: string; name: string } } | null>(null);
  const d = st.data;
  const header = <PageHeader title={kind === 'client' ? 'Documents & contracts' : 'Documents'} sub={kind === 'client' ? 'Contracts and files shared with your company. Sign agreements online.' : 'Your agreements, ID and tax forms. Sign documents and upload renewals here.'} actions={<Button variant="primary" icon={<Upload size={16} />} onClick={() => setUpload({})}>Upload document</Button>} />;
  if (st.error && !d) return <>{header}<ErrorState error={st.error} retry={st.reload} /></>;
  if (!d) return <>{header}<LoadingBlock rows={6} /></>;
  const toSign = d.signatures.filter(s => s.sign_url);
  const expiring = d.documents.filter(x => x.expiry_status === 'expiring' || x.expiry_status === 'expired');
  const rejected = d.documents.filter(x => x.verification === 'rejected');
  return (
    <div>
      {header}
      {toSign.length > 0 && <Banner tone="warn">You have {toSign.length} document{toSign.length === 1 ? '' : 's'} waiting for your signature.</Banner>}
      {kind === 'worker' && expiring.length > 0 && <Banner tone="warn">{expiring.length} of your documents {expiring.length === 1 ? 'is' : 'are'} expiring or expired. Upload a renewed copy below.</Banner>}
      {rejected.length > 0 && <Banner tone="danger">{rejected.length} upload{rejected.length === 1 ? ' was' : 's were'} rejected — see the reason and upload a corrected copy.</Banner>}
      {d.signatures.length > 0 && (
        <Card className="mb-3">
          <CardHeader title="Signature requests" />
          <div className="ins-list">{d.signatures.map(s => (
            <div key={s.id} className="ins-item">
              <PenLine size={16} className="muted" style={{ marginTop: 3 }} />
              <div style={{ flex: 1, minWidth: 0 }}><div className="t">{s.title}</div><div className="s">Sent {date(s.created_at)}{s.signed_at ? ` · signed ${date(s.signed_at)}` : s.expires_at ? ` · link expires ${date(s.expires_at)}` : ''}</div></div>
              {s.sign_url ? <Link className="btn btn-sm btn-primary" to={s.sign_url}>Review & sign</Link> : <StatusPill status={s.status} />}
            </div>
          ))}</div>
        </Card>
      )}
      <Card>
        <CardHeader title="All documents" sub={`${d.documents.length} file${d.documents.length === 1 ? '' : 's'}`} />
        {d.documents.length === 0 ? <EmptyState icon={<FileText size={22} />} title="No documents yet" text="Documents your agency shares with you will appear here." /> : (
          <div className="ins-list">{d.documents.map(x => (
            <div key={x.id} className="ins-item">
              <span className="tl-ic"><FileText size={15} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t">{x.name}</div>
                <div className="s">{humanize(x.category)} · {fileSize(x.size_bytes)}{x.expires_at ? ` · expires ${date(x.expires_at)}` : ''}{x.uploaded_by_me ? ' · uploaded by you' : ''}</div>
                <div className="row mt-1" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {x.signature_status === 'signed' && <StatusPill status="signed" label="Signed" />}
                  {x.signature_status === 'pending' && <StatusPill status="pending" label="Awaiting signature" />}
                  {x.verification === 'unverified' && x.uploaded_by_me && <StatusPill status="pending" label="Under review" />}
                  {x.verification === 'rejected' && <StatusPill status="rejected" label={`Rejected${x.rejection_reason ? `: ${x.rejection_reason}` : ''}`} />}
                  {x.expires_at && <ExpiryPill d={x} />}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {(x.expiry_status === 'expiring' || x.expiry_status === 'expired' || x.verification === 'rejected') && <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => setUpload({ replaces: { id: x.id, name: x.name } })}>Upload new</Button>}
                <Button size="sm" icon={<Download size={14} />} aria-label={`Download ${x.name}`} onClick={() => openDocument(`/api/v1/portal/${kind}/documents/${x.id}/download`, true)}>Download</Button>
              </div>
            </div>
          ))}</div>
        )}
      </Card>
      {d.documents.length > 0 && toSign.length === 0 && <div className="small muted mt-2 row" style={{ gap: 6 }}><CheckCircle2 size={14} /> Nothing waiting for your signature.</div>}
      <UploadDrawer open={!!upload} onClose={() => setUpload(null)} endpoint={`/api/v1/portal/${kind}/documents`} portal={kind} replaces={upload?.replaces ?? null} onDone={() => st.reload()} />
    </div>
  );
}
