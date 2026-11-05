import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, KeyRound, Pencil, Plus, Power, RefreshCw, RotateCcw, Send, Trash2, Webhook } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Dialog, Drawer, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, StatusPill, Tabs, useConfirm, KV } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { FormDrawer } from '../../components/FormDrawer';
import { Gate, ReadOnlyNote, CopyField } from './common';

export default function ApiSettings() {
  return <Gate resource="integrations">{editable => <Inner editable={editable} />}</Gate>;
}

function Inner({ editable }: { editable: boolean }) {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const tab = (sp.get('tab') as 'keys' | 'webhooks' | 'deliveries') || 'keys';
  const keys = useApi<any[]>('/api/v1/api-keys');
  const hooks = useApi<any>('/api/v1/webhooks');
  const events = useApi<any[]>('/api/v1/webhooks/events');
  const [newKey, setNewKey] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [rk, setRk] = useState(0);
  const confirm = useConfirm();
  const activeKeys = (keys.data ?? []).filter(k => !k.revoked_at).length;
  const evOpts = (events.data ?? []).map(e => ({ value: e.key, label: `${e.label} (${e.key})` }));
  return (
    <div className="stack">
      <PageHeader title="API & Webhooks" sub="Connect VeyroApp to your other tools with the versioned REST API (/api/v1) and signed outbound webhooks."
        actions={<><Button icon={<BookOpen size={16} />} onClick={() => nav('/settings/api/docs')}>API docs</Button>{editable && (tab === 'keys' ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setNewKey(true)}>Create API key</Button> : <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit({ events: ['placement.started'], url: hooks.data?.receiver_url ?? '' })}>Add endpoint</Button>)}</>} />
      <ReadOnlyNote show={!editable} />
      <Tabs value={tab} onChange={k => setSp({ tab: k })} tabs={[{ key: 'keys', label: 'API keys', count: activeKeys }, { key: 'webhooks', label: 'Webhook endpoints', count: hooks.data?.rows.length }, { key: 'deliveries', label: 'Delivery log' }]} />
      {tab === 'keys' && (keys.error && !keys.data ? <ErrorState error={keys.error} retry={keys.reload} /> : !keys.data ? <Card><LoadingBlock /></Card> : (
        <Card>
          <CardHeader title="API keys" sub="Send as Authorization: Bearer vk_… — a key acts with the permissions of the person who created it, inside this workspace only. Rate limit: 120 requests/minute." />
          {keys.data.length === 0 ? <EmptyState icon={<KeyRound size={22} />} title="No API keys" text="Create a key to call the API from scripts, Zapier or your data warehouse." /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead><tbody>
              {keys.data.map(k => (
                <tr key={k.id}>
                  <td className="bold">{k.name}<div className="tiny muted">by {k.created_by_name ?? '—'}</div></td><td className="mono small">{k.prefix}…</td>
                  <td><div className="chips">{k.scopes.map((s: string) => <span key={s} className="chip">{s}</span>)}</div></td>
                  <td>{dateTime(k.created_at)}</td><td>{k.last_used_at ? relTime(k.last_used_at) : <span className="muted">Never</span>}</td>
                  <td>{k.revoked_at ? <StatusPill status="revoked" label={`Revoked ${relTime(k.revoked_at)}`} /> : <StatusPill status="active" />}</td>
                  <td className="act">{editable && !k.revoked_at && <Menu items={[{ label: 'Revoke key', icon: <Trash2 size={15} />, danger: true, onClick: async () => { const c = await confirm({ title: `Revoke ${k.name}?`, body: 'Apps using this key will get 401 errors immediately. This cannot be undone.', danger: true, confirmLabel: 'Revoke' }); if (!c.ok) return; try { await api.post(`/api/v1/api-keys/${k.id}/revoke`); toast.success('Key revoked'); keys.reload(); } catch (e) { toast.error(e); } } }]} />}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          <div className="card-b"><div className="small bold mb-2">Try it</div><pre className="st-code">{`curl -H "Authorization: Bearer vk_your_key" \\\n  ${window.location.origin.replace(':3100', ':4100')}/api/v1/team/summary`}</pre></div>
        </Card>
      ))}
      {tab === 'webhooks' && (hooks.error && !hooks.data ? <ErrorState error={hooks.error} retry={hooks.reload} /> : !hooks.data ? <Card><LoadingBlock /></Card> : (
        <>
          <Banner icon={<Webhook size={18} />}>Every delivery is a POST with JSON body, signed with <b>HMAC-SHA256</b> (hex) of the raw body in <code>x-veyro-signature</code>, plus <code>x-veyro-event</code> and <code>x-veyro-delivery</code>. Failed deliveries retry after 10s, 30s, 2m, 10m and 30m. For demos, point an endpoint at the local receiver: <b>{hooks.data.receiver_url}</b> and watch it at <a href="/dev/webhooks" target="_blank" rel="noreferrer">/dev/webhooks</a>.</Banner>
          {hooks.data.rows.length === 0 ? <Card><EmptyState icon={<Webhook size={22} />} title="No endpoints" text="Add an endpoint to receive events like placement.started or invoice.paid." /></Card> : hooks.data.rows.map((e: any) => (
            <Card key={e.id}>
              <CardHeader title={<span className="mono" style={{ fontSize: 14 }}>{e.url}</span>} sub={`${e.description ?? 'No description'} · signing secret ${e.secret_prefix}…`}
                right={<><StatusPill status={e.active ? 'active' : 'disabled'} label={e.active ? 'Active' : 'Disabled'} />{editable && <Button size="sm" icon={<Send size={14} />} onClick={async () => { try { await api.post(`/api/v1/webhooks/${e.id}/test`); toast.success('Test event queued — check the delivery log'); setTimeout(() => { hooks.reload(); setRk(k => k + 1); }, 1500); } catch (err) { toast.error(err); } }}>Send test event</Button>}
                  {editable && <Menu items={[
                    { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setEdit(e) },
                    { label: 'View deliveries', icon: <RefreshCw size={15} />, onClick: () => setSp({ tab: 'deliveries', endpoint_id: e.id }) },
                    { label: e.active ? 'Disable' : 'Enable', icon: <Power size={15} />, onClick: async () => { try { await api.patch(`/api/v1/webhooks/${e.id}`, { active: !e.active }); hooks.reload(); } catch (err) { toast.error(err); } } },
                    { label: 'Rotate signing secret', icon: <RotateCcw size={15} />, onClick: async () => { const c = await confirm({ title: 'Rotate signing secret?', body: 'The old secret stops working immediately. Update your receiver with the new one.', confirmLabel: 'Rotate' }); if (!c.ok) return; try { const r = await api.post(`/api/v1/webhooks/${e.id}/rotate-secret`); setSecret({ title: 'New signing secret', value: r.secret, note: r.note }); } catch (err) { toast.error(err); } } },
                    { sep: true },
                    { label: 'Delete endpoint', icon: <Trash2 size={15} />, danger: true, onClick: async () => { const c = await confirm({ title: 'Delete this endpoint?', body: 'Its delivery history is deleted too.', danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/webhooks/${e.id}`); toast.success('Endpoint deleted'); hooks.reload(); } catch (err) { toast.error(err); } } },
                  ]} />}</>} />
              <div className="card-b row" style={{ justifyContent: 'space-between' }}>
                <div className="chips">{e.events.map((x: string) => <span key={x} className="chip mono">{x}</span>)}</div>
                <div className="small muted">{e.deliveries_7d} deliveries in 7 days{e.failed_7d ? <> · <b style={{ color: 'var(--danger)' }}>{e.failed_7d} failed</b></> : ''}{e.last_delivery_at ? ` · last ${relTime(e.last_delivery_at)}` : ''}</div>
              </div>
            </Card>
          ))}
        </>
      ))}
      {tab === 'deliveries' && <DataTable<any> title="Delivery log" endpoint="/api/v1/webhooks/deliveries" reloadKey={rk} exportName="webhook-deliveries" onRowClick={r => setDelivery(r.id)}
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'delivered', 'retrying', 'failed']) }, { key: 'event', label: 'Event', options: (events.data ?? []).filter(e => e.key !== '*').map(e => ({ value: e.key, label: e.key })) }, { key: 'endpoint_id', label: 'Endpoint', options: (hooks.data?.rows ?? []).map((e: any) => ({ value: e.id, label: e.url.replace(/^https?:\/\//, '').slice(0, 40) })) }]}
        emptyTitle="No deliveries yet" emptyText="Events are delivered as they happen across VeyroApp. Use “Send test event” to try it."
        columns={[
          { key: 'event', label: 'Event', sortable: true, mobile: 'title', render: r => <span className="mono small">{r.event}</span> },
          { key: 'endpoint_url', label: 'Endpoint', mobile: 'subtitle', render: r => <span className="small truncate" style={{ maxWidth: 280, display: 'inline-block' }}>{r.endpoint_url}</span> },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
          { key: 'response_code', label: 'Response', render: r => r.response_code ?? '—' },
          { key: 'attempts', label: 'Attempts', sortable: true, align: 'right' },
          { key: 'created_at', label: 'Created', sortable: true, render: r => dateTime(r.created_at) },
          { key: 'next_attempt_at', label: 'Next retry', render: r => r.status === 'retrying' && r.next_attempt_at ? relTime(r.next_attempt_at) : '—' },
        ]}
        rowActions={(r, reload) => [{ label: 'Replay delivery', icon: <RotateCcw size={15} />, hidden: !editable, onClick: async () => { try { await api.post(`/api/v1/webhooks/deliveries/${r.id}/replay`); toast.success('Replayed with the same idempotency key'); setTimeout(reload, 1500); } catch (e) { toast.error(e); } } }]} />}
      <FormDrawer open={newKey} onClose={() => setNewKey(false)} title="Create API key" submitLabel="Create key" initial={{ write: false }}
        fields={[{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. Data warehouse sync', full: true }, { name: 'write', label: 'Write access', type: 'checkbox', placeholder: 'Allow POST/PATCH/DELETE (default is read-only)' }]}
        onSubmit={async v => { const r = await api.post('/api/v1/api-keys', { name: v.name, scopes: v.write ? ['read', 'write'] : ['read'] }); setSecret({ title: `API key “${r.name}”`, value: r.key, note: r.note }); keys.reload(); }} />
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit endpoint' : 'Add webhook endpoint'} initial={edit ?? {}} submitLabel={edit?.id ? 'Save endpoint' : 'Add endpoint'}
        fields={[{ name: 'url', label: 'Endpoint URL', type: 'url', required: true, full: true, placeholder: 'https://example.com/webhooks/veyro', hint: hooks.data ? `Local demo receiver: ${hooks.data.receiver_url} (it verifies against this agency's first matching endpoint)` : undefined },
          { name: 'description', label: 'Description', full: true },
          { name: 'events', label: 'Events', type: 'custom', required: true, full: true, render: (val: string[] = [], set) => <div className="stack" style={{ gap: 6, maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>{evOpts.map(o => <label key={o.value} className="check small"><input type="checkbox" checked={val.includes(o.value)} onChange={e => set(e.target.checked ? [...val, o.value] : val.filter(x => x !== o.value))} /> {o.label}</label>)}</div> }]}
        onSubmit={async v => { if (edit.id) { await api.patch(`/api/v1/webhooks/${edit.id}`, { url: v.url, events: v.events, description: v.description || null }); toast.success('Endpoint updated'); } else { const r = await api.post('/api/v1/webhooks', { url: v.url, events: v.events, description: v.description || null }); setSecret({ title: 'Signing secret', value: r.secret, note: r.note }); } hooks.reload(); }} />
      <Dialog open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ''} footer={<Button variant="primary" onClick={() => setSecret(null)}>I've copied it</Button>}>
        <Banner tone="warn">{secret?.note}</Banner>
        <div className="mt-2"><CopyField value={secret?.value ?? ''} label="Secret value" /></div>
      </Dialog>
      <DeliveryDrawer id={delivery} onClose={() => setDelivery(null)} />
    </div>
  );
}

function DeliveryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const st = useApi<any>(id ? `/api/v1/webhooks/deliveries/${id}` : null, [id]);
  const d = st.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={d ? d.event : 'Delivery'} wide>
      {!d ? <LoadingBlock /> : <div className="stack" style={{ gap: 14 }}>
        <KV items={[['Status', <StatusPill key="s" status={d.status} />], ['Endpoint', d.endpoint_url], ['Attempts', d.attempts], ['Response code', d.response_code ?? '—'], ['Created', dateTime(d.created_at)], ['Delivered', dateTime(d.delivered_at)], ['Idempotency key', <span key="k" className="mono small">{d.idempotency_key}</span>]]} />
        <div><div className="small bold mb-2">Request headers</div><pre className="st-code">{Object.entries(d.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre></div>
        <div><div className="small bold mb-2">Body</div><pre className="st-code">{JSON.stringify(d.payload, null, 2)}</pre></div>
        <div><div className="small bold mb-2">Response</div><pre className="st-code">{d.response_body || '—'}</pre></div>
      </div>}
    </Drawer>
  );
}
