import { useEffect, useMemo, useState } from 'react';
import { Copy, Lock, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { humanize } from '../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { Gate, ReadOnlyNote } from './common';

const GROUPS: [string, string[]][] = [
  ['CRM', ['leads', 'clients', 'contacts', 'opportunities', 'tasks', 'activities']],
  ['Recruiting', ['positions', 'candidates', 'submissions', 'interviews', 'assessments', 'offers']],
  ['Workforce & time', ['workers', 'placements', 'onboarding', 'issues', 'time', 'timesheets', 'screenshots', 'attendance', 'time_off']],
  ['Finance', ['rates', 'invoices', 'payments', 'payroll', 'payouts', 'commissions', 'margin']],
  ['Communications & insights', ['messages', 'templates', 'documents', 'automation', 'analytics', 'reports']],
  ['Administration', ['settings', 'team', 'roles', 'audit', 'integrations', 'billing', 'imports', 'exports']],
];
const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export', view_comp: 'Pay & bill rates' };
const SCOPE_LABEL: Record<string, string> = { all: 'All', team: 'Team', assigned: 'Assigned', own: 'Own', none: '—' };

export default function RolesSettings() {
  return <Gate resource="roles">{editable => <RolesInner editable={editable} />}</Gate>;
}

function RolesInner({ editable }: { editable: boolean }) {
  const { me, can } = useAuth();
  const st = useApi<any>('/api/v1/roles/matrix');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<null | { clone_from?: string }>(null);
  const [renaming, setRenaming] = useState<any>(null);
  const confirm = useConfirm();
  useEffect(() => { if (st.data && !roleId) setRoleId(st.data.roles.find((r: any) => r.key === 'recruiter')?.id ?? st.data.roles[0]?.id); }, [st.data, roleId]);
  const role = st.data?.roles.find((r: any) => r.id === roleId);
  const base = useMemo(() => { const m: Record<string, string> = {}; const mx = st.data?.matrix?.[roleId ?? ''] ?? {}; for (const [res, acts] of Object.entries(mx)) for (const [a, s] of Object.entries(acts as any)) m[`${res}:${a}`] = s as string; return m; }, [st.data, roleId]);
  useEffect(() => { setDraft({}); }, [roleId]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={10} /></Card>;
  const locked = !editable || !role || role.key === 'owner' || role.id === me?.workspace?.role.id;
  const cell = (res: string, a: string) => draft[`${res}:${a}`] ?? base[`${res}:${a}`] ?? 'none';
  const changes = Object.entries(draft).filter(([k, v]) => (base[k] ?? 'none') !== v);
  const scopesFor = (a: string) => (a === 'view_comp' || a === 'export' || a === 'approve' || a === 'delete' ? ['none', 'all', 'own'] : ['none', 'all', 'team', 'assigned', 'own']);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put(`/api/v1/roles/${roleId}/permissions`, { changes: changes.map(([k, scope]) => { const [resource, action] = k.split(':'); return { resource, action, scope }; }) });
      toast.success(`${r.changed} permission${r.changed === 1 ? '' : 's'} updated for ${role.name} — members see it on their next click`); setDraft({}); st.reload();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const grantAll = (res: string, scope: 'all' | 'none') => setDraft(d => { const n = { ...d }; for (const a of st.data.actions) n[`${res}:${a}`] = scope === 'all' ? (a === 'view_comp' && !['rates', 'placements', 'payroll', 'invoices'].includes(res) ? cell(res, a) : 'all') : 'none'; return n; });
  return (
    <div className="stack">
      <PageHeader title="Roles & Permissions" sub="Resource × action → scope. Server-enforced on every request; edits apply immediately without sign-out."
        actions={editable && can('roles', 'create') ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating({})}>New custom role</Button> : undefined} />
      <ReadOnlyNote show={!editable} />
      <div className="grid-main-side" style={{ gridTemplateColumns: '280px minmax(0,1fr)' }}>
        <Card>
          <CardHeader title="Staff roles" sub={`${st.data.roles.length} roles`} />
          <div style={{ padding: 8 }}>
            {st.data.roles.map((r: any) => (
              <button key={r.id} className={`ws-switch`} style={{ margin: '0 0 6px', width: '100%', borderColor: r.id === roleId ? 'var(--primary)' : undefined, background: r.id === roleId ? 'var(--primary-50)' : undefined }} onClick={() => { if (changes.length && !window.confirm('Discard unsaved permission changes?')) return; setRoleId(r.id); }}>
                <span style={{ flex: 1, minWidth: 0 }}><div className="bold small truncate">{r.name}</div><div className="tiny muted">{r.is_system ? 'System role' : 'Custom role'} · {r.members} member{r.members === 1 ? '' : 's'}</div></span>
                {r.key === 'owner' && <Lock size={14} color="var(--muted)" />}
              </button>
            ))}
          </div>
        </Card>
        {role && <Card>
          <CardHeader title={<span className="row" style={{ gap: 8 }}>{role.name} {role.is_system ? <StatusPill status="system" label="System" tone="gray" /> : <StatusPill status="custom" label="Custom" tone="purple" />}</span>}
            sub={role.description ?? <span className="row" style={{ gap: 6 }}><Users size={13} /> {role.members} active member{role.members === 1 ? '' : 's'}</span>}
            right={<>
              {!locked && <><Button size="sm" disabled={!changes.length} onClick={() => setDraft({})}>Discard</Button><Button size="sm" variant="primary" disabled={!changes.length} loading={busy} onClick={save}>Save {changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'changes'}</Button></>}
              {editable && <Menu items={[
                { label: 'Clone as new role', icon: <Copy size={15} />, onClick: () => setCreating({ clone_from: role.id }), hidden: !can('roles', 'create') },
                { label: 'Rename', icon: <Pencil size={15} />, onClick: () => setRenaming(role), hidden: role.is_system },
                { label: 'Delete role', icon: <Trash2 size={15} />, danger: true, hidden: role.is_system || !can('roles', 'delete'), onClick: async () => { const c = await confirm({ title: `Delete ${role.name}?`, body: role.members ? `Move its ${role.members} member(s) to another role first.` : 'This custom role and its permissions will be deleted. The change is audited.', danger: true, confirmLabel: 'Delete role' }); if (!c.ok) return; try { await api.del(`/api/v1/roles/${role.id}`); toast.success('Role deleted'); setRoleId(null); st.reload(); } catch (e) { toast.error(e); } } },
              ]} />}
            </>} />
          {role.key === 'owner' && <div style={{ padding: '12px 22px 0' }}><Banner icon={<Lock size={18} />}>The Owner role always has full access so an agency can never lock itself out.</Banner></div>}
          {role.id === me?.workspace?.role.id && role.key !== 'owner' && <div style={{ padding: '12px 22px 0' }}><Banner tone="warn">This is your own role — another admin must change it, so you can't accidentally remove your own access.</Banner></div>}
          <div className="st-matrix">
            <table>
              <thead><tr><th>Resource</th>{st.data.actions.map((a: string) => <th key={a}>{ACTION_LABEL[a]}</th>)}{!locked && <th><span className="sr-only">Quick set</span></th>}</tr></thead>
              <tbody>
                {GROUPS.map(([g, res]) => [
                  <tr key={g} className="group"><th colSpan={st.data.actions.length + 2}>{g}</th></tr>,
                  ...res.filter(r => st.data.resources.includes(r)).map(res => (
                    <tr key={res}>
                      <th>{humanize(res)}</th>
                      {st.data.actions.map((a: string) => { const v = cell(res, a); const changed = draft[`${res}:${a}`] !== undefined && draft[`${res}:${a}`] !== (base[`${res}:${a}`] ?? 'none'); return (
                        <td key={a} style={{ textAlign: 'center' }}>
                          <select aria-label={`${humanize(res)} ${ACTION_LABEL[a]}`} disabled={locked} className={`s-${v} ${changed ? 'changed' : ''}`} value={v} onChange={e => setDraft(d => ({ ...d, [`${res}:${a}`]: e.target.value }))}>
                            {[...new Set([...scopesFor(a), v])].map(s => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                          </select>
                        </td>
                      ); })}
                      {!locked && <td><Menu label={`Quick set ${humanize(res)}`} items={[{ label: 'Grant all actions', onClick: () => grantAll(res, 'all') }, { label: 'Remove all access', danger: true, onClick: () => grantAll(res, 'none') }]} /></td>}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
          <div className="card-b small muted">Scopes: <b>All</b> every record · <b>Team</b> records of the member's team · <b>Assigned</b> records assigned to them (e.g. positions) · <b>Own</b> records they own. "Pay & bill rates" controls field-level access to compensation.</div>
        </Card>}
      </div>
      <FormDrawer open={!!creating} onClose={() => setCreating(null)} title={creating?.clone_from ? 'Clone role' : 'New custom role'} submitLabel="Create role" initial={{ clone_from: creating?.clone_from ?? '', name: creating?.clone_from ? `${st.data.roles.find((r: any) => r.id === creating.clone_from)?.name} (copy)` : '' }}
        fields={[{ name: 'name', label: 'Role name', required: true, placeholder: 'e.g. Senior Recruiter' }, { name: 'description', label: 'Description', type: 'textarea', placeholder: 'What this role is for' }, { name: 'clone_from', label: 'Start from', type: 'select', placeholder: 'Blank (no access)', options: st.data.roles.map((r: any) => ({ value: r.id, label: `Copy of ${r.name}` })) }]}
        onSubmit={async v => { const r = await api.post('/api/v1/roles', { name: v.name, description: v.description || undefined, clone_from: v.clone_from || undefined }); toast.success(`${r.name} created — adjust its permissions below`); await st.reload(); setRoleId(r.id); }} />
      <FormDrawer open={!!renaming} onClose={() => setRenaming(null)} title="Rename role" initial={{ name: renaming?.name, description: renaming?.description ?? '' }}
        fields={[{ name: 'name', label: 'Role name', required: true }, { name: 'description', label: 'Description', type: 'textarea' }]}
        onSubmit={async v => { await api.patch(`/api/v1/roles/${renaming.id}`, { name: v.name, description: v.description || null }); toast.success('Role updated'); st.reload(); }} />
    </div>
  );
}
