import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Building2, CheckCircle2, Clock, Copy, ExternalLink, Inbox, Lock, MessageSquareText, Plus, Search, Send, ShieldAlert, Tag, Trash2, UserCheck, UserRound, X, Zap, Pencil, CircleDot, Hourglass, PanelRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi, useDebounced, useInterval } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize, money, relTime } from '../../lib/format';
import { Avatar, Button, Dialog, EmptyState, ErrorState, Field, LoadingBlock, Menu, StatusPill } from '../../components/ui';
import './helpdesk.css';

/* ───────────────────────── constants & helpers ───────────────────────── */
const VIEWS = [
  { key: 'unassigned', label: 'Unassigned', icon: Inbox },
  { key: 'mine', label: 'Assigned to me', icon: UserCheck },
  { key: 'urgent', label: 'Urgent & high', icon: Zap },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle },
  { key: 'open', label: 'Waiting on us', icon: CircleDot },
  { key: 'waiting', label: 'Waiting on agency', icon: Hourglass },
  { key: 'resolved', label: 'Resolved', icon: CheckCircle2 },
  { key: 'all', label: 'All tickets', icon: MessageSquareText },
] as const;
const STATUSES = [{ v: 'open', l: 'Open' }, { v: 'pending', l: 'Waiting on agency' }, { v: 'resolved', l: 'Resolved' }];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const CATEGORIES = ['general', 'billing', 'bug', 'how_to', 'feature_request', 'data_import', 'security'];
const SORTS = [{ v: '', l: 'Needs attention' }, { v: 'last_activity_at', l: 'Recently updated' }, { v: 'created_at', l: 'Newest' }, { v: 'sla', l: 'SLA due soonest' }];
const statusLabel = (s: string) => STATUSES.find(x => x.v === s)?.l ?? humanize(s);

function dur(ms: number) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
const firstName = (n?: string | null) => (n ?? '').split(/\s+/)[0] || 'there';
const fillMacro = (body: string, t: any) => body.replace(/\{\{\s*first_name\s*\}\}/g, firstName(t.created_by_name)).replace(/\{\{\s*agency\s*\}\}/g, t.org_name ?? 'your agency').replace(/\{\{\s*ticket\s*\}\}/g, `#${t.number}`);
const typing = (e: KeyboardEvent) => { const el = e.target as HTMLElement; return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName); };
const store = { get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }, set: (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ } } };

export function SlaBadge({ state, due, compact }: { state: string; due: string; compact?: boolean }) {
  const left = new Date(due).getTime() - Date.now();
  const map: Record<string, [string, string]> = {
    overdue: ['red', `${compact ? '' : 'Overdue '}${dur(left)}${compact ? ' late' : ''}`],
    due_soon: ['amber', `Due in ${dur(left)}`],
    on_track: ['gray', `Due in ${dur(left)}`],
    breached: ['amber', 'Replied late'],
    met: ['green', 'Responded'],
  };
  const m = map[state];
  if (!m) return null;
  return <span className={`hd-sla hd-sla-${m[0]}`} title={`First-response target: ${dateTime(due)}`}><Clock size={11} />{m[1]}</span>;
}
const PrioDot = ({ p }: { p: string }) => <span className={`hd-prio hd-prio-${p}`} title={`${humanize(p)} priority`} aria-label={`${humanize(p)} priority`} />;

