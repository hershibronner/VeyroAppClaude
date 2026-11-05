import { useState } from 'react';
import { Laptop, Pencil, Plus, Trash2, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { dateTime } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, PermissionDenied, useConfirm } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { ReadOnlyNote } from './common';

export default function EquipmentSettings() {
  const { can } = useAuth();
  const st = useApi<{ rows: any[]; editable: boolean }>(can('settings') || can('placements') ? '/api/v1/settings/equipment' : null);
  const [edit, setEdit] = useState<any>(null);
  const confirm = useConfirm();
  if (!can('settings') && !can('placements')) return <PermissionDenied />;
  const editable = can('settings', 'edit');
  return (
    <div className="stack">
      <PageHeader title="Equipment Templates" sub="Standard kits a worker needs for a placement. Attach one when creating a placement; items show on the onboarding checklist." actions={editable && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit({ items: [] })}>New template</Button>} />
      <ReadOnlyNote show={!editable} />
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <Card><LoadingBlock /></Card> : st.data.rows.length === 0 ? (
        <Card><EmptyState icon={<Laptop size={22} />} title="No equipment templates" text="Create a kit like “Phone support kit” with the hardware and connectivity a worker needs." action={editable && <Button size="sm" variant="primary" onClick={() => setEdit({ items: [] })}>New template</Button>} /></Card>
      ) : (
        <div className="grid-3">
          {st.data.rows.map(t => (
            <Card key={t.id}>
              <CardHeader title={t.name} sub={`${t.items.length} item${t.items.length === 1 ? '' : 's'} · added ${dateTime(t.created_at)}`} right={editable && <Menu items={[
                { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setEdit(t) },
                { label: 'Duplicate', icon: <Copy size={15} />, onClick: () => setEdit({ name: `${t.name} (copy)`, items: t.items }) },
                { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: async () => { const c = await confirm({ title: `Delete ${t.name}?`, body: 'Placements that already copied this kit keep their items.', danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/settings/equipment/${t.id}`); toast.success('Template deleted'); st.reload(); } catch (e) { toast.error(e); } } },
              ]} />} />
              <div className="card-b"><ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>{t.items.map((i: string) => <li key={i}>{i}</li>)}</ul></div>
            </Card>
          ))}
        </div>
      )}
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New equipment template'} initial={edit ?? {}} submitLabel="Save template"
        fields={[{ name: 'name', label: 'Template name', required: true, full: true, placeholder: 'e.g. Bookkeeping kit' }, { name: 'items', label: 'Items', type: 'tags', required: true, full: true, placeholder: 'Type an item and press Enter', suggestions: ['Laptop/desktop (8GB+ RAM)', '25 Mbps internet + backup', 'Noise-cancelling headset', 'Webcam', 'Second monitor', 'UPS / power backup', 'Quiet workspace'] }]}
        onSubmit={async v => { if (edit.id) await api.patch(`/api/v1/settings/equipment/${edit.id}`, { name: v.name, items: v.items }); else await api.post('/api/v1/settings/equipment', { name: v.name, items: v.items }); toast.success('Equipment template saved'); st.reload(); }} />
    </div>
  );
}
