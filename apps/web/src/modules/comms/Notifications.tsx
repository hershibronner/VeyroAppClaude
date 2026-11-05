import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, CheckCheck, Save, BellOff } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import { realtime } from '../../lib/realtime';
import { toast } from '../../lib/toast';
import { relTime, dateTime, humanize } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Tabs, Banner } from '../../components/ui';
import '../home/insights.css';

export function NotificationsPage({ feedUrl, title = 'Notifications' }: { feedUrl: string; title?: string }) {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'inbox' | 'preferences') || 'inbox';
  return (
    <div>
      <PageHeader title={title} sub="Live alerts for the events you care about, and how you want to receive them." />
      <Tabs value={tab} onChange={k => { const n = new URLSearchParams(sp); n.set('tab', k); setSp(n, { replace: true }); }} tabs={[{ key: 'inbox', label: 'All notifications' }, { key: 'preferences', label: 'Preferences' }]} />
      <div className="mt-3">{tab === 'inbox' ? <Feed feedUrl={feedUrl} /> : <Preferences />}</div>
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

function Preferences() {
  const st = useApi<{ events: { event: string; label: string; group: string; in_app: boolean; email: boolean; push: boolean }[] }>('/api/v1/notification-preferences');
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setRows(st.data.events); }, [st.data]);
  const groups = useMemo(() => [...new Set(rows.map(r => r.group))], [rows]);
  const dirty = st.data && JSON.stringify(st.data.events) !== JSON.stringify(rows);
  const pushState = typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
  const set = async (ev: string, k: 'in_app' | 'email' | 'push', v: boolean) => {
    if (k === 'push' && v && 'Notification' in window && Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') toast.info('Browser notifications were not allowed — push will be logged but your browser will not show it.');
    }
    setRows(rs => rs.map(r => (r.event === ev ? { ...r, [k]: v } : r)));
  };
  const save = async () => {
    setBusy(true);
    try { await api.put('/api/v1/notification-preferences', { prefs: rows.map(r => ({ event: r.event, in_app: r.in_app, email: r.email, push: r.push })) }); toast.success('Preferences saved'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  return (
    <Card>
      <CardHeader title="Delivery preferences" sub="In-app shows in the bell and here. Email copies go to your inbox (Dev Outbox in demo mode)." right={<Button variant="primary" icon={<Save size={15} />} loading={busy} disabled={!dirty} onClick={save}>Save preferences</Button>} />
      {pushState === 'denied' && <div style={{ padding: '0 18px' }}><Banner tone="warn" icon={<BellOff size={18} />}>Browser notifications are blocked for this site. Allow them in your browser settings to receive push alerts.</Banner></div>}
      <div className="ins-table-scroll">
        <table className="table">
          <thead><tr><th>Event</th><th style={{ textAlign: 'center' }}>In-app</th><th style={{ textAlign: 'center' }}>Email</th><th style={{ textAlign: 'center' }}>Push</th></tr></thead>
          <tbody>{groups.map(g => [
            <tr key={g}><td colSpan={4} className="tiny muted bold" style={{ textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--bg-2)' }}>{g}</td></tr>,
            ...rows.filter(r => r.group === g).map(r => (
              <tr key={r.event}>
                <td>{r.label}</td>
                {(['in_app', 'email', 'push'] as const).map(k => <td key={k} style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${r.label} — ${k.replace('_', '-')}`} checked={r[k]} onChange={e => set(r.event, k, e.target.checked)} /></td>)}
              </tr>
            )),
          ])}</tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Notifications() { return <NotificationsPage feedUrl="/api/v1/notification-preferences/feed" />; }
