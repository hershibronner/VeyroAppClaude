import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail, MessageSquare, Smartphone, Bell, Inbox, ExternalLink, RefreshCw, Radio } from 'lucide-react';
import { useApi, useDebounced, useInterval } from '../../lib/hooks';
import { dateTime, relTime, humanize } from '../../lib/format';
import { Button, Card, EmptyState, ErrorState, LoadingBlock, Segmented, SearchInput, StatusPill, KV } from '../../components/ui';
import { Toggle } from '../home/kit';

const ICON: Record<string, any> = { email: Mail, sms: Smartphone, whatsapp: MessageSquare, push: Bell };

/** Dev Outbox: every simulated email / SMS / WhatsApp / push, rendered exactly as sent. Links are live. */
export default function Outbox() {
  const [sp, setSp] = useSearchParams();
  const [channel, setChannel] = useState(sp.get('channel') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);
  const dTo = useDebounced(to, 300), dSearch = useDebounced(search, 300);
  const qs = new URLSearchParams({ pageSize: '100', ...(channel ? { channel } : {}), ...(dTo ? { to: dTo } : {}), ...(dSearch ? { search: dSearch } : {}) });
  const st = useApi<{ rows: any[]; total: number }>(`/api/v1/dev/outbox?${qs}`);
  useInterval(() => st.reload(), live ? 5000 : null);
  const rows = st.data?.rows ?? [];
  const selId = sp.get('id');
  const sel = rows.find(r => r.id === selId) ?? rows[0] ?? null;
  useEffect(() => { document.title = 'Dev Outbox · VeyroApp'; }, []);
  const pick = (id: string) => { const n = new URLSearchParams(sp); n.set('id', id); setSp(n, { replace: true }); };
  const links = useMemo(() => (sel?.body_text ? [...new Set((sel.body_text.match(/https?:\/\/[^\s<>"')]+/g) ?? []) as string[])] : []), [sel?.id]);
  const srcDoc = sel?.body_html ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:24px;background:#fff}a{color:#345CFF}</style></head><body>${sel.body_html}</body></html>` : '';
  return (
    <div className="ins-public">
      <div className="ins-public-inner" style={{ maxWidth: 1280 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
          <div><div className="row" style={{ gap: 10 }}><Inbox size={22} /><h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Dev Outbox</h1></div><div className="muted small mt-1">Demo mode: emails, SMS, WhatsApp and push messages are captured here instead of being delivered. {st.data ? `${st.data.total.toLocaleString()} message${st.data.total === 1 ? '' : 's'}` : ''}</div></div>
          <div className="row" style={{ gap: 10 }}>
            <span className="row small" style={{ gap: 8 }}>{live && <Radio size={14} style={{ color: 'var(--success)' }} />}Auto-refresh <Toggle on={live} onChange={setLive} label="Auto-refresh every 5 seconds" /></span>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={st.reload}>Refresh</Button>
            <Link to="/dev/webhooks" className="btn btn-sm">Webhook receiver</Link>
            <Link to="/login" className="btn btn-sm">Sign in</Link>
          </div>
        </div>
        <div className="ins-toolbar mb-3">
          <Segmented options={[{ key: '', label: 'All' }, { key: 'email', label: 'Email' }, { key: 'sms', label: 'SMS' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'push', label: 'Push' }]} value={channel} onChange={k => setChannel(k)} />
          <input className="input input-sm" style={{ width: 220 }} aria-label="Filter by recipient" placeholder="Recipient (e.g. worker@veyro.demo)" value={to} onChange={e => setTo(e.target.value)} />
          <SearchInput value={search} onChange={setSearch} placeholder="Search subject or body" />
        </div>
        {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={8} /> : rows.length === 0 ? <Card><EmptyState icon={<Inbox size={22} />} title="No messages yet" text="Invitations, password resets, invoices, reminders and automation emails will appear here the moment they are sent." /></Card> : (
          <div className="ins-outbox">
            <Card style={{ maxHeight: 720, overflowY: 'auto' }}>
              {rows.map(m => { const Ic = ICON[m.channel] ?? Mail; return (
                <button key={m.id} className={`ins-thread-row ${sel?.id === m.id ? 'on' : ''}`} onClick={() => pick(m.id)}>
                  <span className="tl-ic"><Ic size={15} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}><span className="sub truncate">{m.subject || (m.body_text ?? '').slice(0, 60)}</span><span className="tiny muted nowrap">{relTime(m.created_at)}</span></div>
                    <div className="small muted truncate">To {m.to_address}{m.org_name ? ` · ${m.org_name}` : ''}</div>
                  </div>
                </button>
              ); })}
            </Card>
            {sel && (
              <Card pad style={{ minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0, fontSize: 19 }}>{sel.subject || `${humanize(sel.channel)} message`}</h2><StatusPill status={sel.channel} label={humanize(sel.channel)} tone="blue" /></div>
                <div className="mt-2 mb-3"><KV items={[['From', sel.from_name ?? 'VeyroApp'], ['To', sel.to_address], ['Sent', dateTime(sel.created_at)], ['Template', sel.template_key ? humanize(sel.template_key) : '—'], ['Agency', sel.org_name ?? 'Platform']]} /></div>
                {links.length > 0 && <div className="mb-3"><div className="small bold mb-2">Links in this message</div><div className="stack" style={{ gap: 4 }}>{links.map(l => <a key={l} href={l} target="_blank" rel="noreferrer" className="small row" style={{ gap: 6, overflowWrap: 'anywhere' }}><ExternalLink size={13} style={{ flex: 'none' }} />{l}</a>)}</div></div>}
                {sel.channel === 'email' && sel.body_html ? <iframe title="Rendered email" className="ins-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} /> : <div className={`ins-sms ${sel.channel}`}>{sel.body_text}</div>}
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
