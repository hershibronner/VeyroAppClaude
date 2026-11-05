import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, CheckCircle2, ClipboardList, Copy, GraduationCap, Pencil, Plus, Star, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { date, humanize } from '../../lib/format';
import { Button, Card, CardHeader, Drawer, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, Person, StatusPill, Tabs, useConfirm, Meter } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { PermissionDenied } from '../../components/ui';
import { ReadOnlyNote } from './common';

export default function OnboardingSettings() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'templates' | 'training') || 'templates';
  if (!can('settings') && !can('onboarding')) return <PermissionDenied />;
  const editable = can('settings', 'edit') || can('onboarding', 'edit');
  return (
    <div className="stack">
      <PageHeader title="Onboarding & Training" sub="Checklists every new placement starts with, and training workers complete in their portal." />
      <ReadOnlyNote show={!editable} />
      <Tabs value={tab} onChange={k => setSp({ tab: k })} tabs={[{ key: 'templates', label: 'Onboarding templates' }, { key: 'training', label: 'Worker training' }]} />
      {tab === 'templates' ? <Templates editable={can('settings', 'edit')} /> : <Training editable={editable} />}
    </div>
  );
}

function Templates({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[] }>('/api/v1/settings/onboarding-templates');
  const [creating, setCreating] = useState<null | { copy_from?: string }>(null);
  const [item, setItem] = useState<any>(null);
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  const patchItem = async (it: any, patch: any) => { try { await api.patch(`/api/v1/settings/onboarding-items/${it.id}`, patch); st.reload(); } catch (e) { toast.error(e); } };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="small muted">New placements get the <b>default agency template</b> + the client's template + the position's requirements. Required items block activation.</div>
        {editable && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating({})}>New template</Button>}
      </div>
      {st.data.rows.length === 0 && <EmptyState icon={<ClipboardList size={22} />} title="No templates" />}
      <div className="grid-2">
        {st.data.rows.map(t => (
          <Card key={t.id}>
            <CardHeader title={<span className="row" style={{ gap: 8 }}>{t.name}{t.is_default && <StatusPill status="default" label="Default" tone="blue" />}</span>} sub={t.scope === 'client' ? `Client template · ${t.company_name ?? '—'}` : 'Agency template'}
              right={editable && <><Button size="sm" icon={<Plus size={14} />} onClick={() => setItem({ template_id: t.id, required: true, owner: 'agency' })}>Item</Button><Menu items={[
                { label: 'Make default', icon: <Star size={15} />, hidden: t.is_default || t.scope !== 'agency', onClick: async () => { try { await api.patch(`/api/v1/settings/onboarding-templates/${t.id}`, { is_default: true }); toast.success(`${t.name} is now the default`); st.reload(); } catch (e) { toast.error(e); } } },
                { label: 'Duplicate', icon: <Copy size={15} />, onClick: () => setCreating({ copy_from: t.id }) },
                { label: 'Delete template', icon: <Trash2 size={15} />, danger: true, hidden: t.is_default, onClick: async () => { const c = await confirm({ title: `Delete ${t.name}?`, body: 'Existing placements keep their checklist items.', danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/settings/onboarding-templates/${t.id}`); toast.success('Template deleted'); st.reload(); } catch (e) { toast.error(e); } } },
              ]} /></>} />
            <div className="card-b" style={{ paddingTop: 6 }}>
              {t.items.length === 0 ? <div className="muted small" style={{ padding: '12px 0' }}>No items yet.</div> : t.items.map((it: any) => (
                <div key={it.id} className="checklist-item">
                  <CheckCircle2 size={16} color={it.required ? 'var(--primary)' : 'var(--muted-2)'} />
                  <div style={{ flex: 1, minWidth: 0 }}><div className="small bold">{it.title}</div><div className="tiny muted">{it.required ? 'Required' : 'Optional'} · done by {humanize(it.owner)}</div></div>
                  {editable && <Menu items={[
                    { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setItem(it) },
                    { label: it.required ? 'Make optional' : 'Make required', onClick: () => patchItem(it, { required: !it.required }) },
                    { label: 'Remove', icon: <Trash2 size={15} />, danger: true, onClick: async () => { try { await api.del(`/api/v1/settings/onboarding-items/${it.id}`); st.reload(); } catch (e) { toast.error(e); } } },
                  ]} />}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <FormDrawer open={!!creating} onClose={() => setCreating(null)} title={creating?.copy_from ? 'Duplicate template' : 'New onboarding template'} initial={{ scope: 'agency' }} submitLabel="Create template"
        fields={[{ name: 'name', label: 'Template name', required: true, full: true }, { name: 'scope', label: 'Applies to', type: 'select', required: true, options: [{ value: 'agency', label: 'All placements (agency)' }, { value: 'client', label: 'One client' }] },
          { name: 'company_id', label: 'Client', type: 'entity', endpoint: '/api/v1/companies?stage=client', labelOf: r => r.name, hidden: v => v.scope !== 'client', required: true }]}
        onSubmit={async v => { await api.post('/api/v1/settings/onboarding-templates', { name: v.name, scope: v.scope, company_id: v.scope === 'client' ? v.company_id : null, copy_from: creating?.copy_from }); toast.success('Template created'); st.reload(); }} />
      <FormDrawer open={!!item} onClose={() => setItem(null)} title={item?.id ? 'Edit item' : 'Add checklist item'} initial={item ?? {}}
        fields={[{ name: 'title', label: 'Item', required: true, full: true, placeholder: 'e.g. Signed HIPAA acknowledgment' }, { name: 'owner', label: 'Completed by', type: 'select', required: true, options: [{ value: 'agency', label: 'Agency' }, { value: 'worker', label: 'Worker' }, { value: 'client', label: 'Client' }] }, { name: 'required', label: 'Required', type: 'checkbox', placeholder: 'Blocks activation until done' }]}
        onSubmit={async v => { if (item.id) await api.patch(`/api/v1/settings/onboarding-items/${item.id}`, { title: v.title, owner: v.owner, required: !!v.required }); else await api.post(`/api/v1/settings/onboarding-templates/${item.template_id}/items`, { title: v.title, owner: v.owner, required: !!v.required }); toast.success('Checklist updated'); st.reload(); }} />
    </>
  );
}

function Training({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[]; workers: number }>('/api/v1/settings/training');
  const [edit, setEdit] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const prog = useApi<any[]>(progress ? `/api/v1/settings/training/${progress.id}/progress` : null, [progress?.id]);
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  const w = st.data.workers;
  return (
    <>
      <Card>
        <CardHeader title="Training modules" sub={`${st.data.rows.filter(r => r.active).length} active · shown to ${w} current worker${w === 1 ? '' : 's'} in the worker portal`} right={editable && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ kind: 'reading', required: false, duration_min: 10, active: true })}>New module</Button>} />
        {st.data.rows.length === 0 ? <EmptyState icon={<GraduationCap size={22} />} title="No training yet" text="Add policies, how-to guides or videos for workers to complete." /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Module</th><th>Type</th><th>Length</th><th>Completion</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{st.data.rows.map(m => { const pct = w ? (m.completed / w) * 100 : 0; return (
              <tr key={m.id} className="clickable" onClick={() => setProgress(m)}>
                <td><div className="bold row" style={{ gap: 6 }}>{m.title}{m.required && <StatusPill status="required" label="Required" tone="amber" />}</div><div className="small muted truncate" style={{ maxWidth: 380 }}>{m.description ?? '—'}</div></td>
                <td>{humanize(m.kind)}</td><td>{m.duration_min} min</td>
                <td style={{ minWidth: 160 }}><div className="small">{m.completed} of {w} done{m.in_progress ? ` · ${m.in_progress} in progress` : ''}</div><Meter value={pct} /></td>
                <td><StatusPill status={m.active ? 'active' : 'disabled'} label={m.active ? 'Active' : 'Hidden'} /></td>
                <td className="act" onClick={e => e.stopPropagation()}><Menu items={[
                  { label: 'Who completed it', icon: <Users size={15} />, onClick: () => setProgress(m) },
                  { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setEdit(m), hidden: !editable },
                  { label: m.active ? 'Hide from workers' : 'Show to workers', onClick: async () => { try { await api.patch(`/api/v1/settings/training/${m.id}`, { active: !m.active }); st.reload(); } catch (e) { toast.error(e); } }, hidden: !editable },
                  { label: 'Delete', icon: <Trash2 size={15} />, danger: true, hidden: !editable, onClick: async () => { const c = await confirm({ title: `Delete "${m.title}"?`, body: `Progress for ${m.completed + m.in_progress} worker(s) will be deleted too.`, danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/settings/training/${m.id}`); toast.success('Module deleted'); st.reload(); } catch (e) { toast.error(e); } } },
                ]} /></td>
              </tr>
            ); })}</tbody>
          </table></div>
        )}
      </Card>
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit training module' : 'New training module'} wide initial={edit ?? {}} submitLabel="Save module"
        fields={[{ name: 'title', label: 'Title', required: true, full: true }, { name: 'kind', label: 'Type', type: 'select', required: true, options: [{ value: 'reading', label: 'Reading' }, { value: 'video', label: 'Video' }, { value: 'policy', label: 'Policy (worker must accept)' }, { value: 'quiz', label: 'Checklist / quiz' }] },
          { name: 'duration_min', label: 'Length (minutes)', type: 'number', required: true }, { name: 'url', label: 'Video or resource link', type: 'url', full: true, placeholder: 'https://…', hidden: v => v.kind !== 'video' },
          { name: 'description', label: 'Short description', full: true }, { name: 'content', label: 'Content', type: 'textarea', full: true, placeholder: 'What the worker reads in the portal' },
          { name: 'required', label: 'Required', type: 'checkbox', placeholder: 'Required for every worker' }, { name: 'active', label: 'Visible', type: 'checkbox', placeholder: 'Show in the worker portal' }]}
        onSubmit={async v => { const body = { title: v.title, kind: v.kind, duration_min: Number(v.duration_min), url: v.kind === 'video' ? v.url || null : null, description: v.description || null, content: v.content || null, required: !!v.required, active: v.active !== false }; if (edit.id) await api.patch(`/api/v1/settings/training/${edit.id}`, body); else await api.post('/api/v1/settings/training', body); toast.success('Training saved'); st.reload(); }} />
      <Drawer open={!!progress} onClose={() => setProgress(null)} title={progress ? progress.title : ''}>
        {!prog.data ? <LoadingBlock /> : prog.data.length === 0 ? <EmptyState icon={<BookOpen size={22} />} title="No current workers" /> : prog.data.map(p => (
          <div key={p.worker_id} className="checklist-item">
            <Person name={`${p.first_name} ${p.last_name ?? ''}`.trim()} sub={humanize(p.worker_status)} size={28} />
            <span style={{ marginLeft: 'auto' }}>{p.status === 'completed' ? <StatusPill status="completed" label={`Done ${date(p.completed_at)}`} /> : p.status === 'in_progress' ? <StatusPill status="in_progress" label="In progress" /> : <StatusPill status="not_started" label="Not started" tone="gray" />}</span>
          </div>
        ))}
      </Drawer>
    </>
  );
}
