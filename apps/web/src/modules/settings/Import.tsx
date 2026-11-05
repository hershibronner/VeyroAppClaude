import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Copy, Download, FileSpreadsheet, Pause, Play, RotateCcw, Upload, Wand2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { realtime } from '../../lib/realtime';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { dateTime, humanize, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, ErrorState, Field, KpiRow, LoadingBlock, PageHeader, StatusPill, Segmented, PermissionDenied } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';

export default function ImportCenter() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const job = sp.get('job');
  if (!can('imports')) return <PermissionDenied text="Your role cannot use the Import Center. Ask an Owner or Admin." />;
  return job ? <JobView id={job} onBack={() => setSp({})} /> : <ImportList onOpen={id => setSp({ job: id })} />;
}

function ImportList({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAuth();
  const ents = useApi<any[]>('/api/v1/imports/entities');
  const [entity, setEntity] = useState('leads');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const def = ents.data?.find(e => e.key === entity);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try { const fd = new FormData(); fd.append('entity', entity); fd.append('file', file); const r = await api.upload('/api/v1/imports', fd); toast.success('File uploaded — confirm the column mapping'); onOpen(r.id); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title="Import Center" sub="Migrate from spreadsheets or another system. Every import is previewed, validated and de-duplicated before anything is written." />
      {can('imports', 'create') && <Card>
        <CardHeader title="New import" sub="CSV (comma, semicolon or tab separated) or Excel .xlsx (first sheet). Up to 20,000 rows per file." />
        <div className="card-b stack" style={{ gap: 16 }}>
          <div className="form-grid">
            <Field label="What are you importing?" htmlFor="im-ent"><select id="im-ent" className="select" value={entity} onChange={e => setEntity(e.target.value)}>{(ents.data ?? []).map(e => <option key={e.key} value={e.key} disabled={!e.allowed}>{e.label}{e.allowed ? '' : ' (no permission)'}</option>)}</select></Field>
            <Field label="File" htmlFor="im-file">
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input ref={ref} id="im-file" type="file" accept=".csv,.tsv,.txt,.xlsx" hidden onChange={e => setFile(e.target.files?.[0] ?? null)} />
                <Button icon={<FileSpreadsheet size={16} />} onClick={() => ref.current?.click()}>{file ? 'Change file' : 'Choose file'}</Button>
                <span className="small truncate">{file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : <span className="muted">No file chosen</span>}</span>
              </div>
            </Field>
          </div>
          {def && <div className="small muted">Fields: {def.fields.map((f: any) => `${f.label}${f.required ? ' *' : ''}`).join(' · ')}. Duplicates are detected by {def.dupeKeys}. {entity === 'placements' || entity === 'rates' ? 'Import workers and clients first so references resolve.' : ''}</div>}
          <div className="row"><Button variant="primary" icon={<Upload size={16} />} disabled={!file} loading={busy} onClick={upload}>Upload & map columns</Button><a className="btn btn-ghost" href={`/api/v1/imports/templates/${entity}`} download><Download size={16} /> Download {def?.label ?? ''} template</a></div>
        </div>
      </Card>}
      <DataTable<any> title="Import history" endpoint="/api/v1/imports" exportName="imports" onRowClick={r => onOpen(r.id)}
        filters={[{ key: 'status', label: 'Status', options: opts(['uploaded', 'mapped', 'dry_run', 'running', 'interrupted', 'completed', 'failed']) }, { key: 'entity', label: 'Entity', options: opts(['leads', 'clients', 'contacts', 'candidates', 'workers', 'placements', 'rates']) }]}
        emptyTitle="No imports yet" emptyText="Upload your first file above."
        columns={[
          { key: 'filename', label: 'File', sortable: true, mobile: 'title', render: r => <span className="bold">{r.filename}</span> },
          { key: 'entity', label: 'Entity', mobile: 'subtitle', render: r => humanize(r.entity) },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
          { key: 'total_rows', label: 'Rows', sortable: true, align: 'right' },
          { key: 'created_rows', label: 'Created', align: 'right' },
          { key: 'updated_rows', label: 'Updated', align: 'right' },
          { key: 'duplicate_rows', label: 'Duplicates', align: 'right' },
          { key: 'error_rows', label: 'Errors', align: 'right', render: r => r.error_rows ? <b style={{ color: 'var(--danger)' }}>{r.error_rows}</b> : '0' },
          { key: 'created_by_name', label: 'By' },
          { key: 'created_at', label: 'Started', sortable: true, render: r => relTime(r.created_at) },
        ]} />
    </div>
  );
}

const STEPS = [{ k: 'map', label: 'Map columns' }, { k: 'validate', label: 'Validate & dry run' }, { k: 'run', label: 'Import' }, { k: 'done', label: 'Report' }];
function stepOf(status: string) { return status === 'uploaded' || status === 'mapped' ? (status === 'mapped' ? 1 : 0) : status === 'dry_run' ? 2 : status === 'running' || status === 'interrupted' ? 2 : 3; }

function JobView({ id, onBack }: { id: string; onBack: () => void }) {
  const st = useApi<any>(`/api/v1/imports/${id}`, [id]);
  const [live, setLive] = useState<any>(null);
  const [rk, setRk] = useState(0);
  const j = st.data;
  useEffect(() => realtime.on('job', d => { if (d.importId === id) { setLive(d); if (d.progress >= 100) { st.reload(); setRk(k => k + 1); } } }), [id, st]);
  useInterval(() => { st.reload(); }, j?.status === 'running' ? 2500 : null);
  if (st.error && !st.data) return <div className="stack"><PageHeader title="Import" back="/settings/import" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!j) return <div className="stack"><PageHeader title="Import" back="/settings/import" /><Card><LoadingBlock rows={8} /></Card></div>;
  const step = stepOf(j.status);
  const reload = () => { st.reload(); setRk(k => k + 1); };
  return (
    <div className="stack">
      <PageHeader title={j.filename} back="/settings/import" sub={`${j.definition.label} · ${j.total_rows.toLocaleString()} rows · uploaded by ${j.created_by_name ?? '—'} ${relTime(j.created_at)}`} actions={<><Button onClick={onBack}>All imports</Button>{j.status !== 'uploaded' && <a className="btn" href={`/api/v1/imports/${j.id}/errors.csv`}><Download size={16} /> Row report (CSV)</a>}</>} />
      <div className="st-steps">{STEPS.map((s, i) => <span key={s.k} className={`st-step ${i < step ? 'done' : i === step ? 'on' : ''}`}><b>{i < step ? '✓' : i + 1}</b>{s.label}</span>)}</div>
      {j.last_error && j.status === 'interrupted' && <Banner tone="warn">{j.last_error}</Banner>}
      {(j.status === 'uploaded' || j.status === 'mapped' || j.status === 'dry_run') && <MapStep job={j} onSaved={reload} />}
      {(j.status === 'mapped' || j.status === 'dry_run') && <ValidateStep job={j} onDone={reload} rk={rk} />}
      {['running', 'interrupted', 'completed', 'failed'].includes(j.status) && <RunStep job={j} live={live} onChange={reload} rk={rk} />}
    </div>
  );
}

