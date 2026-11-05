import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { humanize } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { Gate, ReadOnlyNote } from './common';
import { CustomFieldInput } from './CustomFields';

export default function CustomFieldsSettings() {
  return <Gate resource="settings">{editable => <Inner editable={editable} />}</Gate>;
}

function Inner({ editable }: { editable: boolean }) {
  const [sp, setSp] = useSearchParams();
  const st = useApi<{ rows: any[]; entities: { key: string; label: string }[] }>('/api/v1/custom-fields');
  const [edit, setEdit] = useState<any>(null);
  const [preview, setPreview] = useState<Record<string, string | null>>({});
  const confirm = useConfirm();
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  const entity = sp.get('entity') || st.data.entities[0].key;
  const rows = st.data.rows.filter(r => r.entity === entity);
  const label = st.data.entities.find(e => e.key === entity)?.label ?? humanize(entity);
  const move = async (r: any, dir: -1 | 1) => {
    const i = rows.findIndex(x => x.id === r.id); const other = rows[i + dir]; if (!other) return;
    try { await api.patch(`/api/v1/custom-fields/${r.id}`, { sort: other.sort }); await api.patch(`/api/v1/custom-fields/${other.id}`, { sort: r.sort }); st.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack">
      <PageHeader title="Custom Fields" sub="Add your own fields to records. They appear on record pages, in forms, and (for select/yes-no fields) as list filters." actions={editable && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit({ entity, type: 'text', options: [], required: false, filterable: true })}>New field</Button>} />
      <ReadOnlyNote show={!editable} />
      <Tabs value={entity} onChange={k => setSp({ entity: k })} tabs={st.data.entities.map(e => ({ key: e.key, label: e.label, count: st.data!.rows.filter(r => r.entity === e.key).length }))} />
      <div className="grid-main-side">
        <Card>
          <CardHeader title={`${label} fields`} sub={`${rows.length} field${rows.length === 1 ? '' : 's'}`} />
          {rows.length === 0 ? <EmptyState icon={<SlidersHorizontal size={22} />} title={`No custom fields for ${label.toLowerCase()}`} text="Capture anything your agency tracks — contract tier, shift preference, referral partner…" action={editable && <Button size="sm" variant="primary" onClick={() => setEdit({ entity, type: 'text', options: [], required: false, filterable: true })}>New field</Button>} /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Options</th><th>Rules</th><th style={{ textAlign: 'right' }}>Records filled</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="bold">{r.label}</td><td className="mono small">{r.key}</td><td>{humanize(r.type)}</td>
                  <td>{r.options.length ? <div className="chips">{r.options.map((o: string) => <span key={o} className="chip">{o}</span>)}</div> : '—'}</td>
                  <td><div className="row" style={{ gap: 4 }}>{r.required && <StatusPill status="required" label="Required" tone="amber" />}{r.filterable && <StatusPill status="filter" label="Filter" tone="blue" />}{!r.required && !r.filterable && '—'}</div></td>
                  <td className="money">{r.used}</td>
                  <td className="act">{editable && <Menu items={[
                    { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setEdit(r) },
                    { label: 'Move up', icon: <ArrowUp size={15} />, disabled: i === 0, onClick: () => move(r, -1) },
                    { label: 'Move down', icon: <ArrowDown size={15} />, disabled: i === rows.length - 1, onClick: () => move(r, 1) },
                    { label: 'Delete field', icon: <Trash2 size={15} />, danger: true, onClick: async () => { const c = await confirm({ title: `Delete "${r.label}"?`, body: r.used ? `Values on ${r.used} record(s) will be permanently deleted. This is recorded in the audit log.` : 'No records use this field yet.', danger: true, confirmLabel: 'Delete field', typeToConfirm: r.used ? 'DELETE' : undefined }); if (!c.ok) return; try { await api.del(`/api/v1/custom-fields/${r.id}`); toast.success('Field deleted'); st.reload(); } catch (e) { toast.error(e); } } },
                  ]} />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card>
          <CardHeader title="Form preview" sub={`How the fields look on a ${label.toLowerCase().replace(/s$/, '')} record`} />
          <div className="card-b stack" style={{ gap: 12 }}>{rows.length ? rows.map(r => <CustomFieldInput key={r.id} def={r} value={preview[r.id] ?? null} onChange={v => setPreview(p => ({ ...p, [r.id]: v }))} />) : <span className="small muted">Add a field to preview it.</span>}</div>
        </Card>
      </div>
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.label}` : 'New custom field'} initial={edit ?? {}} submitLabel="Save field"
        fields={[
          { name: 'entity', label: 'Record type', type: 'select', required: true, options: st.data.entities.map(e => ({ value: e.key, label: e.label })), hidden: () => !!edit?.id },
          { name: 'label', label: 'Label', required: true, placeholder: 'e.g. Contract tier' },
          { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'select', label: 'Dropdown' }, { value: 'boolean', label: 'Yes / No' }], hidden: () => !!edit?.id, hint: edit?.id ? undefined : 'The type cannot change later' },
          { name: 'options', label: 'Options', type: 'tags', full: true, hidden: v => v.type !== 'select', required: true, placeholder: 'Type an option and press Enter' },
          { name: 'required', label: 'Required', type: 'checkbox', placeholder: 'Must be filled when the record is edited' },
          { name: 'filterable', label: 'Filter', type: 'checkbox', placeholder: 'Offer as a list filter' },
        ]}
        onSubmit={async v => {
          if (edit.id) await api.patch(`/api/v1/custom-fields/${edit.id}`, { label: v.label, options: edit.type === 'select' ? v.options : undefined, required: !!v.required, filterable: !!v.filterable });
          else await api.post('/api/v1/custom-fields', { entity: v.entity, label: v.label, type: v.type, options: v.type === 'select' ? v.options : [], required: !!v.required, filterable: !!v.filterable });
          toast.success('Custom field saved'); if (!edit.id && v.entity !== entity) setSp({ entity: v.entity }); st.reload();
        }} />
    </div>
  );
}
