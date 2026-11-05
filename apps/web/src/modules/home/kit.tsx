// Shared building blocks for INSIGHTS + OPS pages (KPI formatting, URL date ranges, attention lists, toggles, record picker).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, Users, Briefcase, UserSearch, Clock, DollarSign, Wallet, Percent, Building2, Target, CalendarClock, AlertTriangle, Receipt, FileText, TrendingUp } from 'lucide-react';
import { money, hours as fmtHours, num } from '../../lib/format';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { presetRange, type DateRange, type KpiItem } from '../../components/ui';
import './insights.css';

export interface ApiKpi { key: string; label: string; value: number; prev: number | null; delta: number | null; format: 'num' | 'money' | 'pct' | 'hours'; to: string; deltaLabel: string; invert?: boolean; hint?: string }

const ICONS: Record<string, ReactNode> = {
  active_clients: <Building2 size={16} />, active_workers: <Users size={16} />, open_positions: <Briefcase size={16} />, pipeline: <UserSearch size={16} />,
  hours_week: <Clock size={16} />, revenue_mtd: <DollarSign size={16} />, payroll_mtd: <Wallet size={16} />, margin_pct: <Percent size={16} />,
  applications_7d: <UserSearch size={16} />, interviews_week: <CalendarClock size={16} />, open_leads: <Target size={16} />, pipeline_value: <TrendingUp size={16} />,
  ar_open: <Receipt size={16} />, late_today: <AlertTriangle size={16} />, revenue: <DollarSign size={16} />, payroll: <Wallet size={16} />, gross_profit: <TrendingUp size={16} />,
  new_placements: <Users size={16} />, approved_hours: <Clock size={16} />, new_clients: <Building2 size={16} />, applications: <UserSearch size={16} />, applied: <UserSearch size={16} />,
  submitted: <FileText size={16} />, hired: <Users size={16} />, conversion: <Percent size={16} />, tracked: <Clock size={16} />, approved: <Clock size={16} />, utilization: <Activity size={16} />,
  turnover: <Users size={16} />, late: <AlertTriangle size={16} />, absent: <AlertTriangle size={16} />,
};

export function fmtValue(v: number | null | undefined, format: ApiKpi['format'] | 'minutes' | 'number' | 'text' | 'date', compact = false): string {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '—';
  if (format === 'money') return money(v, 'USD', compact ? { compact: true } : { noCents: true });
  if (format === 'pct') return `${Number(v).toFixed(1)}%`;
  if (format === 'hours' || format === 'minutes') return compact ? `${Math.round(v / 60).toLocaleString()}h` : fmtHours(v, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (format === 'text' || format === 'date') return String(v);
  return num(v);
}

/** Converts API KPIs into KpiRow items (every KPI links to the exact filtered list behind it). */
export function kpiItems(kpis: ApiKpi[]): KpiItem[] {
  return kpis.map(k => ({
    label: k.label, icon: ICONS[k.key], value: fmtValue(k.value, k.format), to: k.to, invert: k.invert,
    ...(k.delta !== null && k.delta !== undefined
      ? (k.format === 'pct' && /pts/.test(k.deltaLabel)
        ? { deltaText: <b className={(k.invert ? k.delta <= 0 : k.delta >= 0) ? 'up' : 'down'}>{k.delta >= 0 ? '+' : ''}{k.delta.toFixed(1)} pts</b>, suffix: k.deltaLabel.replace(/^pts\s*/, '') }
        : { delta: k.delta, suffix: k.deltaLabel })
      : { deltaText: <span className="muted">{k.deltaLabel}</span>, suffix: '' }),
  }));
}
export function chunk<T>(a: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

/** Date range kept in the URL (?from=&to=) so drill-downs and refreshes keep the same window. */
export function useUrlRange(defDays = 182): [DateRange, (r: DateRange) => void] {
  const [sp, setSp] = useSearchParams();
  const from = sp.get('from'), to = sp.get('to');
  const range = useMemo<DateRange>(() => {
    if (from && to) {
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
      const preset = [7, 30, 91, 182, 365].find(d => d === days && to === presetRange(d).to);
      const labels: Record<number, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 91: 'Last 3 months', 182: 'Last 6 months', 365: 'Last 12 months' };
      return { from, to, label: preset ? labels[preset] : undefined };
    }
    const labels: Record<number, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 91: 'Last 3 months', 182: 'Last 6 months', 365: 'Last 12 months' };
    return presetRange(defDays, labels[defDays]);
  }, [from, to, defDays]);
  const set = (r: DateRange) => { const n = new URLSearchParams(sp); n.set('from', r.from); n.set('to', r.to); setSp(n, { replace: true }); };
  return [range, set];
}