function MapStep({ job, onSaved }: { job: any; onSaved: () => void }) {
  const [mapping, setMapping] = useState<Record<string, string>>(job.mapping ?? {});
  const [onDup, setOnDup] = useState<'skip' | 'update'>(job.options?.on_duplicate ?? 'skip');
  const [saveAs, setSaveAs] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(job.status === 'uploaded');
  const fields = job.definition.fields as any[];
  const used = new Set(Object.values(mapping));
  const save = async () => {
    setBusy(true); setErrors({});
    try { await api.put(`/api/v1/imports/${job.id}/mapping`, { mapping, on_duplicate: onDup, save_as: saveAs.trim() || undefined }); toast.success(saveAs ? `Mapping saved as “${saveAs}”` : 'Mapping confirmed'); setOpen(false); onSaved(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  if (!open) return <Card><CardHeader title="Column mapping" sub={`${Object.keys(job.mapping).length} of ${fields.length} fields mapped · duplicates: ${job.options?.on_duplicate === 'update' ? 'update existing records' : 'skip'}`} right={<Button size="sm" onClick={() => setOpen(true)}>Change mapping</Button>} /></Card>;
  return (
    <Card>
      <CardHeader title="1. Map your columns" sub={job.options?.mapping_source && job.options.mapping_source !== 'auto' ? `Applied your saved mapping “${job.options.mapping_source}”.` : 'We matched columns by name — check each one.'}
        right={job.mappings?.length > 0 && <select className="select input-sm" style={{ width: 'auto' }} aria-label="Apply a saved mapping" value="" onChange={e => { const m = job.mappings.find((x: any) => x.id === e.target.value); if (m) { setMapping(Object.fromEntries(Object.entries(m.mapping as Record<string, string>).filter(([, h]) => job.headers.includes(h)))); toast.info(`Applied “${m.name}”`); } }}><option value="">Apply saved mapping…</option>{job.mappings.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>} />
      <div className="table-wrap"><table className="table">
        <thead><tr><th>VeyroApp field</th><th>Column in your file</th><th>Sample values</th></tr></thead>
        <tbody>{fields.map(f => (
          <tr key={f.key}>
            <td><div className="bold small">{f.label}{f.required && <span style={{ color: 'var(--danger)' }}> *</span>}</div>{f.hint && <div className="tiny muted">{f.hint}</div>}{errors[f.key] && <div className="tiny" style={{ color: 'var(--danger)' }}>{errors[f.key]}</div>}</td>
            <td style={{ minWidth: 200 }}><select className={`select input-sm ${errors[f.key] ? 'invalid' : ''}`} aria-label={`Column for ${f.label}`} value={mapping[f.key] ?? ''} onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value) n[f.key] = e.target.value; else delete n[f.key]; return n; })}>
              <option value="">— Don't import —</option>{job.headers.map((h: string) => <option key={h} value={h} disabled={used.has(h) && mapping[f.key] !== h}>{h}</option>)}
            </select></td>
            <td className="small muted truncate" style={{ maxWidth: 320 }}>{mapping[f.key] ? job.sample.map((s: any) => s.data[mapping[f.key]]).filter(Boolean).slice(0, 3).join(' · ') || '(empty)' : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="card-b row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 16 }}>
          {job.definition.allowUpdate && <div className="row" style={{ gap: 8 }}><span className="small bold">When a record already exists</span><Segmented value={onDup} onChange={setOnDup} options={[{ key: 'skip', label: 'Skip it' }, { key: 'update', label: 'Update it' }]} /></div>}
          <input className="input input-sm" style={{ width: 220 }} placeholder="Save mapping as… (optional)" aria-label="Save mapping as" value={saveAs} onChange={e => setSaveAs(e.target.value)} />
        </div>
        <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={busy} onClick={save}>Confirm mapping</Button>
      </div>
      {job.headers.filter((h: string) => !used.has(h)).length > 0 && <div className="card-b small muted" style={{ paddingTop: 0 }}>Not imported: {job.headers.filter((h: string) => !used.has(h)).join(', ')}</div>}
    </Card>
  );
}

function ValidateStep({ job, onDone, rk }: { job: any; onDone: () => void; rk: number }) {
  const [busy, setBusy] = useState('');
  const r = job.dry_run_result;
  const validate = async () => { setBusy('v'); try { const s = await api.post(`/api/v1/imports/${job.id}/validate`); toast.success(`Dry run: ${s.create} to create, ${s.update} to update, ${s.skip_duplicate} duplicates, ${s.error} errors`); onDone(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const run = async () => { setBusy('r'); try { await api.post(`/api/v1/imports/${job.id}/run`); toast.success('Import started — you can leave this page, we will notify you when it finishes'); onDone(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <Card>
      <CardHeader title="2. Validate & dry run" sub="Nothing is written yet. Every row is checked for required fields, formats, references and duplicates (in your file and in VeyroApp)."
        right={<><Button icon={<Wand2 size={16} />} loading={busy === 'v'} onClick={validate}>{r ? 'Re-run dry run' : 'Run dry run'}</Button>{r && job.can_run && <Button variant="primary" icon={<Play size={16} />} loading={busy === 'r'} disabled={!r.create && !r.update} onClick={run}>Import {(r.create + r.update).toLocaleString()} row{r.create + r.update === 1 ? '' : 's'}</Button>}</>} />
      {r ? <>
        <div className="card-b" style={{ paddingBottom: 0 }}><KpiRow compact items={[
          { label: 'Will be created', value: r.create, icon: <CheckCircle2 size={16} /> }, { label: 'Will update existing', value: r.update, icon: <RotateCcw size={16} /> },
          { label: 'Duplicates skipped', value: r.skip_duplicate, icon: <Copy size={16} /> }, { label: 'Rows with errors', value: r.error, icon: <AlertTriangle size={16} /> },
        ]} /></div>
        {r.error > 0 && <div className="card-b" style={{ paddingBottom: 0 }}><Banner tone="warn">{r.error} row{r.error === 1 ? '' : 's'} will not be imported. Fix them in your file and upload again, or import the valid rows now and retry the failed ones later.</Banner></div>}
        <DataTable<any> noCard urlState={false} reloadKey={rk + JSON.stringify(r)} endpoint={`/api/v1/imports/${job.id}/rows`} pageSize={10} searchPlaceholder="Search rows"
          filters={[{ key: 'planned', label: 'Result', options: [{ value: 'create', label: 'Create' }, { value: 'update', label: 'Update' }, { value: 'skip_duplicate', label: 'Duplicate' }, { value: 'error', label: 'Error' }] }, { key: 'warnings', label: 'Warnings', type: 'boolean' }]}
          columns={rowColumns(job)} />
      </> : <div className="card-b small muted">Run the dry run to see exactly what will happen to each of the {job.total_rows.toLocaleString()} rows.</div>}
    </Card>
  );
}

function rowColumns(job: any) {
  const shown = Object.values(job.mapping as Record<string, string>).slice(0, 3);
  return [
    { key: 'row_number', label: 'Row', width: 60, mobile: 'subtitle' as const },
    { key: 'planned_action', label: 'Result', mobile: 'title' as const, render: (r: any) => { const s = r.status === 'pending' ? r.planned_action : r.status; return <StatusPill status={s === 'create' || s === 'created' ? 'completed' : s === 'update' || s === 'updated' ? 'processing' : s === 'error' ? 'error' : s === 'skip_duplicate' || s === 'duplicate' ? 'skipped' : s} label={humanize(s === 'skip_duplicate' ? 'duplicate' : s) || 'Not checked'} />; } },
    ...shown.map(h => ({ key: `c_${h}`, label: h, render: (r: any) => r.data?.[h] || <span className="muted">—</span> })),
    { key: 'error', label: 'Details', render: (r: any) => <span className="small">{r.error && <span style={{ color: 'var(--danger)' }}>{r.error}</span>}{r.error && r.warning ? ' · ' : ''}{r.warning && <span className="muted">{r.warning}</span>}{!r.error && !r.warning && <span className="muted">—</span>}</span> },
  ];
}

function RunStep({ job, live, onChange, rk }: { job: any; live: any; onChange: () => void; rk: number }) {
  const [busy, setBusy] = useState('');
  const processed = Math.max(live?.processed ?? 0, job.processed_rows);
  const pct = job.status === 'completed' || job.status === 'failed' ? 100 : Math.floor((processed / Math.max(1, job.total_rows)) * 100);
  const c = job.counts;
  const act = async (a: string, msg: string) => { setBusy(a); try { await api.post(`/api/v1/imports/${job.id}/${a}`); toast.success(msg); onChange(); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <Card>
      <CardHeader title={job.status === 'running' ? '3. Importing…' : job.status === 'interrupted' ? '3. Import paused' : '4. Import report'} sub={job.finished_at ? `Finished ${dateTime(job.finished_at)} · run ${job.runs} time${job.runs === 1 ? '' : 's'}` : job.started_at ? `Started ${relTime(job.started_at)}` : undefined}
        right={<>
          {job.status === 'running' && <Button icon={<Pause size={16} />} loading={busy === 'pause'} onClick={() => act('pause', 'Import paused — completed rows are kept')}>Pause</Button>}
          {job.status === 'interrupted' && job.can_run && <Button variant="primary" icon={<Play size={16} />} loading={busy === 'resume'} onClick={() => act('resume', `Resuming from row ${job.processed_rows + 1}`)}>Resume</Button>}
          {['completed', 'failed'].includes(job.status) && c.error > 0 && job.can_run && <Button variant="primary" icon={<RotateCcw size={16} />} loading={busy === 'retry'} onClick={() => act('retry', 'Retrying failed rows — rows already imported are never duplicated')}>Retry {c.error} failed row{c.error === 1 ? '' : 's'}</Button>}
        </>} />
      <div className="card-b stack" style={{ gap: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="small bold">{processed.toLocaleString()} of {job.total_rows.toLocaleString()} rows processed</span><StatusPill status={job.status} /></div>
        <div className="st-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
        <KpiRow compact items={[
          { label: 'Created', value: c.created, icon: <CheckCircle2 size={16} /> }, { label: 'Updated', value: c.updated, icon: <RotateCcw size={16} /> },
          { label: 'Duplicates skipped', value: c.duplicate, icon: <Copy size={16} /> }, { label: 'Errors', value: c.error, icon: <AlertTriangle size={16} /> },
        ]} />
        {job.status === 'completed' && <Banner tone={c.error ? 'warn' : 'success'}>{c.created + c.updated} record{c.created + c.updated === 1 ? '' : 's'} imported{c.error ? `; ${c.error} row${c.error === 1 ? '' : 's'} failed — download the row report, fix and retry` : ''}. Legacy IDs were preserved on every record.</Banner>}
      </div>
      <DataTable<any> noCard urlState={false} reloadKey={`${rk}-${job.status}-${processed}`} endpoint={`/api/v1/imports/${job.id}/rows`} pageSize={10} searchPlaceholder="Search rows"
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'created', 'updated', 'duplicate', 'error']) }]} columns={rowColumns(job)} />
    </Card>
  );
}
