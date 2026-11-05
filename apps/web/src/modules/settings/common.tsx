import { useEffect, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { Banner, Button, Card, CardHeader, Field, LoadingBlock, ErrorState, PermissionDenied } from '../../components/ui';
import './settings.css';

/** Renders children only when the role can view `resource`; passes whether it may edit. */
export function Gate({ resource, children, also }: { resource: string; also?: string; children: (editable: boolean) => ReactNode }) {
  const { can } = useAuth();
  const view = can(resource, 'view') || (also ? can(also, 'view') : false);
  if (!view) return <PermissionDenied text={`Your role does not include ${resource.replace('_', ' ')} settings. Ask an Owner or Admin if you need access.`} />;
  return <>{children(can(resource, 'edit') || (also ? can(also, 'edit') : false))}</>;
}

export function ReadOnlyNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <Banner tone="info" icon={<Lock size={18} />}>You can view these settings. Only roles with edit access (Owner, Admin) can change them.</Banner>;
}

export function Toggle({ checked, onChange, label, hint, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; id?: string }) {
  const tid = id ?? `t-${String(label).replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label className="st-toggle" htmlFor={tid}>
      <span style={{ flex: 1, minWidth: 0 }}><span className="bold small">{label}</span>{hint && <span className="small muted" style={{ display: 'block' }}>{hint}</span>}</span>
      <input id={tid} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="st-switch" aria-hidden />
    </label>
  );
}

/** Generic editor for an org_settings key. `render` receives the draft and a setter. */
export function SettingsForm<T extends Record<string, any>>({ settingKey, title, sub, render, editable, after }: { settingKey: string; title: string; sub?: ReactNode; editable: boolean; render: (v: T, set: (patch: Partial<T>) => void, errors: Record<string, string>, meta: any) => ReactNode; after?: (meta: any) => ReactNode }) {
  const st = useApi<{ value: T; editable: boolean } & Record<string, any>>(`/api/v1/settings/values/${settingKey}`);
  const [draft, setDraft] = useState<T | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setDraft(st.data.value); }, [st.data]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!draft || !st.data) return <Card><LoadingBlock rows={5} /></Card>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(st.data.value);
  const save = async () => {
    setBusy(true); setErrors({});
    try { await api.put(`/api/v1/settings/values/${settingKey}`, draft); toast.success(`${title} saved`); st.reload(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <>
      <Card>
        <CardHeader title={title} sub={sub} right={editable && <><Button size="sm" disabled={!dirty || busy} onClick={() => { setDraft(st.data!.value); setErrors({}); }}>Discard</Button><Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={save}>Save changes</Button></>} />
        <div className="card-b"><fieldset disabled={!editable} className="st-fieldset">{render(draft, p => setDraft(d => ({ ...(d as T), ...p })), errors, st.data)}</fieldset></div>
      </Card>
      {after?.(st.data)}
    </>
  );
}

export function NumField({ label, value, onChange, min, max, suffix, hint, error, id, step }: { label: string; value: number | undefined; onChange: (n: number) => void; min?: number; max?: number; suffix?: string; hint?: ReactNode; error?: string; id: string; step?: number }) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input id={id} type="number" className={`input ${error ? 'invalid' : ''}`} value={value ?? ''} min={min} max={max} step={step} onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
        {suffix && <span className="small muted nowrap">{suffix}</span>}
      </div>
    </Field>
  );
}

export const bpToPct = (bp: number | undefined) => ((bp ?? 0) / 100);
export const pctToBp = (p: number) => Math.round(p * 100);

export function CopyField({ value, label }: { value: string; label?: string }) {
  return (
    <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
      <input className="input mono" readOnly value={value} aria-label={label ?? 'Value'} onFocus={e => e.target.select()} />
      <Button onClick={() => { navigator.clipboard?.writeText(value).then(() => toast.success('Copied'), () => toast.error('Copy failed — select and copy manually')); }}>Copy</Button>
    </div>
  );
}
