import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, ShieldQuestion, UserX, Mail, Upload, ShieldCheck } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, humanize } from '../../lib/format';
import { Banner, Card, CardHeader, KpiRow, PageHeader, Segmented, StatusPill, Button, EmptyState } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ExpiryPill, UploadDrawer } from './shared';

type View = 'expiring' | 'expired' | 'unverified';

export default function Compliance() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) || 'expiring';
  const [key, setKey] = useState(0);
  const [renew, setRenew] = useState<any>(null);
  const st = useApi<any>(`/api/v1/documents/compliance?k=${key}`);
  const c = st.data?.counts;
  const setView = (v: View) => { const n = new URLSearchParams(); n.set('view', v); setSp(n, { replace: true }); };
  const params: Record<string, string> = view === 'unverified' ? { verification: 'unverified', current: 'true' } : { expiry: view, current: 'true' };
  const remind = async (d: any) => { try { const r = await api.post<any>(`/api/v1/documents/${d.id}/request-renewal`); toast.success(`Renewal request sent to ${r.to}`); } catch (e) { toast.error(e); } };
  const verify = async (d: any, reload: () => void) => { try { await api.post(`/api/v1/documents/${d.id}/verify`); toast.success('Verified'); reload(); setKey(k => k + 1); } catch (e) { toast.error(e); } };
  const columns: Column<any>[] = [
    { key: 'name', label: 'Document', mobile: 'title', sortable: true, render: d => <div><div className="bold">{d.name}</div><div className="small muted">{humanize(d.category)}</div></div> },
    { key: 'entity_label', label: 'Belongs to', render: d => d.entity_label ? (d.entity_link ? <Link to={d.entity_link} onClick={e => e.stopPropagation()}>{d.entity_label}</Link> : d.entity_label) : <span className="muted">—</span>, csv: d => d.entity_label },
    { key: 'expires_at', label: 'Expires', sortable: true, render: d => d.expires_at ? <div className="row" style={{ gap: 6 }}><span>{date(d.expires_at)}</span><ExpiryPill d={d} /></div> : <span className="muted">—</span>, csv: d => d.expires_at },
    { key: 'verification', label: 'Verification', render: d => <StatusPill status={d.verification} /> },
  ];
  return (
    <div>
      <PageHeader title="Compliance & expiry" sub="Documents that are expiring, expired or not yet verified — plus active workers missing a verified ID or signed contract."
        actions={<Button variant="primary" icon={<Upload size={16} />} onClick={() => setRenew({ id: null })} disabled={!can('documents', 'create')}>Upload document</Button>} />
      {c?.expired > 0 && <Banner tone="danger">{c.expired} document{c.expired === 1 ? ' has' : 's have'} expired. Request renewals so placements stay compliant.</Banner>}
      {c && <KpiRow items={[
        { label: 'Expiring ≤ 30 days', icon: <Clock size={16} />, value: c.expiring, deltaText: <span className="muted">{c.expiring_90} more within 90 days</span>, suffix: '', onClick: () => setView('expiring') },
        { label: 'Expired', icon: <AlertTriangle size={16} />, value: c.expired, deltaText: <span className="muted">renew now</span>, suffix: '', onClick: () => setView('expired') },
        { label: 'Unverified', icon: <ShieldQuestion size={16} />, value: c.unverified, deltaText: <span className="muted">{c.rejected} rejected</span>, suffix: '', onClick: () => setView('unverified') },
        { label: 'Workers missing documents', icon: <UserX size={16} />, value: st.data.missing.length, deltaText: <span className="muted">ID or signed contract</span>, suffix: '', onClick: () => document.getElementById('missing')?.scrollIntoView({ behavior: 'smooth' }) },
      ]} />}
      <div className="mb-3"><Segmented options={[{ key: 'expiring', label: `Expiring soon${c ? ` (${c.expiring})` : ''}` }, { key: 'expired', label: `Expired${c ? ` (${c.expired})` : ''}` }, { key: 'unverified', label: `Unverified${c ? ` (${c.unverified})` : ''}` }]} value={view} onChange={k => setView(k as View)} /></div>
      <DataTable key={view} endpoint="/api/v1/documents" params={params} urlState={false} columns={columns} reloadKey={key} rowLink={d => `/documents/${d.id}`} exportName={`compliance-${view}`} exportResource="documents" defaultSort="expires_at" defaultDir="asc"
        emptyTitle={view === 'unverified' ? 'Everything is verified' : view === 'expired' ? 'Nothing has expired' : 'Nothing expires in the next 30 days'}
        rowActions={(d, reload) => [
          { label: 'Email renewal request', icon: <Mail size={15} />, onClick: () => remind(d), hidden: view === 'unverified' || !can('documents', 'edit') },
          { label: 'Upload renewed copy', icon: <Upload size={15} />, onClick: () => setRenew(d), hidden: view === 'unverified' || !can('documents', 'create') },
          { label: 'Verify', icon: <ShieldCheck size={15} />, onClick: () => verify(d, reload), hidden: d.verification === 'verified' || !can('documents', 'edit') },
        ]} />
      <div id="missing" className="mt-3">
        <Card>
          <CardHeader title="Active workers missing documents" sub="Verified, unexpired government ID and a signed contract are expected for every active or onboarding worker." />
          {!st.data ? null : st.data.missing.length === 0 ? <EmptyState title="Every active worker is covered" /> : (
            <div className="ins-table-scroll"><table className="table">
              <thead><tr><th>Worker</th><th>Client</th><th>Placement</th><th>Missing</th></tr></thead>
              <tbody>{st.data.missing.map((m: any) => (
                <tr key={m.id} className="clickable" onClick={() => nav(m.link)}>
                  <td className="bold">{m.name}</td><td>{m.company}</td><td><StatusPill status={m.placement_status} /></td>
                  <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{m.missing_id && <StatusPill status="pending" label="Verified ID" />}{m.missing_contract && <StatusPill status="pending" label="Signed contract" />}</div></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
      <UploadDrawer open={!!renew} onClose={() => setRenew(null)} replaces={renew?.id ? { id: renew.id, name: renew.name } : null} onDone={() => setKey(k => k + 1)} />
    </div>
  );
}
