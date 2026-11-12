import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, CheckCheck, Save } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import { realtime } from '../../lib/realtime';
import { toast } from '../../lib/toast';
import { relTime, dateTime, humanize } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Tabs } from '../../components/ui';
import '../home/insights.css';

export function NotificationsPage({ feedUrl, title = 'Notifications' }: { feedUrl: string; title?: string }) {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'inbox' | 'preferences') || 'inbox';
  return (
    <div>
      <PageHeader title={title} sub="Live alerts for the events you care about, and how you want to receive them." />
      <Tabs value={tab} onChange={k => { const n = new URLSearchParams(sp); n.set('tab', k); setSp(n, { replace: true }); }} tabs={[{ key: 'inbox', label: 'All notifications' }, { key: 'preferences', label: 'Preferences' }]} />
      <div className="mt-3">{tab === 'inbox' ? <Feed feedUrl={feedUrl} /> : <NotificationPreferences />}</div>
    </div>
  );
}

function Feed({ feedUrl }: { feedUrl: string }) {
  const nav = useNavigate();
  const [unread, setUnread] = useState(false);
  const [event, setEvent] = useState('');
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const st = useApi<any>(`${feedUrl}?page=${page}&pageSize=30${unread ? '&unread=true' : ''}${event ? `&event=${encodeURIComponent(event)}` : ''}`, [tick]);
  useEffect(() => realtime.on('notification', () => setTick(t => t + 1)), []);
  const d = st.data;
  const open = async (n: any) => {
    if (!n.read_at) await api.post(`/api/v1/notifications/${n.id}/read`).catch(() => {});
    if (n.link) nav(n.link); else setTick(t => t + 1);
  };
  const readAll = async () => { try { await api.post('/api/v1/notifications/read-all'); toast.success('All notifications marked as read'); setTick(t => t + 1); } catch (e) { toast.error(e); } };
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <Card>
      <CardHeader title={d ? `${d.unread} unread` : 'Notifications'} sub={d ? `${d.all} total` : undefined} right={<div className="ins-toolbar">
        <select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Event" value={event} onChange={e => { setEvent(e.target.value); setPage(1); }}><option value="">All events</option>{(d?.events ?? []).map((e: any) => <option key={e.event} value={e.event}>{humanize(e.event.replace(/\./g, ' '))} ({e.n})</option>)}</select>
        <label className="check small"><input type="checkbox" checked={unread} onChange={e => { setUnread(e.target.checked); setPage(1); }} /> Unread only</label>
        <Button size="sm" icon={<CheckCheck size={14} />} disabled={!d?.unread} onClick={readAll}>Mark all read</Button>
      </div>} />
      {st.error && !d ? <div style={{ padding: 16 }}><ErrorState error={st.error} retry={st.reload} /></div> : !d ? <LoadingBlock rows={6} /> : d.rows.length === 0 ? <EmptyState icon={<Bell size={22} />} title={unread || event ? 'No matching notifications' : 'No notifications yet'} /> : (
        <div className="ins-list">
          {d.rows.map((n: any) => (
            <button key={n.id} className="ins-item" style={{ border: 'none', borderTop: '1px solid var(--border-2)', background: n.read_at ? 'none' : 'var(--primary-50)', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => open(n)}>
              <span className={`ins-dot ${n.read_at ? '' : 'info'}`} style={{ background: n.read_at ? 'var(--border)' : undefined }} aria-hidden />
              <div style={{ flex: 1, minWidth: 0 }}><div className="t">{n.title}</div>{n.body && <div className="s">{n.body}</div>}<div className="tiny muted mt-1" title={dateTime(n.created_at)}>{humanize(n.event.replace(/\./g, ' '))} · {relTime(n.created_at)}</div></div>
              {!n.read_at && <span className="pill pill-blue">New</span>}
            </button>
          ))}
        </div>
      )}
      {d && d.total > d.pageSize && <div className="table-foot"><span>Page {page} of {pages}</span><div className="row" style={{ gap: 6 }}><Button size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button><Button size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Button></div></div>}
    </Card>
  );
}

type Pref = { event: string; label: string; group: string; description: string | null; default_email: boolean; in_app: boolean; email: boolean; sms: boolean };
const CHANNELS = [{ key: 'in_app', label: 'In-app' }, { key: 'email', label: 'Email' }, { key: 'sms', label: 'SMS' }] as const;