/* ───────────────────────── page ───────────────────────── */
export default function HelpdeskPage() {
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'unassigned';
  const ticketId = sp.get('ticket');
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null || v === '' ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const dq = useDebounced(search, 250);
  const priority = sp.get('priority') ?? '';
  const agency = sp.get('agency') ?? '';
  const sort = sp.get('sort') ?? '';
  const [selected, setSelected] = useState<string[]>([]);
  const [macrosOpen, setMacrosOpen] = useState(false);

  const views = useApi<any>('/api/v1/platform/tickets/views');
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=500&sort=name&dir=asc');
  const qs = new URLSearchParams({ view, pageSize: '200', ...(dq ? { search: dq } : {}), ...(priority ? { priority } : {}), ...(agency ? { organization_id: agency } : {}), ...(sort ? { sort, dir: sort === 'sla' ? 'asc' : 'desc' } : {}) });
  const list = useApi<any>(`/api/v1/platform/tickets?${qs}`, [qs.toString()]);
  const refresh = () => { list.reload(); views.reload(); };
  useInterval(refresh, 30000);
  useEffect(() => { setSelected([]); }, [view, dq, priority, agency]);

  const rows: any[] = list.data?.rows ?? [];
  // Keyboard: j/k move through the list, Esc closes the ticket.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = rows.findIndex(r => r.id === ticketId);
      if (e.key === 'j' || e.key === 'ArrowDown') { const n = rows[Math.min(rows.length - 1, i + 1)]; if (n) { e.preventDefault(); set({ ticket: n.id }); } }
      else if (e.key === 'k' || e.key === 'ArrowUp') { const n = rows[Math.max(0, i - 1)]; if (n && i >= 0) { e.preventDefault(); set({ ticket: n.id }); } }
      else if (e.key === 'Escape' && ticketId) set({ ticket: null });
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const bulk = async (patch: any, msg: string) => { try { const r = await api.post('/api/v1/platform/tickets/bulk', { ids: selected, patch }); toast.success(`${msg} — ${r.changed} ticket${r.changed === 1 ? '' : 's'} updated`); setSelected([]); refresh(); } catch (e) { toast.error(e); } };
  const c = views.data?.counts ?? {};
  const s = views.data?.stats;
  const allChecked = rows.length > 0 && rows.every(r => selected.includes(r.id));

  return (
    <div className={`hd ${ticketId ? 'has-ticket' : ''}`}>
      {/* Views */}
      <aside className="hd-views" aria-label="Ticket views">
        <div className="hd-views-head"><b>Support inbox</b></div>
        <nav>{VIEWS.map(v => <button key={v.key} className={view === v.key ? 'on' : ''} onClick={() => set({ view: v.key, ticket: null })}><v.icon size={16} /><span>{v.label}</span>{c[v.key] > 0 && <em className={v.key === 'overdue' || v.key === 'urgent' ? 'hot' : ''}>{c[v.key]}</em>}</button>)}</nav>
        {s && <div className="hd-stats">
          <div className="lbl">Last 30 days</div>
          <div className="hd-stat"><span>Median first reply</span><b>{s.median_first_response_min == null ? '—' : dur(s.median_first_response_min * 60000)}</b></div>
          <div className="hd-stat"><span>SLA met</span><b>{s.sla_met_pct == null ? '—' : `${s.sla_met_pct}%`}</b></div>
          <div className="hd-stat"><span>Resolved this week</span><b>{s.resolved_7d}</b></div>
        </div>}
        <button className="hd-macros-btn" onClick={() => setMacrosOpen(true)}><MessageSquareText size={15} /> Saved replies</button>
      </aside>

      {/* List */}
      <section className="hd-list" aria-label="Tickets">
        <div className="hd-list-head">
          <select className="select hd-viewpick" aria-label="View" value={view} onChange={e => set({ view: e.target.value, ticket: null })}>{VIEWS.map(v => <option key={v.key} value={v.key}>{v.label}{c[v.key] ? ` (${c[v.key]})` : ''}</option>)}</select>
          <div className="hd-search"><Search size={15} /><input aria-label="Search tickets" placeholder="Search subject, agency, person or #number" value={search} onChange={e => { setSearch(e.target.value); set({ q: e.target.value }); }} />{search && <button aria-label="Clear search" onClick={() => { setSearch(''); set({ q: null }); }}><X size={14} /></button>}</div>
          <div className="hd-filters">
            <select className="select" aria-label="Priority" value={priority} onChange={e => set({ priority: e.target.value })}><option value="">Any priority</option>{PRIORITIES.map(p => <option key={p} value={p}>{humanize(p)}</option>)}</select>
            <select className="select" aria-label="Agency" value={agency} onChange={e => set({ agency: e.target.value })}><option value="">All agencies</option>{(agencies.data?.rows ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <select className="select" aria-label="Sort" value={sort} onChange={e => set({ sort: e.target.value })}>{SORTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          </div>
        </div>
        {selected.length > 0 ? (
          <div className="hd-bulk">
            <label className="check"><input type="checkbox" checked={allChecked} onChange={e => setSelected(e.target.checked ? rows.map(r => r.id) : [])} /> <b>{selected.length} selected</b></label>
            <span style={{ flex: 1 }} />
            <Button size="xs" icon={<UserCheck size={13} />} onClick={() => bulk({ assigned_to: me?.user.id }, 'Assigned to you')}>Assign to me</Button>
            <Menu label="Set status" trigger={<Button size="xs">Status</Button>} items={STATUSES.map(st => ({ label: st.l, onClick: () => bulk({ status: st.v }, `Marked ${st.l.toLowerCase()}`) }))} />
            <Menu label="Set priority" trigger={<Button size="xs">Priority</Button>} items={PRIORITIES.map(p => ({ label: humanize(p), onClick: () => bulk({ priority: p }, `Priority set to ${p}`) }))} />
            <button className="icon-btn" aria-label="Clear selection" onClick={() => setSelected([])}><X size={16} /></button>
          </div>
        ) : (
          <div className="hd-list-meta"><span>{list.data ? `${list.data.total} ticket${list.data.total === 1 ? '' : 's'}` : ' '}</span><span className="row" style={{ gap: 8 }}><span className="tiny muted">j / k to move</span><button className="hd-macros-inline" onClick={() => setMacrosOpen(true)}><MessageSquareText size={13} /> Saved replies</button></span></div>
        )}
        <div className="hd-items">
          {list.error && !list.data ? <ErrorState error={list.error} retry={list.reload} /> : !list.data ? <LoadingBlock rows={6} /> : rows.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={22} />} title={view === 'mine' ? 'Nothing assigned to you' : view === 'unassigned' ? 'Every ticket has an owner' : 'No tickets here'} text={dq || priority || agency ? 'Try clearing the search or filters.' : view === 'resolved' ? undefined : 'Nice — inbox zero for this view.'} />
          ) : rows.map(r => (
            <div key={r.id} role="button" tabIndex={0} className={`hd-item ${r.id === ticketId ? 'on' : ''} ${r.unread ? 'unread' : ''}`} onClick={() => set({ ticket: r.id })} onKeyDown={e => { if (e.key === 'Enter') set({ ticket: r.id }); }}>
              <input type="checkbox" aria-label={`Select ticket #${r.number}`} checked={selected.includes(r.id)} onClick={e => e.stopPropagation()} onChange={e => setSelected(s => e.target.checked ? [...s, r.id] : s.filter(x => x !== r.id))} />
              <div className="hd-item-main">
                <div className="hd-item-top"><PrioDot p={r.priority} /><span className="hd-num">#{r.number}</span><span className="hd-org truncate">{r.org_name ?? 'No agency'}</span><span className="hd-time">{relTime(r.last_activity_at)}</span></div>
                <div className="hd-subj truncate">{r.subject}</div>
                <div className="hd-prev truncate">{r.preview_by === 'note' ? <b className="hd-prev-note"><Lock size={11} /> Note: </b> : r.preview_by === 'staff' ? <b>VeyroApp: </b> : r.created_by_name ? <b>{firstName(r.created_by_name)}: </b> : null}{r.preview}</div>
                <div className="hd-item-meta">
                  <StatusPill status={r.status} label={statusLabel(r.status)} />
                  {r.status !== 'resolved' && <SlaBadge state={r.sla_state} due={r.sla_due_at} compact />}
                  {r.tags?.slice(0, 2).map((t: string) => <span key={t} className="hd-tag">{t}</span>)}
                  <span style={{ flex: 1 }} />
                  {r.assigned_to_name ? <span title={`Assigned to ${r.assigned_to_name}`}><Avatar name={r.assigned_to_name} color={r.assigned_to_color} size={20} /></span> : <span className="tiny muted">Unassigned</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Detail */}
      <section className="hd-detail" aria-label="Ticket">
        {ticketId ? <TicketView key={ticketId} id={ticketId} onBack={() => set({ ticket: null })} onChanged={refresh} />
          : <div className="hd-blank"><MessageSquareText size={28} /><h3>Select a ticket</h3><p>Pick a conversation from the list. Use <kbd>j</kbd> <kbd>k</kbd> to move between tickets and <kbd>r</kbd> to reply.</p></div>}
      </section>

      <MacrosDialog open={macrosOpen} onClose={() => setMacrosOpen(false)} />
    </div>
  );
}

/* ───────────────────────── ticket view ───────────────────────── */
function TicketView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { me } = useAuth();
  const st = useApi<any>(`/api/v1/platform/tickets/${id}`, [id]);
  const macros = useApi<any[]>('/api/v1/platform/support/macros');
  const t = st.data;
  const threadRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = `hd-draft:${id}`;
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState(() => store.get(draftKey));
  const [after, setAfter] = useState<string | null>(null); // null = default for the mode, '' = keep current status
  const [busy, setBusy] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  useInterval(() => { if (!busy) st.reload(); }, 30000);
  useEffect(() => { store.set(draftKey, body); }, [body, draftKey]);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [t?.thread?.length]);
  // r = reply, n = internal note
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (typing(e) || e.metaKey || e.ctrlKey) return; if (e.key === 'r' || e.key === 'n') { e.preventDefault(); setMode(e.key === 'r' ? 'reply' : 'note'); boxRef.current?.focus(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const patch = async (p: any) => { try { await api.patch(`/api/v1/platform/tickets/${id}`, p); st.reload(); onChanged(); } catch (e) { toast.error(e); } };
  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      const status = (after ?? (mode === 'reply' && t.status === 'open' ? 'pending' : '')) || t.status;
      await api.post(`/api/v1/platform/tickets/${id}/replies`, { body, kind: mode, status });
      setBody(''); setAfter(null); store.set(draftKey, '');
      toast.success(mode === 'reply' ? `Reply sent — ${firstName(t.created_by_name)} was notified` : 'Internal note added');
      st.reload(); onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  if (st.error && !t) return <ErrorState error={st.error} retry={st.reload} />;
  if (!t) return <div style={{ padding: 24 }}><LoadingBlock rows={8} /></div>;
  const mine = t.assigned_to === me?.user.id;
  const defaultAfter = mode === 'reply' && t.status === 'open' ? 'pending' : '';

  return (
    <div className="hd-ticket">
      <header className="hd-thead">
        <div className="hd-thead-row">
        <button className="icon-btn hd-back" aria-label="Back to list" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="hd-thead-top"><span className="hd-num">#{t.number}</span><PrioDot p={t.priority} /><span className="tiny muted">{humanize(t.priority)} · {humanize(t.category)}</span>{t.status !== 'resolved' && <SlaBadge state={t.sla_state} due={t.sla_due_at} />}</div>
        <div className="hd-thead-actions">
          <div className="segmented" role="group" aria-label="Status">{STATUSES.map(s => <button key={s.v} className={t.status === s.v ? 'on' : ''} onClick={() => t.status !== s.v && patch({ status: s.v })}>{s.v === 'pending' ? 'Waiting' : s.l}</button>)}</div>
          {!mine && <Button size="sm" icon={<UserCheck size={15} />} onClick={() => patch({ assigned_to: me?.user.id })}>Assign to me</Button>}
          <Button size="sm" className="hd-side-toggle" icon={<PanelRight size={15} />} onClick={() => setSideOpen(o => !o)}>Details</Button>
          <Menu items={[
            { label: 'Copy link', icon: <Copy size={15} />, onClick: () => navigator.clipboard?.writeText(`${location.origin}/platform/tickets?ticket=${t.id}`).then(() => toast.success('Link copied')) },
            { label: 'Open agency', icon: <Building2 size={15} />, hidden: !t.organization_id, onClick: () => { location.href = `/platform/agencies/${t.organization_id}`; } },
            { label: 'Start support session', icon: <ShieldAlert size={15} />, hidden: !t.organization_id || !t.created_by, onClick: () => { location.href = `/platform/impersonation?org=${t.organization_id}&user=${t.created_by}&reason=${encodeURIComponent(`Ticket #${t.number}: ${t.subject}`)}`; } },
            { sep: true, hidden: !t.assigned_to },
            { label: 'Unassign', icon: <UserRound size={15} />, hidden: !t.assigned_to, onClick: () => patch({ assigned_to: null }) },
          ]} />
        </div>
        </div>
        <h2 className="hd-title">{t.subject}</h2>
        <div className="small muted truncate">{t.org_name ?? 'No agency'} · {t.created_by_name ?? 'Unknown'} · opened {relTime(t.created_at)}{t.assigned_to_name ? ` · assigned to ${mine ? 'you' : t.assigned_to_name}` : ' · unassigned'}</div>
      </header>

      <div className={`hd-tbody ${sideOpen ? 'side-open' : ''}`}>
        <div className="hd-convo">
          <div className="hd-thread" ref={threadRef}>
            <Message author={t.created_by_name} color={t.created_by_color} when={t.created_at} body={t.body} side="agency" org={t.org_name} />
            {t.thread.map((m: any) => m.kind === 'event'
              ? <div key={m.id} className="hd-event"><span><b>{m.author_name ?? 'System'}</b> {m.body}</span><time title={dateTime(m.created_at)}>{relTime(m.created_at)}</time></div>
              : <Message key={m.id} author={m.is_staff ? m.author_name : m.author_name} color={m.author_color} when={m.created_at} body={m.body} side={m.kind === 'note' ? 'note' : m.is_staff ? 'staff' : 'agency'} org={t.org_name} />)}
          </div>

          <div className={`hd-composer ${mode}`}>
            <div className="hd-ctabs" role="tablist">
              <button role="tab" aria-selected={mode === 'reply'} className={mode === 'reply' ? 'on' : ''} onClick={() => setMode('reply')}><Send size={14} /> Reply to {firstName(t.created_by_name)}</button>
              <button role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'on' : ''} onClick={() => setMode('note')}><Lock size={14} /> Internal note</button>
              <span style={{ flex: 1 }} />
              {mode === 'reply' && (macros.data?.length ?? 0) > 0 && <Menu align="right" label="Insert saved reply" trigger={<button className="hd-macro-trigger"><MessageSquareText size={14} /> Saved replies</button>} items={(macros.data ?? []).map(m => ({ label: m.title, onClick: () => { setBody(b => (b.trim() ? b.trimEnd() + '\n\n' : '') + fillMacro(m.body, t)); boxRef.current?.focus(); } }))} />}
            </div>
            <textarea ref={boxRef} className="hd-input" value={body} onChange={e => setBody(e.target.value)} rows={4}
              placeholder={mode === 'reply' ? `Write your reply to ${t.created_by_name ?? 'the agency'}…` : 'Add a note only VeyroApp staff can see…'}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
            <div className="hd-cfoot">
              <span className="tiny muted">{mode === 'note' ? <><Lock size={11} /> Not visible to the agency</> : <>{t.created_by_email ?? 'The requester'} gets notified · ⌘↵ to send</>}</span>
              <span style={{ flex: 1 }} />
              <label className="hd-after tiny">then
                <select className="select" aria-label="Status after sending" value={after ?? defaultAfter} onChange={e => setAfter(e.target.value)}>
                  <option value="">Keep {statusLabel(t.status).toLowerCase()}</option>
                  {STATUSES.filter(s => s.v !== t.status).map(s => <option key={s.v} value={s.v}>Mark {s.l.toLowerCase()}</option>)}
                </select>
              </label>
              <Button variant="primary" size="sm" icon={mode === 'reply' ? <Send size={14} /> : <Lock size={14} />} disabled={!body.trim()} loading={busy} onClick={send}>{mode === 'reply' ? 'Send reply' : 'Add note'}</Button>
            </div>
          </div>
        </div>

        <TicketSide t={t} patch={patch} />
      </div>
    </div>
  );
}

function Message({ author, color, when, body, side, org }: { author?: string | null; color?: string | null; when: string; body: string; side: 'agency' | 'staff' | 'note'; org?: string | null }) {
  return (
    <div className={`hd-msg ${side}`}>
      <Avatar name={author ?? '?'} color={side === 'agency' ? color : undefined} size={30} />
      <div className="hd-bubble">
        <div className="hd-msg-head"><b>{author ?? 'Unknown'}</b>{side === 'staff' && <span className="hd-badge">VeyroApp</span>}{side === 'agency' && org && <span className="muted">· {org}</span>}{side === 'note' && <span className="hd-badge note"><Lock size={10} /> Internal note</span>}<time title={dateTime(when)}>{relTime(when)}</time></div>
        <div className="hd-msg-body">{body}</div>
      </div>
    </div>
  );
}

function TicketSide({ t, patch }: { t: any; patch: (p: any) => void }) {
  const [tag, setTag] = useState('');
  const tags = useApi<string[]>('/api/v1/platform/tickets-tags');
  const addTag = () => { const v = tag.trim().toLowerCase().replace(/\s+/g, '-'); if (v && !t.tags.includes(v)) patch({ tags: [...t.tags, v] }); setTag(''); };
  const a = t.agency;
  const firstReply = useMemo(() => {
    if (t.first_response_at) return `${dur(new Date(t.first_response_at).getTime() - new Date(t.created_at).getTime())} after opening`;
    if (t.status === 'resolved') return 'Resolved without a reply';
    const left = new Date(t.sla_due_at).getTime() - Date.now();
    return left < 0 ? `Overdue by ${dur(left)}` : `Due in ${dur(left)}`;
  }, [t]);
  return (
    <aside className="hd-side" aria-label="Ticket details">
      <section>
        <h4>Details</h4>
        <div className="hd-prop"><label htmlFor="hd-pr">Priority</label><select id="hd-pr" className="select" value={t.priority} onChange={e => patch({ priority: e.target.value })}>{PRIORITIES.map(p => <option key={p} value={p}>{humanize(p)}</option>)}</select></div>
        <div className="hd-prop"><label htmlFor="hd-as">Assignee</label><select id="hd-as" className="select" value={t.assigned_to ?? ''} onChange={e => patch({ assigned_to: e.target.value || null })}><option value="">Unassigned</option>{t.admins.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="hd-prop"><label htmlFor="hd-ca">Category</label><select id="hd-ca" className="select" value={t.category} onChange={e => patch({ category: e.target.value })}>{CATEGORIES.map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></div>
        <div className="hd-prop top"><label htmlFor="hd-tg">Tags</label>
          <div className="hd-tags">
            {t.tags.map((x: string) => <span key={x} className="hd-tag">{x}<button aria-label={`Remove tag ${x}`} onClick={() => patch({ tags: t.tags.filter((y: string) => y !== x) })}><X size={11} /></button></span>)}
            <span className="hd-tag-add"><Tag size={12} /><input id="hd-tg" list="hd-tag-list" placeholder="Add tag" value={tag} onChange={e => setTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} onBlur={() => tag && addTag()} /></span>
            <datalist id="hd-tag-list">{(tags.data ?? []).filter(x => !t.tags.includes(x)).map(x => <option key={x} value={x} />)}</datalist>
          </div>
        </div>
      </section>
      <section>
        <h4>Timeline</h4>
        <dl className="hd-dl">
          <dt>First reply</dt><dd className={!t.first_response_at && t.sla_state === 'overdue' ? 'bad' : ''}>{firstReply}</dd>
          <dt>Target</dt><dd>{dateTime(t.sla_due_at)}</dd>
          <dt>Opened</dt><dd>{dateTime(t.created_at)}</dd>
          <dt>Last activity</dt><dd>{relTime(t.last_activity_at)}</dd>
          {t.resolved_at && <><dt>Resolved</dt><dd>{dateTime(t.resolved_at)}</dd></>}
        </dl>
      </section>
      <section>
        <h4>Requester</h4>
        <div className="hd-person"><Avatar name={t.created_by_name ?? '?'} color={t.created_by_color} size={34} /><div style={{ minWidth: 0 }}><div className="bold truncate">{t.created_by_name ?? 'Unknown'}</div>{t.created_by_email && <a className="small truncate" href={`mailto:${t.created_by_email}`}>{t.created_by_email}</a>}</div></div>
        {t.related.length > 0 && <div className="hd-related"><div className="tiny muted">Other tickets from this agency</div>{t.related.map((r: any) => <Link key={r.id} to={`/platform/tickets?ticket=${r.id}`} className="hd-rel"><span className="hd-num">#{r.number}</span><span className="truncate">{r.subject}</span><StatusPill status={r.status} label={r.status === 'pending' ? 'Waiting' : undefined} dot={false} /></Link>)}</div>}
      </section>
      {a && <section>
        <h4>Agency</h4>
        <Link to={`/platform/agencies/${a.id}`} className="hd-agency"><span className="hd-agency-logo">{a.name.split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}</span><span style={{ minWidth: 0 }}><b className="truncate">{a.name}</b><span className="tiny muted">{a.plan_name ?? 'No plan'}{a.comped ? ' · comped' : ''}</span></span><ExternalLink size={13} /></Link>
        <div className="hd-agency-stats">
          <div><span>Status</span><StatusPill status={a.sub_status} /></div>
          <div><span>MRR</span><b>{a.mrr_cents == null ? '—' : money(a.mrr_cents, 'USD', { noCents: true })}</b></div>
          <div><span>Seats</span><b>{a.seats ?? '—'}</b></div>
          <div><span>Staff</span><b>{a.staff}</b></div>
          <div><span>Open tickets</span><b>{a.open_tickets}</b></div>
          <div><span>Customer since</span><b>{new Date(a.created_at).getFullYear()}</b></div>
        </div>
        {t.created_by && <Link className="btn btn-sm btn-block mt-2" to={`/platform/impersonation?org=${a.id}&user=${t.created_by}&reason=${encodeURIComponent(`Ticket #${t.number}: ${t.subject}`)}`}><ShieldAlert size={14} /> View as {firstName(t.created_by_name)}</Link>}
      </section>}
    </aside>
  );
}

/* ───────────────────────── saved replies ───────────────────────── */
function MacrosDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const st = useApi<any[]>(open ? '/api/v1/platform/support/macros' : null, [open]);
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return; setBusy(true);
    try { edit.id ? await api.put(`/api/v1/platform/support/macros/${edit.id}`, edit) : await api.post('/api/v1/platform/support/macros', edit); setEdit(null); st.reload(); toast.success('Saved reply stored'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={() => { setEdit(null); onClose(); }} title="Saved replies" wide
      footer={edit ? <><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={edit.title.trim().length < 2 || edit.body.trim().length < 2} onClick={save}>Save</Button></> : <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit({ title: '', body: '' })}>New saved reply</Button>}>
      {edit ? (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Name" htmlFor="mc-t"><input id="mc-t" className="input" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} placeholder="e.g. Password reset steps" autoFocus /></Field>
          <Field label="Message" htmlFor="mc-b" hint={<>Placeholders: <code>{'{{first_name}}'}</code> <code>{'{{agency}}'}</code> <code>{'{{ticket}}'}</code></>}><textarea id="mc-b" className="textarea" rows={9} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} /></Field>
        </div>
      ) : !st.data ? <LoadingBlock rows={4} /> : st.data.length === 0 ? <EmptyState icon={<MessageSquareText size={22} />} title="No saved replies yet" text="Save answers you send often and insert them with one click." /> : (
        <div className="hd-macro-list">{st.data.map(m => (
          <div key={m.id} className="hd-macro">
            <div style={{ minWidth: 0, flex: 1 }}><b>{m.title}</b><div className="small muted hd-macro-body">{m.body}</div></div>
            <button className="icon-btn" aria-label={`Edit ${m.title}`} onClick={() => setEdit({ id: m.id, title: m.title, body: m.body })}><Pencil size={15} /></button>
            <button className="icon-btn" aria-label={`Delete ${m.title}`} onClick={async () => { try { await api.del(`/api/v1/platform/support/macros/${m.id}`); st.reload(); } catch (e) { toast.error(e); } }}><Trash2 size={15} /></button>
          </div>
        ))}</div>
      )}
    </Dialog>
  );
}
