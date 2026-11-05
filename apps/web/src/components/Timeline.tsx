import { useState } from 'react';
import { Phone, Mail, Users, StickyNote, MessageSquare, RefreshCw, Zap, AtSign } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { relTime, dateTime } from '../lib/format';
import { toast } from '../lib/toast';
import { Button, EmptyState, ErrorState, Segmented, Skeleton, useMembers } from './ui';

const ICONS: Record<string, any> = { call: Phone, email: Mail, meeting: Users, note: StickyNote, message: MessageSquare, status_change: RefreshCw, system: Zap };

/** Activity timeline for any record, with a composer for notes/calls/emails/meetings and @mentions. */
export function Timeline({ type, id, composer = true, reloadKey }: { type: string; id: string; composer?: boolean; reloadKey?: unknown }) {
  const state = useApi<any[]>(`/api/v1/timeline/${type}/${id}`, [reloadKey]);
  const members = useMembers();
  const [kind, setKind] = useState<'note' | 'call' | 'email' | 'meeting'>('note');
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/timeline/${type}/${id}`, { kind, body, mentions: mentions.filter(m => body.includes('@' + (members.data?.find(x => x.id === m)?.name ?? ''))) });
      setBody(''); setMentions([]); state.reload();
      toast.success(kind === 'note' ? 'Note added' : `${kind[0].toUpperCase() + kind.slice(1)} logged`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div>
      {composer && (
        <div className="card" style={{ padding: 14, marginBottom: 14, boxShadow: 'none', background: 'var(--bg-2)' }}>
          <Segmented value={kind} onChange={setKind} options={[{ key: 'note', label: <><StickyNote size={14} /> Note</> }, { key: 'call', label: <><Phone size={14} /> Call</> }, { key: 'email', label: <><Mail size={14} /> Email</> }, { key: 'meeting', label: <><Users size={14} /> Meeting</> }]} />
          <div style={{ position: 'relative' }}>
            <textarea className="textarea mt-2" aria-label="Activity details" placeholder={kind === 'note' ? 'Write a note… type @ to mention a teammate' : `What happened on this ${kind}?`} value={body} onChange={e => { setBody(e.target.value); setShowMention(/@\w*$/.test(e.target.value)); }} />
            {showMention && members.data && (
              <div className="menu left" style={{ top: '100%', maxHeight: 220, overflowY: 'auto' }}>
                {members.data.filter(m => m.name.toLowerCase().includes((body.match(/@(\w*)$/)?.[1] ?? '').toLowerCase())).slice(0, 8).map(m => (
                  <button key={m.id} onClick={() => { setBody(b => b.replace(/@\w*$/, '@' + m.name + ' ')); setMentions(x => [...new Set([...x, m.id])]); setShowMention(false); }}><AtSign size={14} />{m.name} <span className="muted small">{m.role_name}</span></button>
                ))}
              </div>
            )}
          </div>
          <div className="row mt-2" style={{ justifyContent: 'flex-end' }}><Button size="sm" variant="primary" loading={busy} disabled={!body.trim()} onClick={submit}>{kind === 'note' ? 'Add note' : `Log ${kind}`}</Button></div>
        </div>
      )}
      {state.error ? <ErrorState error={state.error} retry={state.reload} /> : !state.data ? <div className="stack" style={{ gap: 10 }}><Skeleton h={40} /><Skeleton h={40} /></div> : state.data.length === 0 ? <EmptyState title="No activity yet" text="Calls, notes, emails and status changes will appear here." /> : (
        <div className="timeline">
          {state.data.map(a => { const Ic = ICONS[a.kind] ?? Zap; return (
            <div key={a.id} className="tl-item">
              <span className="tl-ic"><Ic size={14} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="tl-title">{a.title}</div>
                {a.body && <div className="tl-body">{a.body}</div>}
                <div className="tl-meta" title={dateTime(a.created_at)}>{a.actor_name ?? 'System'} · {relTime(a.created_at)}</div>
              </div>
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}
