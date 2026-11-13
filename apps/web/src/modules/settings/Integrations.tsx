import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, FileText, KeyRound, Plug, PlugZap, RefreshCw, Unplug, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Drawer, ErrorState, KpiRow, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { Gate, ReadOnlyNote } from './common';
import { useStripeConnect } from './StripeConnect';

const MODE_CHIP: Record<string, string> = { simulated: 'Simulated', built_in: 'Built in' };

export default function IntegrationsSettings() {
  return <Gate resource="integrations">{editable => <Inner editable={editable} />}</Gate>;
}

function Inner({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[]; editable: boolean; env: 'production' | 'local' }>('/api/v1/integrations');
  const [logs, setLogs] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const stripe = useStripeConnect(() => { toast.success('Stripe connected — clients can now pay invoices by card'); st.reload(); });
  // Back from Stripe Connect (this is the new tab Stripe returned to).
  useEffect(() => {
    const s = params.get('stripe'); if (!s) return;
    const m = params.get('message');
    if (s === 'connected') toast.success('Stripe connected — clients can now pay invoices by card. You can close this tab.'); else if (s === 'cancelled') toast.info(m ?? 'Stripe connection cancelled'); else toast.error(m ?? 'Stripe connection failed');
    params.delete('stripe'); params.delete('message'); setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Integrations" /><Card><LoadingBlock rows={8} /></Card></div>;
  const rows = st.data.rows;
  const local = st.data.env !== 'production';
  const run = async (it: any, action: string) => {
    if (action === 'disconnect') { const c = await confirm({ title: `Disconnect ${it.provider}?`, body: it.key === 'payments' && it.mode === 'live' ? 'Clients will no longer be able to pay invoices by card until you connect Stripe again. Payments already received stay in your Stripe account.' : `${it.category} features that depend on it will show a "disconnected" error until you reconnect.`, danger: true, confirmLabel: 'Disconnect' }); if (!c.ok) return; }
    setBusy(`${it.key}:${action}`);
    try { const r = await api.post(`/api/v1/integrations/${it.key}/${action}`); r.ok ? toast.success(r.message) : toast.error(r.message); st.reload(); }
    catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const available = rows.filter(r => r.mode !== 'unavailable');
  const testable = available.filter(r => r.status === 'connected');
  const counts = { connected: testable.length, error: available.filter(r => r.status === 'error').length, disconnected: available.filter(r => r.status === 'disconnected').length, events: rows.reduce((a, r) => a + r.events_7d, 0) };
  const groups = [...new Set(rows.map(r => r.category))];
  return (
    <div className="stack">
      <PageHeader title="Integrations" sub={local ? 'Every provider is a replaceable adapter. In this local build the ones marked Simulated are stand-ins that log everything they do.' : 'Connect your agency\'s own accounts. Providers marked "Not available yet" are coming soon.'}
        actions={<><Button icon={<KeyRound size={16} />} onClick={() => nav('/settings/api')}>API & Webhooks</Button>{editable && testable.length > 0 && <Button variant="primary" icon={<Zap size={16} />} loading={busy === 'all'} onClick={async () => { setBusy('all'); let ok = 0; for (const r of testable) { const x = await api.post(`/api/v1/integrations/${r.key}/test`).catch(() => null); if (x?.ok) ok++; } toast.success(`${ok} of ${testable.length} connected integrations passed their test`); setBusy(''); st.reload(); }}>Test all</Button>}</>} />
      <ReadOnlyNote show={!editable} />
      {counts.error > 0 && <Banner tone="danger">{counts.error} integration{counts.error === 1 ? ' is' : 's are'} reporting errors: {available.filter(r => r.status === 'error').map(r => r.provider).join(', ')}. Test or reconnect to restore service.</Banner>}
      <KpiRow items={[
        { label: 'Connected', value: counts.connected, icon: <CheckCircle2 size={16} />, deltaText: `of ${available.length} available`, suffix: '' },
        { label: 'Errors', value: counts.error, icon: <AlertTriangle size={16} />, deltaText: counts.error ? 'needs attention' : 'all healthy', suffix: '' },
        { label: 'Not connected', value: counts.disconnected, icon: <Unplug size={16} />, deltaText: 'available to connect', suffix: '' },
        { label: 'Events (7 days)', value: counts.events, icon: <Activity size={16} />, deltaText: 'payments, syncs, tests & errors', suffix: '' },
      ]} />
      {groups.map(g => (
        <Card key={g}>
          <CardHeader title={g} />
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Provider</th><th>Status</th><th>Scopes</th><th>Last sync</th><th style={{ textAlign: 'right' }}>Errors (7d)</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.filter(r => r.category === g).map(it => {
              const off = it.mode === 'unavailable';
              const stripeLive = it.key === 'payments' && it.mode === 'live';
              return (
                <tr key={it.key} style={off ? { opacity: 0.7 } : undefined}>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="bold">{it.provider}</span>{MODE_CHIP[it.mode] && <span className="chip">{MODE_CHIP[it.mode]}</span>}{it.note && !off && <span className="chip">{it.note}</span>}</div>
                    {it.account && <div className="small muted">{it.account.name ?? it.account.id} · {it.account.id}{it.account.livemode ? '' : ' · test data'}</div>}
                    {off && it.note && <div className="small muted">{it.note}</div>}
                    {!off && it.last_error && <div className="small" style={{ color: 'var(--danger)' }}>{it.last_error}</div>}
                  </td>
                  <td>{off ? <StatusPill status="unavailable" tone="gray" label="Not available yet" /> : <StatusPill status={it.status} label={it.status === 'disconnected' && stripeLive ? 'Not connected' : undefined} />}</td>
                  <td><div className="chips">{it.scopes.map((s: string) => <span key={s} className="chip">{s}</span>)}</div></td>
                  <td title={dateTime(it.last_sync_at)}>{!off && it.last_sync_at ? relTime(it.last_sync_at) : '—'}</td>
                  <td className="money">{it.errors_7d || '—'}</td>
                  <td className="act"><div className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                    {editable && !off && (stripeLive && !it.account
                      ? <Button size="xs" variant="primary" icon={<Plug size={13} />} loading={stripe.busy} onClick={stripe.start}>Connect Stripe</Button>
                      : it.status === 'connected' || stripeLive
                        ? <Button size="xs" icon={<PlugZap size={13} />} loading={busy === `${it.key}:test`} onClick={() => run(it, 'test')}>Test</Button>
                        : <Button size="xs" variant="primary" icon={<Plug size={13} />} loading={busy === `${it.key}:reconnect`} onClick={() => run(it, 'reconnect')}>Reconnect</Button>)}
                    <Menu items={[
                      { label: 'View log', icon: <FileText size={15} />, onClick: () => setLogs(it) },
                      { label: 'Open Stripe dashboard', icon: <ExternalLink size={15} />, onClick: () => window.open('https://dashboard.stripe.com/', '_blank', 'noopener'), hidden: !stripeLive || !it.account },
                      { label: stripeLive ? 'Sync payments from Stripe' : 'Sync now', icon: <RefreshCw size={15} />, onClick: () => run(it, 'sync'), hidden: !editable || off || (stripeLive ? !it.account : it.status !== 'connected') },
                      { label: 'Reconnect', icon: <Plug size={15} />, onClick: () => run(it, 'reconnect'), hidden: !editable || off || stripeLive || it.status !== 'connected' },
                      { label: 'Simulate provider error', icon: <AlertTriangle size={15} />, onClick: () => run(it, 'simulate-error'), hidden: !editable || !local || it.mode !== 'simulated' || it.status === 'error' },
                      { sep: true, hidden: !editable || off },
                      { label: 'Disconnect', icon: <Unplug size={15} />, danger: true, onClick: () => run(it, 'disconnect'), hidden: !editable || off || (stripeLive ? !it.account : it.status === 'disconnected') },
                    ]} />
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </Card>
      ))}
      <Drawer open={!!logs} onClose={() => setLogs(null)} title={logs ? `${logs.provider} — log` : ''} wide>
        {logs && <DataTable<any> noCard urlState={false} endpoint={`/api/v1/integrations/${logs.key}/logs`} exportName={`integration-${logs.key}-log`} filters={[{ key: 'level', label: 'Level', options: opts(['info', 'warn', 'error']) }]}
          emptyTitle="No log entries" emptyText="Payments, tests, syncs, connections and errors are recorded here."
          columns={[{ key: 'created_at', label: 'When', render: r => dateTime(r.created_at), mobile: 'subtitle' }, { key: 'level', label: 'Level', render: r => <StatusPill status={r.level === 'info' ? 'connected' : r.level} label={r.level} /> }, { key: 'message', label: 'Message', mobile: 'title' }, { key: 'by', label: 'By', render: r => r.meta?.by ?? 'System' }]} />}
      </Drawer>
      {stripe.modal}
    </div>
  );
}
