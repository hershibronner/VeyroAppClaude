// Smart import: drop the Excel/CSV from your old software → AI figures out what each tab is (positions,
// candidates, clients…), maps and cleans the columns → review → import everything through the Import Center engine.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, UploadCloud, Briefcase, Users, Building2, UserRound, Target, FileX2, CheckCircle2, AlertTriangle, Wand2, ArrowRight, RotateCcw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button, Card, PageHeader, StatusPill } from '../../components/ui';
import { toast } from '../../lib/toast';
import '../../pages/signup.css';

type Sheet = { sheet: string; entity: string; rows: number; notes: string[]; confidence: number; job_id: string | null; cleaned: boolean; headers: string[]; mapping: Record<string, string>; sample: string[][] };
type Result = { filename: string; engine: string; note: string | null; sheets: Sheet[]; entities: { key: string; label: string; fields: { key: string; label: string; required: boolean }[] }[] };
type Run = { status: string; processed: number; total: number; created: number; updated: number; duplicates: number; errors: number; message?: string };

const ICON: Record<string, any> = { positions: Briefcase, candidates: Users, clients: Building2, leads: Target, contacts: UserRound, skip: FileX2 };
const LINK: Record<string, string> = { positions: '/recruiting/positions', candidates: '/recruiting/candidates', clients: '/crm/clients', leads: '/crm/leads', contacts: '/crm/contacts' };
const READING = ['Opening every tab in your file', 'Working out what each tab contains', 'Matching your columns to VeyroApp fields', 'Cleaning names, rates and skills'];

