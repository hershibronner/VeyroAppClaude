import { useState } from 'react';
import { RotateCcw, ShieldCheck, UserMinus, UserPlus, XCircle } from 'lucide-react';
import { api } from '../../../lib/api';
import { useApi } from '../../../lib/hooks';
import { toast } from '../../../lib/toast';
import { relTime } from '../../../lib/format';
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, Person, StatusPill, useConfirm } from '../../../components/ui';
import { FormDrawer } from '../../../components/FormDrawer';

export default function ClientUsers() {
  const st = useApi<any>('/api/v1/portal/client/users');
  const [invite, setInvite] = useState(false);
  const [role, setRole] = useState<any>(null);
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  const d = st.data;
  const roleOpts = d.roles.map((r: any) => ({ value: r.key, label: `${r.name} — ${r.description}` }));
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast.success(msg); st.reload(); } catch (e) { toast.error(e); } };
  return (
    <div className="stack">
      <PageHeader title="Users & permissions" sub="People from your company who can use this portal. Client users are always free." actions={d.can_manage && <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInvite(true)}>Invite user</Button>} />
      {!d.can_manage && <Banner>Only your company's client owner can invite or remove users.</Banner>}
      <Card>
        <CardHeader title="Users" sub={`${d.users.filter((u: any) => u.status === 'active').length} active`} />
        <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th>{d.can_manage && <th className="act"><span className="sr-only">Actions</span></th>}</tr></thead><tbody>
          {d.users.map((u: any) => <tr key={u.id}>
            <td><Person name={`${u.name}${u.is_me ? ' (you)' : ''}`} sub={u.email} /></td><td>{u.role_name}</td><td><StatusPill status={u.status} /></td><td>{u.last_login_at ? relTime(u.last_login_at) : 'Never'}</td>
            {d.can_manage && <td className="act"><Menu items={[
              { label: 'Change role', icon: <ShieldCheck size={15} />, onClick: () => setRole(u) },
              { label: 'Revoke access', icon: <UserMinus size={15} />, danger: true, hidden: u.is_me, onClick: async () => { const c = await confirm({ title: `Revoke ${u.name}'s access?`, body: 'They will no longer be able to sign in to this portal.', danger: true, confirmLabel: 'Revoke' }); if (c.ok) act(() => api.post(`/api/v1/portal/client/users/${u.id}/revoke`), 'Access revoked'); } },
            ]} /></td>}
          </tr>)}
        </tbody></table></div>
      </Card>
      <Card>
        <CardHeader title="Pending invitations" />
        {d.invites.length === 0 ? <EmptyState title="No pending invitations" /> : <div className="table-wrap"><table className="table"><thead><tr><th>Invitee</th><th>Role</th><th>Status</th><th>Expires</th>{d.can_manage && <th className="act"><span className="sr-only">Actions</span></th>}</tr></thead><tbody>
          {d.invites.map((i: any) => <tr key={i.id}><td><Person name={i.name ?? i.email} sub={i.email} /></td><td>{i.role_name}</td><td><StatusPill status={i.status} /></td><td>{relTime(i.expires_at)}</td>
            {d.can_manage && <td className="act"><Menu items={[
              { label: 'Resend invitation', icon: <RotateCcw size={15} />, onClick: () => act(() => api.post(`/api/v1/portal/client/users/invites/${i.id}/resend`), `Invitation re-sent to ${i.email}`) },
              { label: 'Revoke invitation', icon: <XCircle size={15} />, danger: true, onClick: () => act(() => api.post(`/api/v1/portal/client/users/invites/${i.id}/revoke`), 'Invitation revoked') },
            ]} /></td>}
          </tr>)}
        </tbody></table></div>}
      </Card>
      <FormDrawer open={invite} onClose={() => setInvite(false)} title="Invite a colleague" submitLabel="Send invitation" initial={{ role_key: 'client_manager' }}
        fields={[{ name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Work email', type: 'email', required: true }, { name: 'role_key', label: 'Role', type: 'select', required: true, full: true, options: roleOpts }]}
        onSubmit={async v => { await api.post('/api/v1/portal/client/users', v); toast.success(`Invitation sent to ${v.email}`); st.reload(); }} />
      <FormDrawer open={!!role} onClose={() => setRole(null)} title={role ? `Role for ${role.name}` : ''} submitLabel="Save role" initial={{ role_key: role?.role_key }}
        fields={[{ name: 'role_key', label: 'Role', type: 'select', required: true, full: true, options: roleOpts }]}
        onSubmit={async v => { await api.patch(`/api/v1/portal/client/users/${role.id}`, v); toast.success('Role updated'); st.reload(); }} />
    </div>
  );
}