export interface AttentionItem { kind: string; title: string; subtitle: string | null; link: string | null; severity: 'danger' | 'warn' | 'info'; at: string | null }
export interface AttentionGroup { kind: string; label: string; count: number; items: AttentionItem[]; link: string }
export function AttentionList({ groups, showHeaders = true }: { groups: AttentionGroup[]; showHeaders?: boolean }) {
  return (
    <div className="ins-list">
      {groups.map(g => (
        <div key={g.kind}>
          {showHeaders && <div className="ins-group-h"><span>{g.label} · {g.count}</span>{g.count > g.items.length && <Link to={g.link}>View all</Link>}</div>}
          {g.items.map((it, i) => {
            const inner = <><span className={`ins-dot ${it.severity}`} aria-hidden /><div style={{ minWidth: 0 }}><div className="t">{it.title}</div>{it.subtitle && <div className="s truncate">{it.subtitle}</div>}</div></>;
            return it.link ? <Link key={i} to={it.link} className="ins-item">{inner}</Link> : <div key={i} className="ins-item">{inner}</div>;
          })}
        </div>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={`ins-toggle ${on ? 'on' : ''}`} onClick={e => { e.stopPropagation(); onChange(!on); }} />;
}

/** Record picker backed by global search (server-side permission filtering). */
export interface PickedRecord { type: string; id: string; title: string; subtitle?: string | null }
const SEARCH_TO_ENTITY: Record<string, string> = { client: 'company', lead: 'company', worker: 'worker', candidate: 'candidate', position: 'position', invoice: 'invoice', contact: 'contact' };
export function RecordPicker({ value, onChange, types, placeholder = 'Search a client, worker, candidate…', id }: { value: PickedRecord | null; onChange: (r: PickedRecord | null) => void; types?: string[]; placeholder?: string; id?: string }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (dq.trim().length < 2) { setRows([]); return; }
    let live = true;
    api.get<{ results: any[] }>(`/api/v1/search?q=${encodeURIComponent(dq)}&limit=6`).then(r => { if (live) setRows(r.results.filter(x => SEARCH_TO_ENTITY[x.type] && (!types || types.includes(SEARCH_TO_ENTITY[x.type])))); }).catch(() => setRows([]));
    return () => { live = false; };
  }, [dq, types?.join(',')]);
  if (value) return <div className="row" style={{ gap: 8, alignItems: 'center' }}><span className="chip" style={{ maxWidth: '100%' }}><b className="truncate">{value.title}</b>&nbsp;<span className="muted small">{value.type}</span></span><button type="button" className="btn btn-xs btn-ghost" onClick={() => onChange(null)}>Change</button></div>;
  return (
    <div style={{ position: 'relative' }}>
      <input id={id} className="input" value={q} placeholder={placeholder} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} autoComplete="off" />
      {open && rows.length > 0 && (
        <div className="menu left" style={{ width: '100%', maxHeight: 280, overflowY: 'auto' }} role="listbox">
          {rows.map(r => <button key={r.type + r.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange({ type: SEARCH_TO_ENTITY[r.type], id: r.id, title: r.title, subtitle: r.subtitle }); setQ(''); setOpen(false); }}><span style={{ flex: 1, minWidth: 0 }}><div className="bold truncate">{r.title}</div><div className="small muted truncate">{r.subtitle}</div></span><span className="pill pill-gray">{r.type}</span></button>)}
        </div>
      )}
      {open && dq.trim().length >= 2 && rows.length === 0 && <div className="small muted mt-1">No matching records you can access.</div>}
    </div>
  );
}

/** Downloads a server-generated CSV (POST) as a file. */
export async function downloadPost(url: string, body: unknown, filename: string) {
  const text = await api.post<string>(url, body);
  const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text)], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function downloadGet(url: string, filename: string) {
  const text = await api.get<string>(url);
  const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text)], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
