import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Save, CalendarClock, Plus, X, Trash2, Send, FolderOpen, FilePlus2 } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, humanize, relTime } from '../../lib/format';
import { Button, Card, CardHeader, DateRangePicker, Dialog, Drawer, EmptyState, ErrorState, Field, LoadingBlock, PageHeader, Segmented, StatusPill, useConfirm, presetRange, type DateRange } from '../../components/ui';
import { TrackBars, TrendLine, fmtNum, fmtMoney, fmtHours } from '../../components/charts';
import { fmtValue, downloadPost } from '../home/kit';

interface FieldMeta { key: string; label: string; type: 'text' | 'number' | 'money' | 'date' | 'minutes' | 'bool'; options?: string[] }
interface EntityMeta { key: string; label: string; dateField: string; fields: FieldMeta[] }
interface Filter { field: string; op: string; value?: any }
interface Def { entity: string; fields: string[]; filters: Filter[]; group_by: string | null; metric: string | null; chart: 'table' | 'bar' | 'line' }

const OPS: Record<string, { key: string; label: string }[]> = {
  text: [{ key: 'eq', label: 'is' }, { key: 'neq', label: 'is not' }, { key: 'contains', label: 'contains' }, { key: 'in', label: 'is any of' }, { key: 'empty', label: 'is empty' }, { key: 'not_empty', label: 'is not empty' }],
  number: [{ key: 'eq', label: '=' }, { key: 'gt', label: '>' }, { key: 'gte', label: '≥' }, { key: 'lt', label: '<' }, { key: 'lte', label: '≤' }, { key: 'empty', label: 'is empty' }],
  date: [{ key: 'last_days', label: 'in the last (days)' }, { key: 'gte', label: 'on or after' }, { key: 'lte', label: 'on or before' }, { key: 'eq', label: 'on' }, { key: 'empty', label: 'is empty' }],
};
const opsFor = (t: string) => OPS[t === 'money' || t === 'minutes' ? 'number' : t === 'date' ? 'date' : t === 'number' ? 'number' : 'text'];
const blank = (e: EntityMeta): Def => ({ entity: e.key, fields: e.fields.slice(0, 5).map(f => f.key), filters: [], group_by: null, metric: 'count', chart: 'table' });

