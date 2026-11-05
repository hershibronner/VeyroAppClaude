import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, FileText, KeyRound, Plug, PlugZap, RefreshCw, Unplug, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Drawer, ErrorState, KpiRow, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { Gate, ReadOnlyNote } from './common';

export default function IntegrationsSettings() {
  return <Gate resource="integrations">{editable => <Inner editable={editable} />}</Gate>;
}

function Inner({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[]; editable: boolean }>('/api/v1/integrations');
  const [logs, setLogs] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const nav = useNavigate();
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Integrations" /><Card><LoadingBlock rows={8} /></Card></div>;
  const rows = st.data.rows;
  const run = async (it: any, action: string) => {
    if (action === 'disconnect') { const c = await confirm({ title: `Disconnect ${it.provider}?`, body: `${it.category} features that depend on it will show a "disconnected" error until you reconnect.`, danger: true, confirmLabel: 'Disconnect' }); if (!c.ok) return; }
    setBusy(`${it.key}:${action}`);
    try { const r = await api.post(`/api/v1/integrations/${it.key}/${action}`); r.ok ? toast.success(r.message) : toast.error(r.message); st.reload(); }
    catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const counts = { connected: rows.filter(r => r.status === 'connected').length, error: rows.filter(r => r.status === 'error').length, disconnected: rows.filter(r => r.status === 'disconnected').length, events: rows.reduce((a, r) => a + r.events_7d, 0) };
  const groups = [...new Set(rows.map(r => r.category))];
  return (
    <div className="stack">
      <PageHeader title="Integrations" sub="Every provider is a replaceable adapter. In this local build they are simulated and log everything they do."
        actions={<><Button icon={<KeyRound size={16} />} onClick={() => nav('/settings/api')}>API & Webhooks</Button>{editable && <Button variant="primary" icon={<Zap size={16} />} loading={busy === 'all'} onClick={async () => { setBusy('all'); let ok = 0; for (const r of rows.filter(r => r.status === 'connected')) { const x = await api.post(`/api/v1/integrations/${r.key}/test`).catch(() => null); if (x?.ok) ok++; } toast.success(`${ok} of ${counts.connected} connected integrations passed their test`); setBusy(''); st.reload(); }}>Test all</Button>}</>} />
      <ReadOnlyNote show={!editable} />
      {counts.error > 0 && <Banner tone="danger">{counts.error} integration{counts.error === 1 ? ' is' : 's are'} reporting errors: {rows.filter(r => r.status === 'error').map(r => r.provider).join(', ')}. Reconnect to restore service.</Banner>}
      <KpiRow items={[
        { label: 'Connected', value: counts.connected, icon: <CheckCircle2 size={16} />, deltaText: `of ${rows.length} adapters`, suffix: '' },
        { label: 'Errors', value: counts.error, icon: <AlertTriangle size={16} />, deltaText: counts.error ? 'needs attention' : 'all healthy', suffix: '' },
        { label: 'Disconnected', value: counts.disconnected, icon: <Unplug size={16} />, deltaText: 'turned off', suffix: '' },
        { label: 'Events (7 days)', value: counts.events, icon: <Activity size={16} />, deltaText: 'syncs, tests & errors logged', suffix: '' },
      ]} />
      {groups.map(g => (
        <Card key={g}>
          <CardHeader title={g} />
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Provider</th><th>Status</th><th>Scopes</th><th>Last sync</th><th style={{ textAlign: 'right' }}>Errors (7d)</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.filter(r => r.category === g).map(it => (
              <tr key={it.key}>
                <td><div className="bold">{it.provider}</div>{it.last_error && <div className="small" style={{ color: 'var(--danger)' }}>{it.last_error}</div>}</td>
                <td><StatusPill status={it.status} /></td>
                <td><div className="chips">{it.scopes.map((s: string) => <span key={s} className="chip">{s}</span>)}</div></td>
                <td title={dateTime(it.last_sync_at)}>{it.last_sync_at ? relTime(it.last_sync_at) : '—'}</td>
                <td className="money">{it.errors_7d || '—'}</td>
                <td className="act"><div className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                  {editable && (it.status === 'connected'
                    ? <Button size="xs" icon={<PlugZap size={13} />} loading={busy === `${it.key}:test`} onClick={() => run(it, 'test')}>Test</Button>
                    : <Button size="xs" variant="primary" icon={<Plug size={13} />} loading={busy === `${it.key}:reconnect`} onClick={() => run(it, 'reconnect')}>Reconnect</Button>)}
                  <Menu items={[
                    { label: 'View log', icon: <FileText size={15} />, onClick: () => setLogs(it) },
                    { label: 'Sync now', icon: <RefreshCw size={15} />, onClick: () => run(it, 'sync'), hidden: !editable || it.status !== 'connected' },
                    { label: 'Reconnect', icon: <Plug size={15} />, onClick: () => run(it, 'reconnect'), hidden: !editable || it.status !== 'connected' },
                    { label: 'Simulate provider error', icon: <AlertTriangle size={15} />, onClick: () => run(it, 'simulate-error'), hidden: !editable || it.status === 'error' },
                    { sep: true, hidden: !editable },
                    { label: 'Disconnect', icon: <Unplug size={15} />, danger: true, onClick: () => run(it, 'disconnect'), hidden: !editable || it.status === 'disconnected' },
                  ]} />
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      ))}
      <Drawer open={!!logs} onClose={() => setLogs(null)} title={logs ? `${logs.provider} — log` : ''} wide>
        {logs && <DataTable<any> noCard urlState={false} endpoint={`/api/v1/integrations/${logs.key}/logs`} exportName={`integration-${logs.key}-log`} filters={[{ key: 'level', label: 'Level', options: opts(['info', 'warn', 'error']) }]}
          emptyTitle="No log entries" emptyText="Tests, syncs, reconnects and errors are recorded here."
          columns={[{ key: 'created_at', label: 'When', render: r => dateTime(r.created_at), mobile: 'subtitle' }, { key: 'level', label: 'Level', render: r => <StatusPill status={r.level === 'info' ? 'connected' : r.level} label={r.level} /> }, { key: 'message', label: 'Message', mobile: 'title' }, { key: 'by', label: 'By', render: r => r.meta?.by ?? 'System' }]} />}
      </Drawer>
    </div>
  );
}
