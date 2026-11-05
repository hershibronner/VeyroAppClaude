import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { toast } from '../lib/toast';
import { Button, Drawer, Field, MemberSelect, EntitySelect, MoneyInput, TagInput, PhoneInput } from './ui';

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'url' | 'number' | 'money' | 'date' | 'time' | 'datetime' | 'select' | 'textarea' | 'member' | 'entity' | 'tags' | 'checkbox' | 'phone' | 'custom';
  options?: { value: string; label: string }[];
  required?: boolean;
  full?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  endpoint?: string; labelOf?: (r: any) => string; // for entity
  roles?: string[]; // for member
  suggestions?: string[]; // for tags
  render?: (value: any, set: (v: any) => void, values: Record<string, any>) => ReactNode; // for custom
  hidden?: (values: Record<string, any>) => boolean;
}

/** Renders a grid of fields bound to `values`. */
export function FormFields({ fields, values, setValues, errors }: { fields: FieldDef[]; values: Record<string, any>; setValues: (fn: (v: Record<string, any>) => Record<string, any>) => void; errors: Record<string, string> }) {
  return (
    <div className="form-grid">
      {fields.filter(f => !f.hidden?.(values)).map(f => {
        const id = `f-${f.name}`;
        const v = values[f.name];
        const set = (nv: any) => setValues(s => ({ ...s, [f.name]: nv }));
        const cls = `${f.type === 'textarea' ? 'textarea' : f.type === 'select' ? 'select' : 'input'} ${errors[f.name] ? 'invalid' : ''}`;
        let input: ReactNode;
        switch (f.type) {
          case 'textarea': input = <textarea id={id} className={cls} value={v ?? ''} placeholder={f.placeholder} onChange={e => set(e.target.value)} />; break;
          case 'select': input = <select id={id} className={cls} value={v ?? ''} onChange={e => set(e.target.value || null)}><option value="">{f.placeholder ?? 'Select…'}</option>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>; break;
          case 'member': input = <MemberSelect id={id} value={v} onChange={set} roles={f.roles} placeholder={f.placeholder} />; break;
          case 'entity': input = <EntitySelect id={id} endpoint={f.endpoint!} value={v} onChange={set} labelOf={f.labelOf ?? (r => r.name)} placeholder={f.placeholder} />; break;
          case 'money': input = <MoneyInput id={id} cents={v} onChange={set} placeholder={f.placeholder} />; break;
          case 'tags': input = <TagInput value={v ?? []} onChange={set} suggestions={f.suggestions} placeholder={f.placeholder} />; break;
          case 'phone': input = <PhoneInput id={id} value={v ?? ''} onChange={set} />; break;
          case 'checkbox': input = <label className="check"><input id={id} type="checkbox" checked={!!v} onChange={e => set(e.target.checked)} /> {f.placeholder ?? 'Yes'}</label>; break;
          case 'custom': input = f.render!(v, set, values); break;
          case 'number': input = <input id={id} type="number" className={cls} value={v ?? ''} placeholder={f.placeholder} onChange={e => set(e.target.value === '' ? null : Number(e.target.value))} />; break;
          case 'datetime': input = <input id={id} type="datetime-local" className={cls} value={v ?? ''} onChange={e => set(e.target.value)} />; break;
          default: input = <input id={id} type={f.type ?? 'text'} className={cls} value={v ?? ''} placeholder={f.placeholder} onChange={e => set(e.target.value)} />;
        }
        return <Field key={f.name} htmlFor={id} label={<>{f.label}{f.required && <span style={{ color: 'var(--danger)' }}> *</span>}</>} error={errors[f.name]} hint={f.hint} full={f.full || f.type === 'textarea'}>{input}</Field>;
      })}
    </div>
  );
}

/** Drawer with a config-driven form. onSubmit gets cleaned values; server field errors are shown inline. */
export function FormDrawer({ open, onClose, title, fields, initial = {}, onSubmit, submitLabel = 'Save', children, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; fields: FieldDef[]; initial?: Record<string, any>;
  onSubmit: (values: Record<string, any>) => Promise<unknown>; submitLabel?: string; children?: (values: Record<string, any>) => ReactNode; wide?: boolean;
}) {
  const [values, setValues] = useState<Record<string, any>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setValues(initial); setErrors({}); } }, [open]);
  const submit = async () => {
    const errs: Record<string, string> = {};
    for (const f of fields) if (f.required && !f.hidden?.(values) && (values[f.name] === undefined || values[f.name] === null || values[f.name] === '' || (Array.isArray(values[f.name]) && !values[f.name].length))) errs[f.name] = `${f.label} is required`;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try { await onSubmit(values); onClose(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onClose={onClose} title={title} wide={wide} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{submitLabel}</Button></>}>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <FormFields fields={fields} values={values} setValues={setValues} errors={errors} />
        {children?.(values)}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
