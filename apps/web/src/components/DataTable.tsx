import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Filter, X, CheckSquare } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useApi, useDebounced } from '../lib/hooks';
import { downloadText, toCsv } from '../lib/format';
import { toast } from '../lib/toast';
import { Button, Card, EmptyState, ErrorState, Menu, SearchInput, Skeleton, Drawer, type MenuItem } from './ui';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** On mobile cards: 'title' (main line), 'subtitle', 'meta' (label: value rows, default) or 'hidden'. */
  mobile?: 'title' | 'subtitle' | 'meta' | 'hidden';
  /** CSV value for exports (defaults to row[key]). */
  csv?: (row: T) => unknown;
  hidden?: boolean;
}
export interface FilterDef { key: string; label: string; options?: { value: string; label: string }[]; type?: 'select' | 'member' | 'date' | 'text' | 'boolean' }
export interface BulkAction { label: string; icon?: ReactNode; danger?: boolean; onClick: (ids: string[], reload: () => void) => void | Promise<void> }

export interface DataTableProps<T extends { id: string }> {
  title?: ReactNode;
  endpoint: string;
  columns: Column<T>[];
  filters?: FilterDef[];
  /** Fixed query params always sent (not shown as filters). */
  params?: Record<string, string | number | boolean | undefined | null>;
  rowLink?: (row: T) => string | null;
  onRowClick?: (row: T) => void;
  rowActions?: (row: T, reload: () => void) => MenuItem[];
  bulkActions?: BulkAction[];
  toolbar?: ReactNode;
  exportName?: string;
  exportResource?: string;
  emptyTitle?: string;
  emptyText?: ReactNode;
  emptyAction?: ReactNode;
  defaultSort?: string;
  defaultDir?: 'asc' | 'desc';
  pageSize?: number;
  searchPlaceholder?: string;
  /** Persist search/filter/sort/page in the URL (default true). */
  urlState?: boolean;
  reloadKey?: unknown;
  /** Rendered above rows (e.g. view switcher). */
  headerExtra?: ReactNode;
  noCard?: boolean;
}