/** Per-person delivery choices for every event: in-app, email, and SMS (coming soon). */
export function NotificationPreferences() {
  const st = useApi<{ events: Pref[]; groups: string[]; email: string; sms_available: boolean }>('/api/v1/notification-preferences');
  const [rows, setRows] = useState<Pref[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { if (st.data) setRows(st.data.events); }, [st.data]);
  const groups = useMemo(() => (st.data?.groups ?? []).filter(g => rows.some(r => r.group === g)), [rows, st.data]);
  const changed = useMemo(() => rows.filter(r => { const o = st.data?.events.find(x => x.event === r.event); return o && (o.in_app !== r.in_app || o.email !== r.email); }), [rows, st.data]);
  const smsOn = !!st.data?.sms_available;
  const set = (ev: string, k: 'in_app' | 'email' | 'sms', v: boolean) => setRows(rs => rs.map(r => (r.event === ev ? { ...r, [k]: v } : r)));
  const setGroup = (g: string, k: 'in_app' | 'email', v: boolean) => setRows(rs => rs.map(r => (r.group === g ? { ...r, [k]: v } : r)));
  const setAll = (k: 'in_app' | 'email', v: boolean) => setRows(rs => rs.map(r => ({ ...r, [k]: v })));
  const reset = () => setRows(rs => rs.map(r => ({ ...r, in_app: true, email: r.default_email, sms: false })));
  const save = async () => {
    setBusy(true);
    try { await api.put('/api/v1/notification-preferences', { prefs: rows.map(r => ({ event: r.event, in_app: r.in_app, email: r.email, sms: r.sms })) }); toast.success('Notification settings saved'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const ql = q.trim().toLowerCase();
  const visible = (r: Pref) => !ql || r.label.toLowerCase().includes(ql) || r.group.toLowerCase().includes(ql) || (r.description ?? '').toLowerCase().includes(ql);
  const emailCount = rows.filter(r => r.email).length;
  return (
    <div className="stack">
      <Card>
        <CardHeader title="How you get notified" sub={<>In-app alerts show in the bell. Emails go to <b>{st.data.email}</b> — {emailCount} of {rows.length} events are emailed. SMS is coming soon.</>}
          right={<div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={() => setAll('email', false)}>Turn off all emails</Button>
            <Button size="sm" onClick={reset}>Reset to defaults</Button>
            <Button variant="primary" size="sm" icon={<Save size={14} />} loading={busy} disabled={!changed.length && JSON.stringify(rows) === JSON.stringify(st.data.events)} onClick={save}>Save{changed.length ? ` ${changed.length} change${changed.length === 1 ? '' : 's'}` : ''}</Button>
          </div>} />
        <div style={{ padding: '0 18px 14px' }}><input className="input" placeholder="Search events — e.g. lead, timesheet, invoice" value={q} onChange={e => setQ(e.target.value)} aria-label="Search events" /></div>
      </Card>
      {groups.map(g => {
        const list = rows.filter(r => r.group === g && visible(r));
        if (!list.length) return null;
        const all = rows.filter(r => r.group === g);
        return (
          <Card key={g}>
            <div className="ins-table-scroll">
              <table className="table">
                <thead><tr><th>{g}</th>{CHANNELS.map(c => (
                  <th key={c.key} style={{ textAlign: 'center', width: 110 }}>
                    <div>{c.label}{c.key === 'sms' && !smsOn && <span className="pill pill-gray" style={{ marginLeft: 6 }}>Soon</span>}</div>
                    {c.key !== 'sms' && <input type="checkbox" aria-label={`All ${g} — ${c.label}`} checked={all.every(r => r[c.key])} ref={el => { if (el) el.indeterminate = all.some(r => r[c.key]) && !all.every(r => r[c.key]); }} onChange={e => setGroup(g, c.key, e.target.checked)} style={{ marginTop: 4 }} />}
                  </th>))}</tr></thead>
                <tbody>{list.map(r => (
                  <tr key={r.event}>
                    <td><div>{r.label}</div>{r.description && <div className="tiny muted">{r.description}</div>}</td>
                    {CHANNELS.map(c => <td key={c.key} style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${r.label} — ${c.label}`} checked={c.key === 'sms' && !smsOn ? false : r[c.key]} disabled={c.key === 'sms' && !smsOn} title={c.key === 'sms' && !smsOn ? 'SMS notifications are coming soon' : undefined} onChange={e => set(r.event, c.key, e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--primary)' }} /></td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export default function Notifications() { return <NotificationsPage feedUrl="/api/v1/notification-preferences/feed" />; }
