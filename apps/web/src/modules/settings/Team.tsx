import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, History, KeyRound, Mail, RotateCcw, ShieldCheck, UserMinus, UserPlus, Users, UserCheck, Send, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { date, humanize, relTime } from '../../lib/format';
import { Banner, Button, KpiRow, PageHeader, Person, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { FormDrawer, type FieldDef } from '../../components/FormDrawer';
import { Gate, ReadOnlyNote } from './common';

const SCOPE_LABEL: Record<string, string> = { all: 'All', team: 'Team', assigned: 'Assigned' };

export default function TeamSettings() {
  return <Gate resource="team">{editable => <TeamInner editable={editable} />}</Gate>;
}

function TeamInner({ editable }: { editable: boolean }) {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'members' | 'invitations') || 'members';
  const summary = useApi<any>('/api/v1/team/summary');
  const roles = useApi<any[]>('/api/v1/roles?kind=agency');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [rk, setRk] = useState(0);
  const confirm = useConfirm();
  const reload = () => { setRk(k => k + 1); summary.reload(); };
  const s = summary.data;
  const roleOpts = (roles.data ?? []).filter(r => r.key !== 'owner' || me?.workspace?.role.key === 'owner').map(r => ({ value: r.id, label: r.name }));
  const fields: FieldDef[] = [
    { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'name@youragency.com' },
    { name: 'name', label: 'Full name', placeholder: 'Optional' },
    { name: 'role_id', label: 'Role', type: 'select', required: true, options: roleOpts },
    { name: 'recruiting_scope', label: 'Recruiting scope', type: 'select', required: true, options: [{ value: 'all', label: 'All — read every position & candidate' }, { value: 'team', label: 'Team — positions of their team' }, { value: 'assigned', label: 'Assigned — only positions assigned to them' }], hint: 'Limits which positions and candidates they can work on' },
    { name: 'team', label: 'Team', placeholder: 'e.g. Dental & Medical', type: 'text', hint: s?.teams?.length ? `Existing: ${s.teams.join(', ')}` : undefined },
  ];
  const act = async (r: any, kind: 'suspend' | 'reactivate' | 'remove') => {
    const labels = { suspend: ['Suspend access?', `${r.name} will be signed out of ${me?.workspace?.org.name} immediately. Their records and history stay intact.`, 'Suspend'], reactivate: ['Restore access?', `${r.name} will be able to sign in again with the same role.`, 'Restore'], remove: ['Remove from agency?', `${r.name} loses access and their API keys are revoked. Their activity history remains in the audit log.`, 'Remove'] } as const;
    const [title, body, cta] = labels[kind];
    const res = await confirm({ title, body, danger: kind !== 'reactivate', confirmLabel: cta, reason: kind === 'reactivate' ? undefined : { label: 'Reason (saved to the audit log)', required: kind === 'remove' } });
    if (!res.ok) return;
    try { await api.post(`/api/v1/team/${r.id}/${kind}`, { reason: res.reason || undefined }); toast.success(kind === 'reactivate' ? 'Access restored' : kind === 'suspend' ? 'Member suspended' : 'Member removed'); reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack">
      <PageHeader title="Team & Permissions" sub="Invite staff, set roles and recruiting scope. Changes take effect immediately — no sign-out needed."
        actions={<>{can('roles') && <Button icon={<ShieldCheck size={16} />} onClick={() => nav('/settings/roles')}>Roles matrix</Button>}{editable && can('team', 'create') && <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInvite(true)}>Invite member</Button>}</>} />
      <ReadOnlyNote show={!editable} />
      {s && s.owners === 1 && <Banner>Your agency has <b>one Owner</b>. The last Owner cannot be removed or demoted — promote a second Owner to share full control.</Banner>}
      {s && s.expired > 0 && <Banner tone="warn">{s.expired} invitation{s.expired === 1 ? ' has' : 's have'} expired without being accepted. <a href="#" onClick={e => { e.preventDefault(); setSp({ tab: 'invitations', status: 'expired' }); }}>Review and resend</a>.</Banner>}
      {s && <KpiRow items={[
        { label: 'Active members', value: s.active, icon: <Users size={16} />, deltaText: `${s.active_7d} signed in this week`, suffix: '', onClick: () => setSp({ tab: 'members', status: 'active' }) },
        { label: 'Pending invitations', value: s.pending, icon: <Mail size={16} />, deltaText: s.expired ? `${s.expired} expired` : 'none expired', suffix: '', onClick: () => setSp({ tab: 'invitations', status: 'pending' }) },
        { label: 'Suspended', value: s.suspended, icon: <Ban size={16} />, deltaText: 'access paused', suffix: '', onClick: () => setSp({ tab: 'members', status: 'suspended' }) },
        { label: 'Two-step sign-in', value: s.active ? `${Math.round((s.mfa / s.active) * 100)}%` : '—', icon: <KeyRound size={16} />, deltaText: `${s.mfa} of ${s.active} members`, suffix: '', onClick: () => setSp({ tab: 'members' }) },
      ]} />}
      <Tabs value={tab} onChange={k => setSp({ tab: k })} tabs={[{ key: 'members', label: 'Members', count: s?.active }, { key: 'invitations', label: 'Invitations', count: s?.pending }]} />
      {tab === 'members' ? (
        <DataTable<any> title="Members" endpoint="/api/v1/team" reloadKey={rk} exportName="team" exportResource="team" defaultSort="name" defaultDir="asc"
          filters={[{ key: 'role', label: 'Role', options: (roles.data ?? []).map(r => ({ value: r.key, label: r.name })) }, { key: 'status', label: 'Status', options: opts(['active', 'suspended']) }, { key: 'scope', label: 'Scope', options: opts(['all', 'team', 'assigned']) }, { key: 'team', label: 'Team', options: (s?.teams ?? []).map((t: string) => ({ value: t, label: t })) }]}
          columns={[
            { key: 'name', label: 'Member', sortable: true, mobile: 'title', render: r => <Person name={`${r.name}${r.is_me ? ' (you)' : ''}`} sub={r.email} color={r.avatar_color} /> },
            { key: 'role_name', label: 'Role', sortable: true, mobile: 'subtitle', render: r => <span className="row" style={{ gap: 6 }}>{r.role_name}{r.role_key === 'owner' && <StatusPill status="owner" label="Owner" tone="purple" />}</span> },
            { key: 'recruiting_scope', label: 'Recruiting scope', render: r => SCOPE_LABEL[r.recruiting_scope] ?? humanize(r.recruiting_scope) },
            { key: 'team', label: 'Team', sortable: true },
            { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
            { key: 'mfa_enabled', label: 'Two-step', render: r => r.mfa_enabled ? <StatusPill status="enabled" label="On" /> : <span className="muted">Off</span> },
            { key: 'last_login_at', label: 'Last sign-in', sortable: true, render: r => r.last_login_at ? relTime(r.last_login_at) : <span className="muted">Never</span>, csv: r => r.last_login_at },
          ]}
          rowActions={(r) => [
            { label: 'Change role & scope', icon: <ShieldCheck size={15} />, onClick: () => setEdit(r), hidden: !editable, disabled: r.status !== 'active' },
            { label: 'View audit history', icon: <History size={15} />, onClick: () => nav(`/settings/audit?search=${encodeURIComponent(r.name)}`), hidden: !can('audit') },
            { sep: true, hidden: !editable },
            { label: 'Suspend access', icon: <Ban size={15} />, onClick: () => act(r, 'suspend'), hidden: !editable || r.status !== 'active' || r.is_me },
            { label: 'Restore access', icon: <UserCheck size={15} />, onClick: () => act(r, 'reactivate'), hidden: !editable || r.status !== 'suspended' },
            { label: 'Remove from agency', icon: <UserMinus size={15} />, danger: true, onClick: () => act(r, 'remove'), hidden: !editable || !can('team', 'delete') || r.is_me },
          ]}
        />
      ) : (
        <DataTable<any> title="Invitations" endpoint="/api/v1/invitations" reloadKey={rk} exportName="invitations" filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'expired', 'revoked', 'accepted']) }]}
          emptyTitle="No invitations" emptyText="Invite teammates and they'll appear here until they accept." emptyAction={editable ? <Button size="sm" variant="primary" onClick={() => setInvite(true)}>Invite member</Button> : undefined}
          columns={[
            { key: 'email', label: 'Invitee', sortable: true, mobile: 'title', render: r => <Person name={r.name || r.email} sub={r.name ? r.email : undefined} /> },
            { key: 'role_name', label: 'Role', mobile: 'subtitle' },
            { key: 'recruiting_scope', label: 'Scope', render: r => SCOPE_LABEL[r.recruiting_scope] ?? '—' },
            { key: 'team', label: 'Team' },
            { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
            { key: 'invited_by_name', label: 'Invited by' },
            { key: 'expires_at', label: 'Expires', sortable: true, render: r => r.status === 'pending' ? relTime(r.expires_at) : date(r.expires_at) },
            { key: 'resent_count', label: 'Resent', align: 'right', render: r => r.resent_count ? `${r.resent_count}×` : '—' },
          ]}
          rowActions={(r) => [
            { label: r.status === 'expired' ? 'Send a new invitation' : 'Resend invitation', icon: r.status === 'expired' ? <RotateCcw size={15} /> : <Send size={15} />, hidden: !editable || !['pending', 'expired'].includes(r.status), onClick: async () => { try { await api.post(`/api/v1/invitations/${r.id}/resend`); toast.success(`Invitation re-sent to ${r.email} (new 7-day link)`); reload(); } catch (e) { toast.error(e); } } },
            { label: 'Revoke invitation', icon: <XCircle size={15} />, danger: true, hidden: !editable || r.status !== 'pending', onClick: async () => { const c = await confirm({ title: 'Revoke this invitation?', body: `The link sent to ${r.email} will stop working.`, danger: true, confirmLabel: 'Revoke' }); if (!c.ok) return; try { await api.post(`/api/v1/invitations/${r.id}/revoke`); toast.success('Invitation revoked'); reload(); } catch (e) { toast.error(e); } } },
          ]}
        />
      )}
      <FormDrawer open={invite} onClose={() => setInvite(false)} title="Invite a team member" submitLabel="Send invitation" fields={fields} initial={{ recruiting_scope: 'all', role_id: roles.data?.find(r => r.key === 'recruiter')?.id }}
        onSubmit={async v => { await api.post('/api/v1/invitations', { ...v, team: v.team || null, name: v.name || undefined }); toast.success(`Invitation sent to ${v.email} — it expires in 7 days (see Dev Outbox)`); setSp({ tab: 'invitations' }); reload(); }} />
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit ? `Access for ${edit.name}` : ''} submitLabel="Save access" initial={edit ? { role_id: edit.role_id, recruiting_scope: edit.recruiting_scope, team: edit.team ?? '' } : {}}
        fields={[fields[2], fields[3], fields[4]]}
        onSubmit={async v => { await api.patch(`/api/v1/team/${edit.id}`, { role_id: v.role_id, recruiting_scope: v.recruiting_scope, team: v.team || null }); toast.success(`${edit.name}'s access updated — effective immediately`); reload(); }}>
        {() => <p className="small muted mt-2">{edit?.name} gets an in-app notification. The change is recorded in the audit log.</p>}
      </FormDrawer>
    </div>
  );
}
