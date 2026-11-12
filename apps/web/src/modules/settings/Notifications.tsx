import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { NotificationPreferences } from '../comms/Notifications';
import { BellOff } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented, Tabs } from '../../components/ui';
import { Gate, ReadOnlyNote } from './common';

export default function NotificationSettings() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const team = can('settings', 'view');
  const tab = team && sp.get('tab') === 'team' ? 'team' : 'mine';
  return (
    <div className="stack">
      <PageHeader title="Notifications" sub="Choose what you hear about, and whether it arrives in the app, by email, or by SMS (coming soon)." />
      {team && <Tabs value={tab} onChange={k => { const n = new URLSearchParams(sp); k === 'team' ? n.set('tab', 'team') : n.delete('tab'); setSp(n, { replace: true }); }} tabs={[{ key: 'mine', label: 'My notifications' }, { key: 'team', label: 'Team subscriptions' }]} />}
      {tab === 'mine' ? <NotificationPreferences /> : <Gate resource="settings">{editable => <Inner editable={editable} />}</Gate>}
    </div>
  );
}

function Inner({ editable }: { editable: boolean }) {
  const st = useApi<any>('/api/v1/settings/notifications');
  const [subs, setSubs] = useState<Set<string>>(new Set());
  const [who, setWho] = useState<'admins' | 'all'>('admins');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setSubs(new Set(st.data.subscriptions)); }, [st.data]);
  const base = useMemo(() => new Set<string>(st.data?.subscriptions ?? []), [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={8} /></Card>;
  const members = st.data.members.filter((m: any) => who === 'all' || ['owner', 'admin', 'management'].includes(m.role_key));
  const groups = [...new Set<string>(st.data.events.map((e: any) => e.group))];
  const changes = [...new Set([...subs, ...base])].filter(k => subs.has(k) !== base.has(k));
  const toggle = (k: string) => setSubs(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const save = async () => {
    setBusy(true);
    try { await api.put('/api/v1/settings/notifications', { changes: changes.map(k => { const [user_id, ...ev] = k.split(':'); return { user_id, event: ev.join(':'), subscribed: subs.has(k) }; }) }); toast.success('Subscriptions saved'); st.reload(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><span className="small muted">Who else hears about agency-wide events, on top of the people directly involved. They receive them through their own channel choices.</span>{editable && <span className="row" style={{ gap: 8 }}><Button disabled={!changes.length} onClick={() => setSubs(new Set(base))}>Discard</Button><Button variant="primary" disabled={!changes.length} loading={busy} onClick={save}>Save {changes.length || ''} change{changes.length === 1 ? '' : 's'}</Button></span>}</div>
      <ReadOnlyNote show={!editable} />
      <Card>
        <CardHeader title="Event subscriptions" sub="Tick a person to send them an event even when they are not directly involved."  right={<Segmented value={who} onChange={setWho} options={[{ key: 'admins', label: 'Owners, admins & management' }, { key: 'all', label: 'All staff' }]} />} />
        <div className="st-matrix">
          <table>
            <thead><tr><th>Event</th><th>Last 30 days</th>{members.map((m: any) => <th key={m.id} title={m.email}><div>{m.name.split(' ')[0]}</div><div className="tiny" style={{ fontWeight: 400 }}>{m.role_name}</div></th>)}</tr></thead>
            <tbody>{groups.map(g => [
              <tr key={g} className="group"><th colSpan={members.length + 2}>{g}</th></tr>,
              ...st.data.events.filter((e: any) => e.group === g).map((e: any) => (
                <tr key={e.key}>
                  <th>{e.label}<div className="tiny muted mono" style={{ fontWeight: 400 }}>{e.key}</div></th>
                  <td style={{ textAlign: 'center' }} className="small">{st.data.counts_30d[e.key] ?? 0}</td>
                  {members.map((m: any) => { const k = `${m.id}:${e.key}`; return <td key={m.id} style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${m.name}: ${e.label}`} disabled={!editable} checked={subs.has(k)} onChange={() => toggle(k)} style={{ width: 16, height: 16, accentColor: 'var(--primary)', outline: subs.has(k) !== base.has(k) ? '2px solid var(--primary)' : undefined }} /></td>; })}
                </tr>
              )),
            ])}</tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader title="Events with no recipients" sub="Logged so nothing is silently dropped. Subscribe someone above to cover these." />
        {st.data.zero_recipient.length === 0 ? <EmptyState icon={<BellOff size={22} />} title="Every event reached someone" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Event</th><th>Title</th></tr></thead><tbody>
            {st.data.zero_recipient.map((z: any, i: number) => <tr key={i}><td>{dateTime(z.created_at)}</td><td className="mono small">{z.meta?.event ?? '—'}</td><td>{z.meta?.title ?? z.message}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
