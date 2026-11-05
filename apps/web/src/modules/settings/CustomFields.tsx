// Reusable custom-fields editor. Embed on any record page:
//   import { CustomFieldsEditor } from '../settings/CustomFields';
//   <CustomFieldsEditor entity="candidate" entityId={id} />
// entity: candidate | company | contact | position | worker | placement | opportunity
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { date } from '../../lib/format';
import { Button, Card, CardHeader, Field, LoadingBlock, ErrorState } from '../../components/ui';

export type CustomEntity = 'candidate' | 'company' | 'contact' | 'position' | 'worker' | 'placement' | 'opportunity';
interface Def { id: string; key: string; label: string; type: 'text' | 'number' | 'date' | 'select' | 'boolean'; options: string[]; required: boolean; value: string | null }

export function CustomFieldInput({ def, value, onChange, error, disabled }: { def: Pick<Def, 'id' | 'label' | 'type' | 'options' | 'required'>; value: string | null; onChange: (v: string | null) => void; error?: string; disabled?: boolean }) {
  const id = `cf-${def.id}`;
  const label = <>{def.label}{def.required && <span style={{ color: 'var(--danger)' }}> *</span>}</>;
  if (def.type === 'boolean') return <Field label={label} error={error}><label className="check"><input id={id} type="checkbox" disabled={disabled} checked={value === 'true'} onChange={e => onChange(e.target.checked ? 'true' : 'false')} /> Yes</label></Field>;
  if (def.type === 'select') return <Field label={label} htmlFor={id} error={error}><select id={id} className={`select ${error ? 'invalid' : ''}`} disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value || null)}><option value="">—</option>{def.options.map(o => <option key={o} value={o}>{o}</option>)}</select></Field>;
  return <Field label={label} htmlFor={id} error={error}><input id={id} className={`input ${error ? 'invalid' : ''}`} disabled={disabled} type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : e.target.value)} /></Field>;
}

/** Shows and edits the agency-defined custom fields for one record. Renders nothing if the agency has none for this entity. */
export function CustomFieldsEditor({ entity, entityId, title = 'Custom fields', compact }: { entity: CustomEntity; entityId: string; title?: string; compact?: boolean }) {
  const st = useApi<{ fields: Def[]; editable: boolean }>(`/api/v1/custom-fields/values/${entity}/${entityId}`, [entityId]);
  const { can } = useAuth();
  const [vals, setVals] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setVals(Object.fromEntries(st.data.fields.map(f => [f.id, f.value]))); }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={2} /></Card>;
  if (!st.data.fields.length) return can('settings', 'edit') && !compact ? <Card><CardHeader title={title} /><div className="card-b small muted">No custom fields for this record type yet. <Link to={`/settings/custom-fields?entity=${entity}`}>Add one in Settings</Link>.</div></Card> : null;
  const display = (f: Def) => { const v = f.value; if (v === null || v === '') return '—'; if (f.type === 'boolean') return v === 'true' ? 'Yes' : 'No'; if (f.type === 'date') return date(v); return v; };
  const save = async () => {
    setBusy(true); setErrors({});
    try { const r = await api.put(`/api/v1/custom-fields/values/${entity}/${entityId}`, { values: vals }); toast.success(r.changed ? `Saved ${r.changed} field${r.changed === 1 ? '' : 's'}` : 'No changes'); setEditing(false); st.reload(); }
    catch (e) { if (e instanceof ApiError && e.fields) { const byId: Record<string, string> = {}; for (const f of st.data!.fields) if (e.fields[f.key]) byId[f.id] = e.fields[f.key]; setErrors(byId); } toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title={<span className="row" style={{ gap: 8 }}><SlidersHorizontal size={16} /> {title}</span>} right={st.data.editable && (editing ? <><Button size="sm" onClick={() => { setEditing(false); setErrors({}); setVals(Object.fromEntries(st.data!.fields.map(f => [f.id, f.value]))); }}>Cancel</Button><Button size="sm" variant="primary" loading={busy} onClick={save}>Save</Button></> : <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>)} />
      <div className="card-b">
        {editing ? <div className="form-grid">{st.data.fields.map(f => <CustomFieldInput key={f.id} def={f} value={vals[f.id] ?? null} onChange={v => setVals(s => ({ ...s, [f.id]: v }))} error={errors[f.id]} />)}</div>
          : <dl className="kv">{st.data.fields.map(f => <div key={f.id} style={{ display: 'contents' }}><dt>{f.label}</dt><dd>{display(f)}</dd></div>)}</dl>}
      </div>
    </Card>
  );
}

/** Filter definitions for DataTable from filterable select/boolean custom fields (values are matched via /api/v1/custom-fields/match). */
export function useCustomFieldFilters(entity: CustomEntity) {
  const st = useApi<{ rows: any[] }>(`/api/v1/custom-fields?entity=${entity}`);
  return (st.data?.rows ?? []).filter(d => d.filterable && (d.type === 'select' || d.type === 'boolean')).map(d => ({ key: `cf_${d.key}`, label: d.label, options: d.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : d.options.map((o: string) => ({ value: o, label: o })) }));
}
