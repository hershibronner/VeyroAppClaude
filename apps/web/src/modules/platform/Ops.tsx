import { useState } from 'react';
import { Activity, AlertTriangle, Database, KeyRound, RefreshCw, Server, ShieldAlert, Users, Webhook } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, humanize, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, KpiRow, LoadingBlock, PageHeader, StatusPill } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { ChartCard, SimpleBars } from '../../components/charts';

export function FlagsPage() {
  const st = useApi<any>('/api/v1/platform/flags');
  const [busy, setBusy] = useState('');
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock /></Card>;
  const toggle = async (o: any, k: string) => { setBusy(`${o.id}:${k}`); try { await api.put(`/api/v1/platform/agencies/${o.id}/flags/${k}`, { enabled: !o.flags[k] }); toast.success(`${humanize(k)} ${o.flags[k] ? 'disabled' : 'enabled'} for ${o.name}`); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <div className="stack">
      <PageHeader title="Feature flags" sub="Turn features on or off per agency. Flags take effect on the agency's next page load; every change is audited in their log." />
      <Card>
        <div className="st-matrix st-flag-grid"><table>
          <thead><tr><th>Agency</th>{st.data.keys.map((k: string) => <th key={k}>{humanize(k)}</th>)}</tr></thead>
          <tbody>{st.data.orgs.map((o: any) => <tr key={o.id}><th>{o.name}<div className="tiny muted" style={{ fontWeight: 400 }}>{humanize(o.plan_key)}</div></th>{st.data.keys.map((k: string) => <td key={k}><input type="checkbox" aria-label={`${o.name}: ${humanize(k)}`} checked={!!o.flags[k]} disabled={busy === `${o.id}:${k}`} onChange={() => toggle(o, k)} style={{ width: 16, height: 16, accentColor: 'var(--primary)' }} /></td>)}</tr>)}</tbody>
        </table></div>
      </Card>
    </div>
  );
}

export function ProvidersPage() {
  const st = useApi<any>('/api/v1/platform/integrations');
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock /></Card>;
  const d = st.data;
  const degraded = d.providers.filter((p: any) => p.health !== 'operational');
  return (
    <div className="stack">
      <PageHeader title="Provider health" sub="Status of every simulated adapter across all agencies." actions={<Button icon={<RefreshCw size={16} />} onClick={st.reload}>Refresh</Button>} />
      {degraded.length > 0 ? <Banner tone="warn">{degraded.length} provider{degraded.length === 1 ? ' is' : 's are'} degraded: {degraded.map((p: any) => p.provider).join(', ')}.</Banner> : <Banner tone="success">All providers operational.</Banner>}
      <KpiRow items={[
        { label: 'Providers', value: d.providers.length, icon: <Server size={16} /> }, { label: 'Agency connections in error', value: d.problems.filter((p: any) => p.status === 'error').length, icon: <AlertTriangle size={16} /> },
        { label: 'Webhooks delivered (7d)', value: d.webhooks.delivered, icon: <Webhook size={16} />, deltaText: `${d.webhooks.failed} failed · ${d.webhooks.in_flight} in flight`, suffix: '' },
      ]} />
      <Card><CardHeader title="Providers" />
        <div className="table-wrap"><table className="table"><thead><tr><th>Provider</th><th>Health</th><th style={{ textAlign: 'right' }}>Connected</th><th style={{ textAlign: 'right' }}>Error</th><th style={{ textAlign: 'right' }}>Disconnected</th><th style={{ textAlign: 'right' }}>Errors (24h)</th><th>Last sync</th></tr></thead><tbody>
          {d.providers.map((p: any) => <tr key={p.key}><td><div className="bold">{p.provider}</div><div className="tiny muted">{p.category}</div></td><td><StatusPill status={p.health === 'operational' ? 'connected' : p.health === 'degraded' ? 'error' : 'disconnected'} label={humanize(p.health)} /></td><td className="money">{p.connected}</td><td className="money">{p.error}</td><td className="money">{p.disconnected}</td><td className="money">{p.errors_24h}</td><td>{p.last_sync_at ? relTime(p.last_sync_at) : '—'}</td></tr>)}
        </tbody></table></div>
      </Card>
      <div className="grid-2">
        <Card><CardHeader title="Connections needing attention" />{d.problems.length === 0 ? <EmptyState title="None" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.problems.map((p: any) => <div key={p.organization_id + p.key} className="checklist-item"><div style={{ flex: 1 }}><div className="small bold">{p.org_name} · {humanize(p.key)}</div><div className="tiny muted">{p.last_error ?? 'Disconnected'} · {relTime(p.updated_at)}</div></div><StatusPill status={p.status} /></div>)}</div>}</Card>
        <Card><CardHeader title="Recent warnings & errors" />{d.recent.length === 0 ? <EmptyState title="No errors" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.recent.map((l: any) => <div key={l.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="small">{l.message}</div><div className="tiny muted">{l.org_name ?? 'Platform'} · {humanize(l.integration_key)} · {dateTime(l.created_at)}</div></div><StatusPill status={l.level} /></div>)}</div>}</Card>
      </div>
    </div>
  );
}

