import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, RefreshCw, ArrowRight } from 'lucide-react';
import { useApi, useInterval } from '../../lib/hooks';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented } from '../../components/ui';
import { AttentionList, type AttentionGroup } from './kit';

export default function Attention() {
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') ?? '';
  const st = useApi<{ groups: AttentionGroup[]; kinds: Record<string, string> }>(`/api/v1/dashboard/attention${kind ? `?kind=${kind}` : ''}`);
  const all = useApi<{ groups: AttentionGroup[] }>('/api/v1/dashboard/attention');
  useInterval(() => { st.reload(); all.reload(); }, 60_000);
  const groups = st.data?.groups ?? [];
  const total = (all.data?.groups ?? []).reduce((a, g) => a + g.count, 0);
  const options = [{ key: '', label: `All (${total})` }, ...(all.data?.groups ?? []).map(g => ({ key: g.kind, label: `${g.label} (${g.count})` }))];
  return (
    <div>
      <PageHeader title="Needs Attention" sub="Generated live from your data: overdue work, late workers, blockers, unpaid invoices and expiring documents."
        actions={<Button icon={<RefreshCw size={16} />} onClick={() => { st.reload(); all.reload(); }} loading={st.loading && !!st.data}>Refresh</Button>} />
      {all.data && all.data.groups.length > 1 && <div className="mb-3" style={{ overflowX: 'auto' }}><Segmented options={options} value={kind} onChange={k => { const n = new URLSearchParams(sp); if (k) n.set('kind', k); else n.delete('kind'); setSp(n, { replace: true }); }} /></div>}
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={8} /> : groups.length === 0 ? (
        <Card><EmptyState icon={<CheckCircle2 size={22} />} title="All clear" text="Nothing needs attention right now. This list updates every minute." /></Card>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          {groups.map(g => (
            <Card key={g.kind}>
              <CardHeader title={`${g.label}`} sub={`${g.count} item${g.count === 1 ? '' : 's'}${g.count > g.items.length ? ` · showing ${g.items.length}` : ''}`} right={<Link to={g.link} className="small row" style={{ gap: 4 }}>Open list <ArrowRight size={14} /></Link>} />
              <AttentionList groups={[g]} showHeaders={false} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
