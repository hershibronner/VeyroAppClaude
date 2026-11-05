import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Webhook, RefreshCw, ShieldCheck, ShieldAlert, Radio } from 'lucide-react';
import { useApi, useInterval } from '../../lib/hooks';
import { dateTime, relTime } from '../../lib/format';
import { Button, Card, EmptyState, ErrorState, LoadingBlock, StatusPill } from '../../components/ui';
import { Toggle } from '../home/kit';

/** Local webhook receiver log: every outbound webhook delivered to /api/v1/dev/webhook-receiver/:slug, with HMAC check result. */
export default function WebhookLog() {
  const st = useApi<any[]>('/api/v1/dev/webhook-receiver');
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [event, setEvent] = useState('');
  useInterval(() => st.reload(), live ? 5000 : null);
  useEffect(() => { document.title = 'Webhook receiver · VeyroApp'; }, []);
  const rows = (st.data ?? []).filter(r => !event || r.headers?.['x-veyro-event'] === event);
  const events = [...new Set((st.data ?? []).map(r => r.headers?.['x-veyro-event']).filter(Boolean))] as string[];
  return (
    <div className="ins-public">
      <div className="ins-public-inner" style={{ maxWidth: 1100 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
          <div><div className="row" style={{ gap: 10 }}><Webhook size={22} /><h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Webhook receiver</h1></div><div className="muted small mt-1">A local endpoint for demoing outbound webhooks. Point an endpoint at <code>http://localhost:4100/api/v1/dev/webhook-receiver/&lt;agency-slug&gt;</code>. Signatures are verified with HMAC-SHA256.</div></div>
          <div className="row" style={{ gap: 10 }}>
            <span className="row small" style={{ gap: 8 }}>{live && <Radio size={14} style={{ color: 'var(--success)' }} />}Auto-refresh <Toggle on={live} onChange={setLive} label="Auto-refresh every 5 seconds" /></span>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={st.reload}>Refresh</Button>
            <Link to="/dev/outbox" className="btn btn-sm">Dev Outbox</Link>
          </div>
        </div>
        {events.length > 1 && <div className="mb-3"><select className="select input-sm" style={{ width: 'auto' }} aria-label="Event" value={event} onChange={e => setEvent(e.target.value)}><option value="">All events</option>{events.map(e => <option key={e} value={e}>{e}</option>)}</select></div>}
        {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={6} /> : rows.length === 0 ? <Card><EmptyState icon={<Webhook size={22} />} title="Nothing received yet" text="Deliveries appear here when an event (placement started, invoice paid, …) fires for an agency with a webhook endpoint pointing here." /></Card> : (
          <Card>
            {rows.map(r => (
              <div key={r.id} style={{ borderTop: '1px solid var(--border-2)' }}>
                <button className="ins-thread-row" style={{ borderLeft: 'none' }} onClick={() => setOpen(o => (o === r.id ? null : r.id))} aria-expanded={open === r.id}>
                  <span className="tl-ic">{r.signature_valid ? <ShieldCheck size={15} style={{ color: 'var(--success)' }} /> : <ShieldAlert size={15} style={{ color: 'var(--danger)' }} />}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}><span className="sub">{r.headers?.['x-veyro-event'] ?? 'unknown event'}</span><span className="tiny muted" title={dateTime(r.received_at)}>{relTime(r.received_at)}</span></div>
                    <div className="small muted truncate">POST {r.path} · delivery {String(r.headers?.['x-veyro-delivery'] ?? '—').slice(0, 13)}</div>
                  </div>
                  <StatusPill status={r.signature_valid ? 'verified' : 'failed'} label={r.signature_valid ? 'Signature valid' : 'Signature invalid'} />
                </button>
                {open === r.id && <div style={{ padding: '0 16px 16px' }}><div className="small bold mb-2">Headers</div><pre className="ins-pre">{JSON.stringify(r.headers, null, 2)}</pre><div className="small bold mt-2 mb-2">Body</div><pre className="ins-pre">{JSON.stringify(r.body, null, 2)}</pre></div>}
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