export default function Reports() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const confirm = useConfirm();
  const cat = useApi<{ entities: EntityMeta[]; canSave: boolean }>('/api/v1/reports/entities');
  const saved = useApi<{ rows: any[] }>('/api/v1/reports?pageSize=100');
  const reportId = sp.get('report');
  const [def, setDef] = useState<Def | null>(null);
  const [name, setName] = useState('');
  const [range, setRange] = useState<DateRange | null>(null);
  const [result, setResult] = useState<any>(null);
  const [runErr, setRunErr] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const entities = cat.data?.entities ?? [];
  const ent = entities.find(e => e.key === def?.entity);

  // Load a saved report (?report=id) or start with the first entity.
  useEffect(() => {
    if (!entities.length) return;
    if (reportId) {
      api.get<any>(`/api/v1/reports/${reportId}`).then(r => {
        const fs: Filter[] = r.filters ?? [];
        const e = entities.find(x => x.key === r.entity);
        const rf = e ? fs.find(f => f.field === e.dateField && f.op === 'between') : null;
        setRange(rf && Array.isArray(rf.value) ? { from: rf.value[0], to: rf.value[1] } : null);
        setDef({ entity: r.entity, fields: r.fields ?? [], filters: fs.filter(f => f !== rf), group_by: r.group_by, metric: r.metric ?? 'count', chart: r.chart ?? 'table' });
        setName(r.name);
      }).catch(e => { toast.error(e); setSp(new URLSearchParams(), { replace: true }); });
    } else if (!def) { setDef(blank(entities[0])); setName(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, entities.length]);

  const fullDef = useMemo(() => {
    if (!def || !ent) return null;
    const filters = [...def.filters.filter(f => f.field && (['empty', 'not_empty'].includes(f.op) || (f.value !== undefined && f.value !== '')))];
    if (range) filters.push({ field: ent.dateField, op: 'between', value: [range.from, range.to] });
    return { ...def, filters };
  }, [def, ent, range]);
  const dDef = useDebounced(JSON.stringify(fullDef), 350);
  useEffect(() => {
    if (!fullDef) return;
    let live = true;
    setRunning(true);
    api.post('/api/v1/reports/run', { ...fullDef, pageSize: 200 }).then(r => { if (live) { setResult(r); setRunErr(null); } }).catch(e => { if (live) setRunErr(e); }).finally(() => live && setRunning(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dDef]);

  const upd = (p: Partial<Def>) => setDef(d => (d ? { ...d, ...p } : d));
  const save = async (asNew: boolean, nm = name) => {
    if (!fullDef) return;
    try {
      if (reportId && !asNew) { await api.patch(`/api/v1/reports/${reportId}`, { ...fullDef, name: nm }); toast.success('Report saved'); }
      else { const r = await api.post<any>('/api/v1/reports', { ...fullDef, name: nm }); toast.success('Report saved'); setSp(new URLSearchParams({ report: r.id })); }
      setName(nm); saved.reload(); setSaveOpen(false);
    } catch (e) { toast.error(e); }
  };
  const exportCsv = async () => {
    if (!fullDef) return;
    try { await downloadPost('/api/v1/reports/export', { ...fullDef, name: name || ent?.label }, `${(name || ent?.label || 'report').toLowerCase().replace(/[^\w]+/g, '-')}.csv`); toast.success('Export downloaded'); } catch (e) { toast.error(e); }
  };
  const del = async (r: any) => {
    const c = await confirm({ title: `Delete "${r.name}"?`, body: 'Its schedules will stop. This cannot be undone.', danger: true, confirmLabel: 'Delete report' });
    if (!c.ok) return;
    try { await api.del(`/api/v1/reports/${r.id}`); toast.success('Report deleted'); saved.reload(); if (reportId === r.id) { setSp(new URLSearchParams()); setDef(entities[0] ? blank(entities[0]) : null); setName(''); } } catch (e) { toast.error(e); }
  };

  if (cat.error && !cat.data) return <><PageHeader title="Report Builder" /><ErrorState error={cat.error} retry={cat.reload} /></>;
  if (!cat.data || !def) return <><PageHeader title="Report Builder" /><LoadingBlock rows={8} /></>;
  if (!entities.length) return <><PageHeader title="Report Builder" /><EmptyState title="No reportable data for your role" /></>;
  const groupable = ent?.fields.filter(f => f.type === 'text' || f.type === 'date' || f.type === 'bool') ?? [];
  const numeric = ent?.fields.filter(f => ['number', 'money', 'minutes'].includes(f.type)) ?? [];
  const [gField, gGran] = (def.group_by ?? '').split(':');
  const gMeta = ent?.fields.find(f => f.key === gField);
  const metricMeta = def.metric && def.metric !== 'count' ? ent?.fields.find(f => f.key === def.metric!.split(':')[1]) : null;
  const vfmt = metricMeta?.type === 'money' ? fmtMoney : metricMeta?.type === 'minutes' ? fmtHours : fmtNum;

  return (
    <div>
      <PageHeader title={name || 'Report Builder'} sub={reportId ? 'Saved report — changes apply when you save' : 'Pick data → fields → filters → group by → chart or table. Save, export or schedule it.'}
        actions={<>
          <DateRangePicker value={range ?? { ...presetRange(3650), label: 'All time' }} onChange={setRange} />
          {range && <Button variant="ghost" size="sm" onClick={() => setRange(null)}>All time</Button>}
          <Button icon={<Download size={16} />} onClick={exportCsv} disabled={!result}>Export CSV</Button>
          {reportId && cat.data.canSave && <Button icon={<CalendarClock size={16} />} onClick={() => setSchedOpen(true)}>Schedule</Button>}
          {cat.data.canSave && <Button variant="primary" icon={<Save size={16} />} onClick={() => (reportId ? save(false) : setSaveOpen(true))}>{reportId ? 'Save' : 'Save report'}</Button>}
        </>} />

      <div className="ins-grid ins-builder">
        <div className="ins-col">
          <Card>
            <CardHeader title="Build" right={<Button size="xs" variant="ghost" icon={<FilePlus2 size={14} />} onClick={() => { setSp(new URLSearchParams()); setDef(blank(entities[0])); setName(''); setRange(null); }}>New</Button>} />
            <div className="card-b">
              <div className="ins-step">1 · Data</div>
              <Field label="Report on" htmlFor="rb-entity"><select id="rb-entity" className="select" value={def.entity} onChange={e => { const n = entities.find(x => x.key === e.target.value)!; setDef(blank(n)); }}>{entities.map(e => <option key={e.key} value={e.key}>{e.label}</option>)}</select></Field>
              <div className="ins-step">2 · Group by</div>
              <Field label="Group rows by" htmlFor="rb-group"><select id="rb-group" className="select" value={gField ?? ''} onChange={e => { const f = ent?.fields.find(x => x.key === e.target.value); upd({ group_by: e.target.value ? (f?.type === 'date' ? `${e.target.value}:month` : e.target.value) : null, chart: e.target.value ? (def.chart === 'table' ? 'bar' : def.chart) : 'table' }); }}><option value="">No grouping (list records)</option>{groupable.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select></Field>
              {gMeta?.type === 'date' && <div className="mb-2"><Segmented options={['day', 'week', 'month', 'year'].map(k => ({ key: k, label: humanize(k) }))} value={gGran || 'month'} onChange={k => upd({ group_by: `${gField}:${k}` })} /></div>}
              {def.group_by && <Field label="Metric" htmlFor="rb-metric"><select id="rb-metric" className="select" value={def.metric ?? 'count'} onChange={e => upd({ metric: e.target.value })}><option value="count">Count of records</option>{numeric.flatMap(f => ['sum', 'avg', 'max'].map(a => <option key={a + f.key} value={`${a}:${f.key}`}>{a === 'sum' ? 'Total' : a === 'avg' ? 'Average' : 'Max'} {f.label.toLowerCase()}</option>))}</select></Field>}
              {def.group_by && <><div className="ins-step">3 · Visualize</div><Segmented options={[{ key: 'bar', label: 'Bar' }, { key: 'line', label: 'Line' }, { key: 'table', label: 'Table' }]} value={def.chart} onChange={k => upd({ chart: k as Def['chart'] })} /></>}
              {!def.group_by && <>
                <div className="ins-step">3 · Columns</div>
                <div className="stack" style={{ gap: 6 }}>{ent?.fields.map(f => <label key={f.key} className="check"><input type="checkbox" checked={def.fields.includes(f.key)} onChange={e => upd({ fields: e.target.checked ? [...def.fields, f.key] : def.fields.filter(x => x !== f.key) })} /> {f.label}</label>)}</div>
              </>}
              <div className="ins-step">4 · Filters</div>
              {def.filters.map((f, i) => {
                const fm = ent?.fields.find(x => x.key === f.field);
                const setF = (p: Partial<Filter>) => upd({ filters: def.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <div key={i} className="ins-rule">
                    <div className="ins-rule-h"><select className="select input-sm" aria-label="Filter field" value={f.field} onChange={e => { const n = ent?.fields.find(x => x.key === e.target.value); setF({ field: e.target.value, op: opsFor(n?.type ?? 'text')[0].key, value: '' }); }}>{ent?.fields.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}</select><button className="icon-btn" aria-label="Remove filter" onClick={() => upd({ filters: def.filters.filter((_, j) => j !== i) })}><X size={16} /></button></div>
                    <div className="row" style={{ gap: 6 }}>
                      <select className="select input-sm" aria-label="Operator" value={f.op} onChange={e => setF({ op: e.target.value })} style={{ width: 'auto' }}>{opsFor(fm?.type ?? 'text').map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
                      {!['empty', 'not_empty'].includes(f.op) && (fm?.options && ['eq', 'neq'].includes(f.op)
                        ? <select className="select input-sm" aria-label="Value" value={f.value ?? ''} onChange={e => setF({ value: e.target.value })}><option value="">Choose…</option>{fm.options.map(o => <option key={o} value={o}>{humanize(o)}</option>)}</select>
                        : <input className="input input-sm" aria-label="Value" type={fm?.type === 'date' && f.op !== 'last_days' ? 'date' : ['number', 'money', 'minutes'].includes(fm?.type ?? '') || f.op === 'last_days' ? 'number' : 'text'} value={fm?.type === 'money' && f.value !== '' && f.value !== undefined ? Number(f.value) / 100 : f.value ?? ''} placeholder={f.op === 'in' ? 'a, b, c' : f.op === 'last_days' ? '30' : fm?.type === 'money' ? 'USD' : ''} onChange={e => setF({ value: fm?.type === 'money' && e.target.value !== '' ? Math.round(Number(e.target.value) * 100) : fm?.type === 'minutes' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />)}
                    </div>
                  </div>
                );
              })}
              <Button size="sm" icon={<Plus size={14} />} className="mt-2" onClick={() => ent && upd({ filters: [...def.filters, { field: ent.fields[0].key, op: opsFor(ent.fields[0].type)[0].key, value: '' }] })}>Add filter</Button>
            </div>
          </Card>
          <Card>
            <CardHeader title="Saved reports" sub={`${saved.data?.rows.length ?? 0} saved`} />
            {!saved.data ? <LoadingBlock rows={3} /> : saved.data.rows.length === 0 ? <EmptyState icon={<FolderOpen size={22} />} title="No saved reports" text="Build a report and save it to reuse, export or schedule it." /> : (
              <div className="ins-list">{saved.data.rows.map(r => (
                <div key={r.id} className="ins-item" style={{ cursor: 'pointer', background: r.id === reportId ? 'var(--primary-50)' : undefined }} onClick={() => setSp(new URLSearchParams({ report: r.id }))}>
                  <div style={{ flex: 1, minWidth: 0 }}><div className="t truncate">{r.name}</div><div className="s">{humanize(r.entity)} · {r.created_by_name ?? 'System'} · updated {relTime(r.updated_at)}{r.schedules ? ` · ${r.schedules} schedule${r.schedules === 1 ? '' : 's'}` : ''}</div></div>
                  {cat.data!.canSave && <button className="icon-btn" aria-label={`Delete ${r.name}`} onClick={e => { e.stopPropagation(); del(r); }}><Trash2 size={15} /></button>}
                </div>
              ))}</div>
            )}
          </Card>
        </div>
        <Card style={{ minWidth: 0 }}>
          <CardHeader title={result ? `${result.total.toLocaleString()} ${result.grouped ? 'groups' : 'records'}` : 'Results'} sub={running ? 'Running…' : range ? `${date(range.from)} – ${date(range.to)} by ${ent?.fields.find(f => f.key === ent.dateField)?.label.toLowerCase()}` : 'All time'} />
          <div className="card-b">
            {runErr && !result ? <ErrorState error={runErr} /> : !result ? <LoadingBlock rows={6} /> : (<>
              {runErr ? <div className="mb-2"><ErrorState error={runErr} /></div> : null}
              {result.grouped && def.chart !== 'table' && result.rows.length > 0 && (
                <div className="mb-3">{def.chart === 'bar'
                  ? <TrackBars data={result.rows.slice(0, 16).map((r: any) => ({ label: r.label, value: r.value }))} fmt={vfmt} valueName={result.columns[1].label} />
                  : <TrendLine data={result.rows.slice(0, 60).map((r: any) => ({ label: gMeta?.type === 'date' ? date(r.label, { month: 'short', day: gGran === 'day' || gGran === 'week' ? 'numeric' : undefined, year: gGran === 'year' ? 'numeric' : undefined }) : r.label, value: r.value }))} fmt={vfmt} />}</div>
              )}
              {result.rows.length === 0 ? <EmptyState title="No matching records" text="Try removing a filter or widening the date range." /> : (
                <div className="ins-table-scroll" style={{ maxHeight: 560, overflowY: 'auto' }}>
                  <table className="table">
                    <thead><tr>{result.columns.map((c: any) => <th key={c.key} style={{ textAlign: ['number', 'money', 'minutes'].includes(c.type) ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
                    <tbody>{result.rows.map((r: any, i: number) => (
                      <tr key={r.id ?? i} className={r.link ? 'clickable' : ''} onClick={() => r.link && nav(r.link)}>
                        {result.columns.map((c: any) => { const v = r[c.key]; const num_ = ['number', 'money', 'minutes'].includes(c.type); return <td key={c.key} style={{ textAlign: num_ ? 'right' : 'left' }} className={c.type === 'money' ? 'money' : ''}>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : c.type === 'date' ? date(String(v).slice(0, 10)) : num_ ? fmtValue(Number(v), c.type === 'minutes' ? 'hours' : c.type === 'money' ? 'money' : 'num') : c.key === 'status' || c.key === 'stage' || c.key === 'kind' ? <StatusPill status={String(v)} /> : String(v)}</td>; })}
                      </tr>
                    ))}</tbody>
                  </table>
                  {!result.grouped && result.total > result.rows.length && <div className="small muted" style={{ padding: 10 }}>Showing the first {result.rows.length} of {result.total.toLocaleString()} — export CSV for everything (up to 5,000 rows).</div>}
                </div>
              )}
            </>)}
          </div>
        </Card>
      </div>
      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} initial={name || `${ent?.label ?? 'Report'}${def.group_by ? ` by ${gMeta?.label.toLowerCase() ?? ''}` : ''}`} onSave={n => save(true, n)} />
      {reportId && <ScheduleDrawer open={schedOpen} onClose={() => setSchedOpen(false)} reportId={reportId} name={name} />}
    </div>
  );
}

function SaveDialog({ open, onClose, initial, onSave }: { open: boolean; onClose: () => void; initial: string; onSave: (n: string) => void }) {
  const [n, setN] = useState(initial);
  useEffect(() => { if (open) setN(initial); }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} title="Save report" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!n.trim()} onClick={() => onSave(n.trim())}>Save</Button></>}>
      <Field label="Report name" htmlFor="rb-name"><input id="rb-name" className="input" autoFocus value={n} onChange={e => setN(e.target.value)} onKeyDown={e => e.key === 'Enter' && n.trim() && onSave(n.trim())} /></Field>
    </Dialog>
  );
}

function ScheduleDrawer({ open, onClose, reportId, name }: { open: boolean; onClose: () => void; reportId: string; name: string }) {
  const st = useApi<any>(open ? `/api/v1/reports/${reportId}` : null, [open]);
  const [cadence, setCadence] = useState('weekly');
  const [recipients, setRecipients] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const add = async () => {
    const list = recipients.split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
    if (!list.length) { setErr('Add at least one email address'); return; }
    try { await api.post(`/api/v1/reports/${reportId}/schedules`, { cadence, recipients: list }); setRecipients(''); setErr(null); toast.success('Schedule added — first delivery within a minute'); st.reload(); }
    catch (e: any) { setErr(e?.fields ? Object.values(e.fields).join(', ') : e?.message); }
  };
  return (
    <Drawer open={open} onClose={onClose} title={`Schedule “${name}”`}>
      <p className="muted small" style={{ marginTop: 0 }}>Scheduled reports are rendered as a table and emailed to the recipients. In demo mode they land in the <a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a>.</p>
      <div className="form-grid">
        <Field label="Cadence" htmlFor="sc-cad"><select id="sc-cad" className="select" value={cadence} onChange={e => setCadence(e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
        <Field label="Recipients" htmlFor="sc-to" error={err} hint="Comma-separated emails" full><input id="sc-to" className="input" value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="ava@agency.com, mark@agency.com" /></Field>
      </div>
      <Button variant="primary" className="mt-2" icon={<Plus size={15} />} onClick={add}>Add schedule</Button>
      <div className="ins-step" style={{ marginTop: 26 }}>Active schedules</div>
      {!st.data ? <LoadingBlock rows={2} /> : st.data.schedules.length === 0 ? <div className="muted small">No schedules yet.</div> : st.data.schedules.map((s: any) => (
        <div key={s.id} className="ins-rule">
          <div className="ins-rule-h"><b>{humanize(s.cadence)} → {s.recipients.join(', ')}</b><StatusPill status={s.active ? 'active' : 'disabled'} /></div>
          <div className="small muted">Next: {dateTime(s.next_run_at)} · Last: {s.last_run_at ? `${dateTime(s.last_run_at)} (${s.last_status ?? '—'})` : 'never'}</div>
          <div className="row mt-1" style={{ gap: 6 }}>
            <Button size="xs" icon={<Send size={13} />} onClick={async () => { try { const r = await api.post<any>(`/api/v1/reports/schedules/${s.id}/send-now`); toast.success(r.error ? r.error : `Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'}`); st.reload(); } catch (e) { toast.error(e); } }}>Send now</Button>
            <Button size="xs" onClick={async () => { try { await api.patch(`/api/v1/reports/schedules/${s.id}`, { active: !s.active }); st.reload(); } catch (e) { toast.error(e); } }}>{s.active ? 'Pause' : 'Resume'}</Button>
            <Button size="xs" variant="ghost" icon={<Trash2 size={13} />} onClick={async () => { const c = await confirm({ title: 'Delete this schedule?', danger: true, confirmLabel: 'Delete' }); if (!c.ok) return; try { await api.del(`/api/v1/reports/schedules/${s.id}`); st.reload(); } catch (e) { toast.error(e); } }}>Delete</Button>
          </div>
        </div>
      ))}
    </Drawer>
  );
}