export function SystemPage() {
  const st = useApi<any>('/api/v1/platform/system');
  useInterval(() => st.reload(), 10000);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock /></Card>;
  const d = st.data;
  const by = (s: string) => d.status.find((x: any) => x.status === s)?.n ?? 0;
  return (
    <div className="stack">
      <PageHeader title="System health" sub={`API up ${Math.floor(d.uptime_seconds / 3600)}h ${Math.floor((d.uptime_seconds % 3600) / 60)}m · Node ${d.node} · ${d.memory_mb} MB RSS · refreshes every 10s`} actions={<Button icon={<RefreshCw size={16} />} onClick={st.reload}>Refresh</Button>} />
      {d.stuck.length > 0 && <Banner tone="danger">{d.stuck.length} job{d.stuck.length === 1 ? ' has' : 's have'} been running for over 10 minutes.</Banner>}
      {d.queue_lag_seconds > 60 && <Banner tone="warn">The queue is {d.queue_lag_seconds}s behind.</Banner>}
      <KpiRow items={[
        { label: 'Queued', value: by('queued'), icon: <Activity size={16} />, deltaText: `lag ${d.queue_lag_seconds ?? 0}s`, suffix: '' }, { label: 'Running', value: by('running'), icon: <Server size={16} /> },
        { label: 'Failed (all time)', value: by('failed'), icon: <AlertTriangle size={16} /> }, { label: 'Database', value: `${(d.db.bytes / 1048576).toFixed(0)} MB`, icon: <Database size={16} />, deltaText: `${d.db.connections} connections`, suffix: '' },
      ]} />
      <div className="grid-2">
        <ChartCard title="Jobs completed per hour (24h)">{d.throughput.length ? <SimpleBars data={d.throughput} height={220} /> : <EmptyState title="No completed jobs in 24h" />}</ChartCard>
        <Card><CardHeader title="Queue by job type" />
          <div className="table-wrap"><table className="table"><thead><tr><th>Kind</th><th style={{ textAlign: 'right' }}>Queued</th><th style={{ textAlign: 'right' }}>Running</th><th style={{ textAlign: 'right' }}>Done 24h</th><th style={{ textAlign: 'right' }}>Failed</th><th style={{ textAlign: 'right' }}>Avg</th></tr></thead><tbody>
            {d.kinds.map((k: any) => <tr key={k.kind}><td className="mono small">{k.kind}</td><td className="money">{k.queued}</td><td className="money">{k.running}</td><td className="money">{k.succeeded_24h}</td><td className="money">{k.failed}</td><td className="money">{k.avg_seconds !== null ? `${k.avg_seconds}s` : '—'}</td></tr>)}
          </tbody></table></div>
        </Card>
      </div>
      <Card><CardHeader title="Failed jobs" sub="Retrying resets attempts and re-queues the job." />
        {d.failed.length === 0 ? <EmptyState title="No failed jobs" /> : <div className="table-wrap"><table className="table"><thead><tr><th>Job</th><th>Agency</th><th>Error</th><th>Attempts</th><th>Failed</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {d.failed.map((j: any) => <tr key={j.id}><td className="mono small">{j.kind}</td><td>{j.org_name ?? '—'}</td><td className="small" style={{ maxWidth: 360 }}>{j.last_error}</td><td>{j.attempts}/{j.max_attempts}</td><td>{relTime(j.finished_at)}</td><td className="act"><Button size="xs" onClick={async () => { try { await api.post(`/api/v1/platform/jobs/${j.id}/retry`); toast.success('Job re-queued'); st.reload(); } catch (e) { toast.error(e); } }}>Retry</Button></td></tr>)}
        </tbody></table></div>}
      </Card>
      <Card><CardHeader title="Recent errors" />{d.errors.length === 0 ? <EmptyState title="No errors logged" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.errors.map((e: any) => <div key={e.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="small">{e.message}</div><div className="tiny muted">{e.org_name ?? 'Platform'} · {humanize(e.integration_key)} · {dateTime(e.created_at)}</div></div></div>)}</div>}</Card>
    </div>
  );
}

