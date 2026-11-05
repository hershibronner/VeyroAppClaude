// Shared conversation UI (agency inbox + client/worker portals).
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Send, MessageSquare, Users, Search } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { api } from '../../lib/api';
import { realtime } from '../../lib/realtime';
import { toast } from '../../lib/toast';
import { dateTime, relTime, humanize } from '../../lib/format';
import { Avatar, Button, EmptyState, ErrorState, LoadingBlock, Skeleton, StatusPill } from '../../components/ui';
import '../home/insights.css';

export interface ThreadsConfig { listUrl: string; detailUrl: (id: string) => string; postUrl: (id: string) => string; agency: boolean; kinds?: { key: string; label: string }[] }

const RELATED_LINK: Record<string, (id: string) => string> = { company: id => `/crm/clients/${id}`, worker: id => `/workforce/workers/${id}`, candidate: id => `/recruiting/candidates/${id}`, placement: id => `/workforce/placements/${id}` };

export function ThreadsApp({ cfg, reloadKey, toolbar }: { cfg: ThreadsConfig; reloadKey?: unknown; toolbar?: React.ReactNode }) {
  const [sp, setSp] = useSearchParams();
  const selected = sp.get('thread');
  const [kind, setKind] = useState('');
  const [unread, setUnread] = useState(false);
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search, 300);
  const [tick, setTick] = useState(0);
  const qs = new URLSearchParams({ pageSize: '100', ...(kind ? { kind } : {}), ...(unread ? { unread: 'true' } : {}), ...(dsearch ? { search: dsearch } : {}) });
  const list = useApi<{ rows: any[]; counts?: Record<string, number> }>(`${cfg.listUrl}?${qs}`, [tick, reloadKey]);
  useEffect(() => realtime.on('notification', (n: any) => { if (n?.event === 'message') setTick(t => t + 1); }), []);
  const select = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('thread', id); else n.delete('thread'); setSp(n, { replace: !id }); };
  const rows = list.data?.rows ?? [];
  return (
    <div className={`card ins-inbox ${selected ? 'has-thread' : ''}`}>
      <div className="ins-inbox-list">
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }} className="stack">
          <div className="row" style={{ gap: 8 }}>
            <div className="search-input" style={{ flex: 1 }}><Search size={16} /><input className="input input-sm" aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)} /></div>
            {toolbar}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {cfg.kinds && <select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Conversation type" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="">All conversations</option>
              {cfg.kinds.map(k => <option key={k.key} value={k.key}>{k.label}{list.data?.counts?.[k.key] !== undefined ? ` (${list.data.counts[k.key]})` : ''}</option>)}
            </select>}
            <label className="check small"><input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} /> Unread only</label>
          </div>
        </div>
        <div className="scroll">
          {list.error && !list.data ? <div style={{ padding: 12 }}><ErrorState error={list.error} retry={list.reload} /></div> : !list.data ? <div style={{ padding: 12 }}><Skeleton h={56} /><Skeleton h={56} style={{ marginTop: 8 }} /></div> : rows.length === 0 ? <EmptyState icon={<MessageSquare size={22} />} title={search || unread || kind ? 'No matching conversations' : 'No conversations yet'} text={!search && !unread && !kind ? 'Start a conversation to see it here.' : undefined} /> : rows.map(t => {
            const other = (t.others ?? [])[0];
            return (
              <button key={t.id} className={`ins-thread-row ${t.id === selected ? 'on' : ''} ${t.unread ? 'unread' : ''}`} onClick={() => select(t.id)}>
                <Avatar name={other?.name ?? t.subject} color={other?.color} size={34} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}><span className="sub truncate">{t.subject}</span><span className="tiny muted nowrap">{relTime(t.last_message_at)}</span></div>
                  <div className="small muted truncate">{(t.others ?? []).map((o: any) => o.name).join(', ') || 'Only you'}{cfg.agency && t.kind !== 'internal' ? ` · ${humanize(t.kind)}` : ''}</div>
                  {t.last_message && <div className="pv">{t.last_message.author ? `${t.last_message.author.split(' ')[0]}: ` : ''}{t.last_message.body}</div>}
                </div>
                {t.unread > 0 && <span className="pill pill-blue" aria-label={`${t.unread} unread`}>{t.unread}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="ins-thread">
        {selected ? <ThreadView key={selected} id={selected} cfg={cfg} tick={tick} onBack={() => select(null)} onSent={() => setTick(t => t + 1)} /> : <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><EmptyState icon={<MessageSquare size={22} />} title="Select a conversation" text="Pick a conversation on the left, or start a new one." /></div>}
      </div>
    </div>
  );
}

function ThreadView({ id, cfg, tick, onBack, onSent }: { id: string; cfg: ThreadsConfig; tick: number; onBack: () => void; onSent: () => void }) {
  const st = useApi<any>(cfg.detailUrl(id), [tick]);
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState('in_app');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const t = st.data;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [t?.messages?.length]);
  const send = async () => {
    if (!body.trim()) return;
    setSending(true);
    try { await api.post(cfg.postUrl(id), cfg.agency ? { body, channel } : { body }); setBody(''); st.reload(); onSent(); if (channel !== 'in_app') toast.success(`Also sent by ${channel === 'in_app' ? 'app' : channel.toUpperCase()} — see the Dev Outbox`); }
    catch (e) { toast.error(e); } finally { setSending(false); }
  };
  if (st.error && !t) return <div style={{ padding: 18 }}><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!t) return <LoadingBlock rows={6} />;
  const others = t.participants.filter((p: any) => p.id !== t.me);
  return (<>
    <div className="ins-thread-h">
      <div className="row" style={{ gap: 10, minWidth: 0 }}>
        <button className="icon-btn mobile-only" aria-label="Back to conversations" onClick={onBack}><ArrowLeft size={18} /></button>
        <div style={{ minWidth: 0 }}>
          <div className="bold truncate">{t.subject}</div>
          <div className="small muted truncate"><Users size={12} style={{ verticalAlign: -1 }} /> {others.map((p: any) => `${p.name}${p.kind !== 'agency' ? ` (${p.company_name ?? humanize(p.kind)})` : ''}`).join(', ') || 'Only you'}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        {cfg.agency && t.kind !== 'internal' && <StatusPill status={t.kind} label={humanize(t.kind)} tone="blue" />}
        {cfg.agency && t.related && RELATED_LINK[t.related.type] && <Link className="small" to={RELATED_LINK[t.related.type](t.related.id)}>{t.related.label ?? 'Open record'}</Link>}
      </div>
    </div>
    <div className="ins-msgs" aria-live="polite">
      {t.messages.length === 0 && <div className="muted small" style={{ textAlign: 'center' }}>No messages yet.</div>}
      {t.messages.map((m: any) => {
        const mine = m.author_id === t.me;
        return (
          <div key={m.id} className={`ins-msg ${mine ? 'me' : ''}`}>
            {!mine && <Avatar name={m.author_name} color={m.author_color} size={28} />}
            <div>
              <div className="bub">{m.body}</div>
              <div className="meta">{mine ? 'You' : m.author_name ?? 'System'}{!mine && m.author_kind !== 'agency' ? ` · ${humanize(m.author_kind)}` : ''} · {dateTime(m.created_at)}{m.channel !== 'in_app' ? ` · via ${m.channel}` : ''}</div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
    <div className="ins-composer">
      <textarea className="textarea" aria-label="Message" placeholder="Write a message…" value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
      <div className="stack" style={{ gap: 6 }}>
        {cfg.agency && t.kind !== 'internal' && <select className="select input-sm" aria-label="Send via" value={channel} onChange={e => setChannel(e.target.value)} style={{ width: 120 }}><option value="in_app">In-app</option><option value="email">+ Email</option><option value="sms">+ SMS</option><option value="whatsapp">+ WhatsApp</option></select>}
        <Button variant="primary" icon={<Send size={15} />} loading={sending} disabled={!body.trim()} onClick={send}>Send</Button>
      </div>
    </div>
  </>);
}