export function DataTable<T extends { id: string }>(p: DataTableProps<T>) {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const useUrl = p.urlState !== false;
  const [localState, setLocalState] = useState<Record<string, string>>({});
  const get = (k: string) => (useUrl ? sp.get(k) ?? '' : localState[k] ?? '');
  const set = (patch: Record<string, string | null>) => {
    if (useUrl) {
      const n = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) if (v === null || v === '') n.delete(k); else n.set(k, v);
      setSp(n, { replace: true });
    } else setLocalState(s => { const n = { ...s }; for (const [k, v] of Object.entries(patch)) if (v === null || v === '') delete n[k]; else n[k] = v; return n; });
  };
  const [search, setSearch] = useState(get('search'));
  const dSearch = useDebounced(search, 300);
  useEffect(() => { if (dSearch !== get('search')) set({ search: dSearch, page: null }); /* eslint-disable-next-line */ }, [dSearch]);
  const page = Number(get('page') || 1);
  const sort = get('sort') || p.defaultSort || '';
  const dir = (get('dir') || p.defaultDir || 'desc') as 'asc' | 'desc';
  const filterValues: Record<string, string> = {};
  for (const f of p.filters ?? []) { const v = get(f.key); if (v) filterValues[f.key] = v; }
  const pageSize = Number(get('pageSize') || p.pageSize || 25);
  const query = { ...p.params, ...filterValues, search: get('search'), sort, dir, page, pageSize };
  const url = `${p.endpoint}${p.endpoint.includes('?') ? '&' + qs(query).slice(1) : qs(query)}`;
  const state = useApi<{ rows: T[]; total: number; page: number; pageSize: number }>(url, [p.reloadKey]);
  const rows = state.data?.rows ?? [];
  const total = state.data?.total ?? 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mobileSelect, setMobileSelect] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => { setSelected(new Set()); }, [url]);
  const cols = p.columns.filter(c => !c.hidden);
  const activeFilterCount = Object.keys(filterValues).length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const reload = state.reload;

  const toggleSort = (k: string) => set({ sort: k, dir: sort === k && dir === 'desc' ? 'asc' : 'desc', page: null });
  const allOnPage = rows.length > 0 && rows.every(r => selected.has(r.id));
  const doExport = async () => {
    try {
      const all = await api.get<{ rows: T[] }>(`${p.endpoint}${p.endpoint.includes('?') ? '&' : '?'}${qs({ ...query, page: 1, pageSize: 5000 }).slice(1)}`);
      const csvCols = cols.filter(c => c.key !== '_actions').map(c => ({ key: c.key, label: c.label, value: c.csv ?? ((r: any) => { const v = r[c.key]; return typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v; }) }));
      downloadText(`${p.exportName ?? 'export'}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(all.rows as any, csvCols));
      api.post('/api/v1/exports/log', { resource: p.exportResource ?? p.exportName ?? 'list', count: all.rows.length, filters: { ...filterValues, search: get('search') } }).catch(() => {});
      toast.success(`Exported ${all.rows.length} rows`);
    } catch (e) { toast.error(e); }
  };

  const longPress = useRef<number | null>(null);
  const titleCol = cols.find(c => c.mobile === 'title') ?? cols[0];
  const subCol = cols.find(c => c.mobile === 'subtitle');
  const metaCols = cols.filter(c => c !== titleCol && c !== subCol && c.mobile !== 'hidden' && c.key !== '_actions').slice(0, 4);
  const open = (r: T) => { if (p.onRowClick) p.onRowClick(r); else { const l = p.rowLink?.(r); if (l) nav(l); } };

  const filterControls = (p.filters ?? []).map(f => <FilterControl key={f.key} def={f} value={filterValues[f.key] ?? ''} onChange={v => set({ [f.key]: v, page: null })} />);

  const body = (
    <>
      <div className="table-toolbar">
        {p.title && <h3>{p.title}</h3>}
        <SearchInput value={search} onChange={setSearch} placeholder={p.searchPlaceholder ?? 'Search'} width={220} />
        <span className="desktop-only row" style={{ gap: 8 }}>{filterControls}</span>
        {!!p.filters?.length && <Button size="sm" className="mobile-only" icon={<Filter size={14} />} onClick={() => setFilterOpen(true)}>Filter{activeFilterCount ? ` (${activeFilterCount})` : ''}</Button>}
        {activeFilterCount > 0 && <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => set(Object.fromEntries(Object.keys(filterValues).map(k => [k, null])))}>Reset</Button>}
        {p.toolbar}
        <Menu items={[
          { label: 'Export CSV', icon: <Download size={15} />, onClick: doExport },
          { label: mobileSelect ? 'Exit select mode' : 'Select rows', icon: <CheckSquare size={15} />, onClick: () => { setMobileSelect(m => !m); setSelected(new Set()); }, hidden: !p.bulkActions?.length },
        ]} />
      </div>
      {p.headerExtra}
      {selected.size > 0 && p.bulkActions && (
        <div className="bulk-bar">
          {selected.size} selected
          {p.bulkActions.map(b => <Button key={b.label} size="sm" variant={b.danger ? 'danger' : 'outline'} icon={b.icon} onClick={async () => { await b.onClick([...selected], reload); setSelected(new Set()); }}>{b.label}</Button>)}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      {state.error && !state.data ? <div style={{ padding: 20 }}><ErrorState error={state.error} retry={reload} /></div> : (
        <>
          <div className="table-wrap responsive">
            <table className="table">
              <thead><tr>
                {p.bulkActions && <th className="cb"><input type="checkbox" aria-label="Select all on page" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map(r => r.id)))} /></th>}
                {cols.map(c => (
                  <th key={c.key} className={c.sortable ? 'sortable' : ''} style={{ textAlign: c.align, width: c.width }} onClick={() => c.sortable && toggleSort(c.key)} aria-sort={sort === c.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.label}{c.sortable && <span className="sort-ic">{sort === c.key ? (dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} />}</span>}
                  </th>
                ))}
                {p.rowActions && <th className="act"><span className="sr-only">Actions</span>Actions</th>}
              </tr></thead>
              <tbody>
                {state.loading && !state.data ? Array.from({ length: 6 }).map((_, i) => <tr key={i}>{p.bulkActions && <td />}{cols.map(c => <td key={c.key}><Skeleton h={14} w={`${50 + ((i * 7 + c.key.length * 5) % 45)}%`} /></td>)}{p.rowActions && <td />}</tr>)
                  : rows.map(r => (
                    <tr key={r.id} className={`${p.rowLink || p.onRowClick ? 'clickable' : ''} ${selected.has(r.id) ? 'selected' : ''}`} onClick={() => open(r)}>
                      {p.bulkActions && <td className="cb" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label="Select row" checked={selected.has(r.id)} onChange={() => setSelected(s => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} /></td>}
                      {cols.map(c => <td key={c.key} style={{ textAlign: c.align }} className={c.align === 'right' ? 'money' : ''}>{c.render ? c.render(r) : cell((r as any)[c.key])}</td>)}
                      {p.rowActions && <td className="act" onClick={e => e.stopPropagation()}><Menu items={p.rowActions(r, reload)} /></td>}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-cards">
            {state.loading && !state.data ? <div style={{ padding: 16 }}><Skeleton h={60} /></div> : rows.map(r => (
              <div key={r.id} className="mcard" onClick={() => (mobileSelect ? setSelected(s => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; }) : open(r))}
                onTouchStart={() => { if (!p.bulkActions) return; longPress.current = window.setTimeout(() => { setMobileSelect(true); setSelected(new Set([r.id])); }, 550); }}
                onTouchEnd={() => { if (longPress.current) clearTimeout(longPress.current); }}>
                {mobileSelect && <input type="checkbox" aria-label="Select" checked={selected.has(r.id)} readOnly style={{ marginTop: 4 }} />}
                <div className="mmain">
                  <div>{titleCol.render ? titleCol.render(r) : cell((r as any)[titleCol.key])}</div>
                  {subCol && <div className="muted small mt-1">{subCol.render ? subCol.render(r) : cell((r as any)[subCol.key])}</div>}
                  {metaCols.map(c => <div key={c.key} className="mrow"><span>{c.label}</span><b>{c.render ? c.render(r) : cell((r as any)[c.key])}</b></div>)}
                </div>
                {p.rowActions && !mobileSelect && <div onClick={e => e.stopPropagation()}><Menu items={p.rowActions(r, reload)} /></div>}
              </div>
            ))}
          </div>
          {!state.loading && rows.length === 0 && <EmptyState title={activeFilterCount || get('search') ? 'No matches' : p.emptyTitle ?? 'Nothing here yet'} text={activeFilterCount || get('search') ? 'Try a different search or reset the filters.' : p.emptyText} action={activeFilterCount || get('search') ? <Button size="sm" onClick={() => { setSearch(''); set({ search: null, ...Object.fromEntries(Object.keys(filterValues).map(k => [k, null])) }); }}>Reset filters</Button> : p.emptyAction} />}
          {total > 0 && (
            <div className="table-foot">
              <span>{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString()}</span>
              <div className="row" style={{ gap: 6 }}>
                <select className="select input-sm" style={{ width: 'auto', height: 32 }} value={pageSize} onChange={e => set({ pageSize: e.target.value, page: null })} aria-label="Rows per page">{[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}</select>
                <Button size="sm" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => set({ page: String(page - 1) })} aria-label="Previous page" />
                <span className="small">Page {page} of {pages}</span>
                <Button size="sm" icon={<ChevronRight size={14} />} disabled={page >= pages} onClick={() => set({ page: String(page + 1) })} aria-label="Next page" />
              </div>
            </div>
          )}
        </>
      )}
      <Drawer open={filterOpen} onClose={() => setFilterOpen(false)} title="Filters" footer={<><Button onClick={() => { set(Object.fromEntries(Object.keys(filterValues).map(k => [k, null]))); setFilterOpen(false); }}>Reset</Button><Button variant="primary" onClick={() => setFilterOpen(false)}>Apply</Button></>}>
        <div className="stack filter-panel" style={{ gap: 14 }}>{(p.filters ?? []).map(f => <div key={f.key} className="field"><label>{f.label}</label><FilterControl def={f} value={filterValues[f.key] ?? ''} onChange={v => set({ [f.key]: v, page: null })} full /></div>)}</div>
      </Drawer>
    </>
  );
  return p.noCard ? body : <Card>{body}</Card>;
}

function cell(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (Array.isArray(v)) return v.length ? v.join(', ') : <span className="muted">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return <span className="muted">—</span>;
  return String(v);
}

function FilterControl({ def, value, onChange, full }: { def: FilterDef; value: string; onChange: (v: string) => void; full?: boolean }) {
  const style = full ? undefined : { width: 'auto', minWidth: 140, height: 34, fontSize: 13 };
  const members = useApi<{ id: string; name: string }[]>(def.type === 'member' ? '/api/v1/members' : null);
  if (def.type === 'date') return <input type="date" className="input input-sm" style={style} aria-label={def.label} value={value} onChange={e => onChange(e.target.value)} />;
  if (def.type === 'text') return <input className="input input-sm" style={style} aria-label={def.label} placeholder={def.label} value={value} onChange={e => onChange(e.target.value)} />;
  const opts = def.type === 'member' ? (members.data ?? []).map(m => ({ value: m.id, label: m.name })) : def.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : def.options ?? [];
  return <select className="select input-sm" style={style} aria-label={def.label} value={value} onChange={e => onChange(e.target.value)}><option value="">{def.label}: All</option>{opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}

/** Turns a list of strings into filter options with humanized labels. */
export function opts(values: readonly string[], labels?: Record<string, string>) {
  return values.map(v => ({ value: v, label: labels?.[v] ?? v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }));
}