export function SecurityPage() {
  const st = useApi<any>('/api/v1/platform/security');
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=200');
  const [view, setView] = useState<any>(null);
  const d = st.data;
  return (
    <div className="stack">
      <PageHeader title="Audit & security" sub="Cross-tenant audit trail and security posture. Only platform admins can see this." />
      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <Card><LoadingBlock /></Card> : <>
        <KpiRow items={[
          { label: 'Active sessions', value: d.active_sessions, icon: <Users size={16} />, deltaText: `${d.api_sessions} via API keys`, suffix: '' },
          { label: 'Sign-ins (24h)', value: d.logins_24h, icon: <Activity size={16} /> },
          { label: 'Two-step adoption', value: d.users ? `${Math.round((d.mfa_users / d.users) * 100)}%` : '—', icon: <KeyRound size={16} />, deltaText: `${d.mfa_users} of ${d.users} users`, suffix: '' },
          { label: 'Support sessions (30d)', value: d.impersonations_30d, icon: <ShieldAlert size={16} />, to: '/platform/impersonation' },
        ]} />
        <div className="grid-2">
          <ChartCard title="Sign-ins per day (14 days)"><SimpleBars data={d.logins} height={220} /></ChartCard>
          <Card><CardHeader title="Sensitive actions" sub={`${d.exports_7d} exports in 7 days · ${d.api_keys} active API keys · ${d.throttled_keys} throttled callers (1h)`} />
            <div className="card-b" style={{ paddingTop: 4, maxHeight: 300, overflowY: 'auto' }}>{d.sensitive.map((a: any) => <div key={a.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="small"><b>{a.actor_label ?? 'System'}</b> <span className="mono">{a.action}</span> {a.entity_label ?? ''}</div><div className="tiny muted">{a.org_name ?? 'Platform'} · {dateTime(a.created_at)}{a.reason ? ` · “${a.reason}”` : ''}</div></div></div>)}</div>
          </Card>
        </div>
      </>}
      <DataTable<any> title="Audit trail (all agencies)" endpoint="/api/v1/platform/audit" exportName="platform-audit" onRowClick={setView}
        filters={[{ key: 'organization_id', label: 'Agency', options: (agencies.data?.rows ?? []).map((a: any) => ({ value: a.id, label: a.name })) }, { key: 'action', label: 'Action', options: ['impersonation', 'platform', 'subscription', 'saas_invoice', 'role', 'member', 'auth', 'export', 'rate', 'placement', 'import'].map(v => ({ value: v, label: humanize(v) })) }, { key: 'impersonated', label: 'Support mode', type: 'boolean' }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]}
        columns={[
          { key: 'created_at', label: 'When', sortable: true, mobile: 'subtitle', render: r => dateTime(r.created_at) },
          { key: 'org_name', label: 'Agency', render: r => r.org_name ?? 'Platform' },
          { key: 'actor_label', label: 'Actor', render: r => <span>{r.actor_label ?? 'System'}{r.impersonator_name && <div className="tiny" style={{ color: 'var(--warning)' }}>support: {r.impersonator_name}</div>}</span> },
          { key: 'action', label: 'Action', mobile: 'title', render: r => <span className="mono small">{r.action}</span> },
          { key: 'entity_label', label: 'Record' }, { key: 'reason', label: 'Reason' }, { key: 'ip', label: 'IP', mobile: 'hidden' },
        ]} />
      <Drawer open={!!view} onClose={() => setView(null)} title={view?.action ?? ''} wide>{view && <pre className="st-code">{JSON.stringify({ when: view.created_at, agency: view.org_name, actor: view.actor_label, impersonator: view.impersonator_name, record: view.entity_label, reason: view.reason, ip: view.ip, before: view.before, after: view.after }, null, 2)}</pre>}</Drawer>
    </div>
  );
}