export default function SmartImport() {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [importing, setImporting] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!busy) return; const t = setInterval(() => setTick(n => n + 1), 1400); return () => clearInterval(t); }, [busy]);

  const analyze = async (f: File) => {
    if (!/\.(xlsx|csv|tsv|txt)$/i.test(f.name)) { toast.error('Upload an .xlsx or .csv file (open older .xls files and "Save as" .xlsx)'); return; }
    setBusy(true); setRes(null); setRuns({}); setTick(0);
    try { const fd = new FormData(); fd.append('file', f, f.name); setRes(await api.upload<Result>('/api/v1/onboarding/smart-import', fd)); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const changeEntity = async (s: Sheet, entity: string) => {
    if (!s.job_id || entity === 'skip') { setRes(r => r && ({ ...r, sheets: r.sheets.map(x => (x === s ? { ...x, entity, job_id: entity === 'skip' ? null : x.job_id } : x)) })); return; }
    try { const r = await api.put<any>(`/api/v1/onboarding/smart-import/${s.job_id}/entity`, { entity }); setRes(x => x && ({ ...x, sheets: x.sheets.map(y => (y === s ? { ...y, entity: r.entity, mapping: r.mapping } : y)) })); }
    catch (e) { toast.error(e); }
  };

  const runOne = async (s: Sheet) => {
    const id = s.job_id!;
    const set = (r: Partial<Run>) => setRuns(x => ({ ...x, [id]: { ...(x[id] ?? { status: 'validating', processed: 0, total: s.rows, created: 0, updated: 0, duplicates: 0, errors: 0 }), ...r } }));
    try {
      set({ status: 'validating' });
      await api.post(`/api/v1/imports/${id}/validate`);
      set({ status: 'running' });
      await api.post(`/api/v1/imports/${id}/run`);
      for (;;) {
        await new Promise(r => setTimeout(r, 900));
        const j = await api.get<any>(`/api/v1/imports/${id}`);
        set({ status: j.status, processed: j.processed_rows, total: j.total_rows, created: j.created_rows, updated: j.updated_rows, duplicates: j.duplicate_rows, errors: j.error_rows });
        if (['completed', 'failed', 'interrupted'].includes(j.status)) break;
      }
    } catch (e) { set({ status: 'failed', message: e instanceof ApiError ? e.message : 'Import failed' }); }
  };
  const importAll = async () => {
    if (!res) return;
    setImporting(true);
    for (const s of res.sheets.filter(s => s.job_id && s.entity !== 'skip')) await runOne(s); // clients first, so positions can link to them
    setImporting(false);
    toast.success('Import finished');
  };
  const todo = res?.sheets.filter(s => s.job_id && s.entity !== 'skip') ?? [];
  const finished = todo.length > 0 && todo.every(s => ['completed', 'failed', 'interrupted'].includes(runs[s.job_id!]?.status ?? ''));
  const totals = todo.reduce((a, s) => { const r = runs[s.job_id!]; return r ? { created: a.created + r.created, updated: a.updated + r.updated, duplicates: a.duplicates + r.duplicates, errors: a.errors + r.errors } : a; }, { created: 0, updated: 0, duplicates: 0, errors: 0 });

  return (
    <div>
      <PageHeader title={<><Sparkles size={20} style={{ verticalAlign: -3, color: 'var(--primary)' }} /> Import your data with AI</>} sub="Upload the Excel or CSV export from your current software. AI works out which tabs are positions, candidates and clients, matches the columns and cleans the values — you review before anything is saved." back="/" />
      {!res && !busy && (
        <Card pad>
          <label className={`smart-drop ${over ? 'on' : ''}`} tabIndex={0} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) analyze(f); }}>
            <input type="file" hidden accept=".xlsx,.csv,.tsv,.txt" onChange={e => { const f = e.target.files?.[0]; if (f) analyze(f); e.target.value = ''; }} />
            <span className="ic"><UploadCloud size={30} /></span>
            <b>Drop your spreadsheet here</b>
            <span className="small muted">or click to browse · .xlsx (all tabs) or .csv · up to 20,000 rows</span>
            <span className="small muted">Works with exports from Bullhorn, Recruit CRM, Zoho Recruit, Google Sheets and more.</span>
          </label>
        </Card>
      )}
      {busy && (
        <Card pad><div className="smart-reading" aria-live="polite">
          <div className="scan" aria-hidden>{[14, 28, 42, 56, 70, 84].map(t => <i key={t} style={{ top: t, right: t % 28 ? 12 : 30 }} />)}</div>
          <b>Reading your file…</b>
          <ul>{READING.slice(0, Math.min(READING.length, tick + 1)).map((r, i) => <li key={r} style={{ ['--d' as any]: `${i * 60}ms` }}>{i < tick ? '✓' : '…'} {r}</li>)}</ul>
          <span className="small muted">Large files with messy data can take a minute.</span>
        </div></Card>
      )}
      {res && (
        <>
          {res.note && <div className="banner warn"><AlertTriangle size={16} className="ic" /><div>{res.note}</div></div>}
          <Card pad>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div><div className="card-title-lg"><Wand2 size={16} /> {res.filename}</div>
                <div className="small muted">{res.sheets.length} tab{res.sheets.length === 1 ? '' : 's'} found · {res.engine.startsWith('claude') ? <>read by AI (<code>{res.engine}</code>)</> : 'matched by column names'}</div></div>
              <div className="row" style={{ gap: 8 }}>
                <Button icon={<RotateCcw size={15} />} onClick={() => { setRes(null); setRuns({}); }} disabled={importing}>Upload a different file</Button>
                {!finished && <Button variant="primary" icon={<ArrowRight size={15} />} loading={importing} disabled={!todo.length} onClick={importAll}>Import {todo.reduce((a, s) => a + s.rows, 0)} rows</Button>}
              </div>
            </div>
            {res.sheets.map((s, i) => { const Ic = ICON[s.entity] ?? FileX2; const r = s.job_id ? runs[s.job_id] : undefined; const def = res.entities.find(e => e.key === s.entity); return (
              <div key={s.sheet} className={`smart-sheet ${s.entity === 'skip' ? 'skip' : ''}`} style={{ ['--d' as any]: `${i * 70}ms` }}>
                <div className="smart-sheet-head">
                  <span className="ic"><Ic size={19} /></span>
                  <div className="grow"><b>{s.sheet}</b><div className="small muted">{s.rows} row{s.rows === 1 ? '' : 's'}{s.cleaned ? ' · cleaned by AI' : ''}{s.entity !== 'skip' && s.confidence ? ` · ${Math.round(s.confidence * 100)}% sure` : ''}</div></div>
                  <label className="small muted" htmlFor={`ent-${i}`}>Import as</label>
                  <select id={`ent-${i}`} className="input" style={{ width: 170 }} value={s.entity} disabled={!!r || importing} onChange={e => changeEntity(s, e.target.value)}>
                    {res.entities.map(e => <option key={e.key} value={e.key}>{e.label}</option>)}
                    <option value="skip">Don't import</option>
                  </select>
                </div>
                {s.entity !== 'skip' && def && <div className="smart-map">{def.fields.filter(f => s.mapping[f.key]).map(f => <span key={f.key}><b>{f.label}</b> ← {s.mapping[f.key]}</span>)}
                  {def.fields.filter(f => f.required && !s.mapping[f.key]).map(f => <span key={f.key} style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Missing: {f.label}</span>)}</div>}
                {s.notes.length > 0 && <ul className="smart-notes">{s.notes.map(n => <li key={n}>{n}</li>)}</ul>}
                {s.entity !== 'skip' && s.sample.length > 0 && !r && <div className="smart-table"><table><thead><tr>{s.headers.slice(0, 8).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{s.sample.map((row, k) => <tr key={k}>{s.headers.slice(0, 8).map((h, ci) => <td key={h} title={row[ci]}>{row[ci] || '—'}</td>)}</tr>)}</tbody></table></div>}
                {r && <>
                  <div className="smart-bar"><b style={{ width: `${r.status === 'completed' ? 100 : Math.round((r.processed / Math.max(1, r.total)) * 100)}%` }} /></div>
                  <div className="smart-result">
                    <StatusPill status={r.status === 'completed' ? 'active' : r.status === 'failed' ? 'at_risk' : 'pending'} label={r.status === 'validating' ? 'Checking rows…' : r.status === 'running' ? `Importing ${r.processed}/${r.total}` : r.status === 'completed' ? 'Imported' : r.message ?? 'Failed'} />
                    {r.created > 0 && <span>{r.created} created</span>}{r.updated > 0 && <span>· {r.updated} updated</span>}{r.duplicates > 0 && <span>· {r.duplicates} already existed</span>}
                    {r.errors > 0 && <Link to={`/settings/import?job=${s.job_id}`}>· {r.errors} with errors — review</Link>}
                  </div>
                </>}
              </div>); })}
          </Card>
          {finished && (
            <Card pad className="mt-3"><div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <CheckCircle2 size={34} style={{ color: 'var(--success)' }} />
              <div style={{ flex: 1, minWidth: 220 }}><div className="card-title-lg">Your data is in VeyroApp</div><div className="small muted">{totals.created} created · {totals.updated} updated · {totals.duplicates} already existed{totals.errors ? ` · ${totals.errors} need attention` : ''}</div></div>
              {[...new Set(todo.map(s => s.entity))].map(e => LINK[e] && <Link key={e} to={LINK[e]} className="btn btn-outline">View {res.entities.find(x => x.key === e)?.label.toLowerCase()}</Link>)}
            </div></Card>
          )}
        </>
      )}
    </div>
  );
}
