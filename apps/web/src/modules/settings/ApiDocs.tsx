import { useMemo, useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { Banner, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, SearchInput } from '../../components/ui';
import './settings.css';

const METHOD_COLOR: Record<string, string> = { get: '#16A34A', post: '#345CFF', patch: '#C2780A', put: '#C2780A', delete: '#DC2626' };

/** Public API reference generated live from the server's route table (OpenAPI 3.1). Used in Settings and at /docs/api. */
export function ApiReference({ standalone }: { standalone?: boolean }) {
  const st = useApi<any>('/api/v1/docs/openapi.json');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [tag, setTag] = useState('all');
  const [open, setOpen] = useState<string | null>(null);
  const ops = useMemo(() => {
    if (!st.data) return [];
    const out: { path: string; method: string; op: any }[] = [];
    for (const [path, methods] of Object.entries<any>(st.data.paths)) for (const [method, op] of Object.entries<any>(methods)) out.push({ path, method, op });
    return out;
  }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={10} /></Card>;
  const tags: string[] = st.data.tags.map((t: any) => t.name);
  const filtered = ops.filter(o => (tag === 'all' || o.op.tags[0] === tag) && (!dq || `${o.method} ${o.path} ${o.op.summary}`.toLowerCase().includes(dq.toLowerCase())));
  const base = window.location.origin;
  return (
    <div className="stack">
      {!standalone && <PageHeader title="API reference" back="/settings/api" sub={`${st.data.info.title} ${st.data.info.version} · ${ops.length} operations, generated from the live server`} actions={<a className="btn" href="/api/v1/docs/openapi.json" download="veyroapp-openapi.json"><Download size={16} /> openapi.json</a>} />}
      <Banner icon={<KeyRound size={18} />}>{st.data.info.description}</Banner>
      <Card>
        <CardHeader title="Quick start" />
        <div className="card-b"><pre className="st-code">{`# List your leads (paginated: rows, total, page, pageSize)\ncurl -H "Authorization: Bearer vk_your_key" "${base}/api/v1/leads?page=1&pageSize=25"\n\n# Errors are JSON: { "error": "…", "fields": { "email": "Invalid email" } }\n# 401 bad key · 403 not permitted · 404 not found (or another workspace) · 409 invalid state · 429 rate limited`}</pre></div>
      </Card>
      <Card>
        <div className="table-toolbar">
          <h3>Endpoints</h3>
          <SearchInput value={q} onChange={setQ} placeholder="Search endpoints" width={260} />
          <select className="select input-sm" style={{ width: 'auto' }} aria-label="Area" value={tag} onChange={e => setTag(e.target.value)}><option value="all">All areas ({ops.length})</option>{tags.map(t => <option key={t} value={t}>{t} ({ops.filter(o => o.op.tags[0] === t).length})</option>)}</select>
        </div>
        {filtered.length === 0 ? <EmptyState title="No endpoints match" /> : (
          <div>
            {filtered.slice(0, 400).map(o => { const k = `${o.method} ${o.path}`; return (
              <div key={k} style={{ borderTop: '1px solid var(--border-2)' }}>
                <button onClick={() => setOpen(open === k ? null : k)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center', padding: '10px 22px', width: 'calc(100% - 44px)' }} aria-expanded={open === k}>
                  <span className="mono" style={{ width: 58, fontWeight: 700, fontSize: 12, color: METHOD_COLOR[o.method] ?? 'var(--text)', textTransform: 'uppercase' }}>{o.method}</span>
                  <span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{o.path}</span>
                  <span className="small muted desktop-only">{o.op.summary}</span>
                  {o.op.security?.length === 0 && <span className="pill pill-gray">Public</span>}
                </button>
                {open === k && <div style={{ padding: '0 22px 16px 92px' }} className="small">
                  <div className="mb-2"><b>{o.op.summary}</b> · {o.op.tags[0]} · operationId <span className="mono">{o.op.operationId}</span></div>
                  {o.op.parameters?.length > 0 && <table className="st-diff" style={{ marginBottom: 10 }}><thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Required</th></tr></thead><tbody>{o.op.parameters.map((p: any) => <tr key={p.in + p.name}><td className="mono">{p.name}</td><td>{p.in}</td><td>{p.schema?.type}{p.schema?.enum ? ` (${p.schema.enum.join(' | ')})` : ''}</td><td>{p.required ? 'Yes' : 'No'}</td></tr>)}</tbody></table>}
                  <pre className="st-code">{`curl -X ${o.method.toUpperCase()} ${o.op.security?.length === 0 ? '' : '-H "Authorization: Bearer vk_your_key" '}${o.op.requestBody ? "-H 'content-type: application/json' -d '{…}' " : ''}"${base}${o.path}"`}</pre>
                </div>}
              </div>
            ); })}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function ApiDocsPage() { return <ApiReference />; }
