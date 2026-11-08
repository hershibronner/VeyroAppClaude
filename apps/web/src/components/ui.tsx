import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Calendar, ChevronDown, Info, Inbox, Lock, MoreVertical, RefreshCw, X, Search } from 'lucide-react';
import { humanize, initials, date as fmtDate, todayISO, addDaysISO } from '../lib/format';
import { ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';

/* ── Buttons ── */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'ghost' | 'danger' | 'dark' | 'success'; size?: 'sm' | 'xs' | 'md'; icon?: ReactNode; loading?: boolean; block?: boolean };
export function Button({ variant = 'outline', size = 'md', icon, loading, block, children, className = '', disabled, ...rest }: BtnProps) {
  const v = variant === 'outline' ? '' : `btn-${variant}`;
  const s = size === 'md' ? '' : `btn-${size}`;
  return (
    <button type="button" className={`btn ${v} ${s} ${block ? 'btn-block' : ''} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

/* ── Layout ── */
export function Card({ children, className = '', pad, style }: { children: ReactNode; className?: string; pad?: boolean; style?: React.CSSProperties }) {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`} style={style}>{children}</div>;
}
export function CardHeader({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return <div className="card-h"><div><h3>{title}</h3>{sub && <div className="muted small mt-1">{sub}</div>}</div>{right && <div className="right">{right}</div>}</div>;
}

/** Goes to the real previous in-app page, falling back to the module list. */
export function BackButton({ fallback, label = 'Back' }: { fallback: string; label?: string }) {
  const nav = useNavigate();
  const loc = useLocation();
  return <button className="back-link" onClick={() => (window.history.state?.idx > 0 && loc.key !== 'default' ? nav(-1) : nav(fallback))}><ArrowLeft size={14} /> {label}</button>;
}

export function PageHeader({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {back && <BackButton fallback={back} />}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Banner({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'danger' | 'success'; children: ReactNode; icon?: ReactNode }) {
  return <div className={`banner ${tone === 'info' ? '' : tone}`} role={tone === 'danger' ? 'alert' : 'status'}><span className="ic">{icon ?? (tone === 'info' ? <Info size={20} fill="currentColor" color="#fff" /> : <AlertTriangle size={20} />)}</span><div>{children}</div></div>;
}

/* ── KPIs ── */
export interface KpiItem { label: string; value: ReactNode; icon?: ReactNode; delta?: number | null; deltaText?: ReactNode; suffix?: string; to?: string; onClick?: () => void; invert?: boolean }
export function KpiRow({ items, compact }: { items: KpiItem[]; compact?: boolean }) {
  const nav = useNavigate();
  return (
    <div className={`kpis ${compact ? 'compact' : ''}`}>
      {items.map((k, i) => (
        <button key={i} className="kpi" onClick={() => (k.onClick ? k.onClick() : k.to ? nav(k.to) : undefined)} title={k.to ? 'Open the records behind this number' : undefined}>
          <div className="kpi-label">{k.icon}{k.label}</div>
          <div className="kpi-value">{k.value}</div>
          <div className="kpi-delta"><Delta value={k.delta} invert={k.invert} text={k.deltaText} suffix={k.suffix} /></div>
        </button>
      ))}
    </div>
  );
}
export function Delta({ value, text, suffix = 'from last month', invert }: { value?: number | null; text?: ReactNode; suffix?: string; invert?: boolean }) {
  if (text !== undefined) return <span>{text} {suffix && <span>{suffix}</span>}</span>;
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="muted">No prior data</span>;
  const good = invert ? value <= 0 : value >= 0;
  return <span><b className={good ? 'up' : 'down'}>{value >= 0 ? '+' : ''}{value.toFixed(1)}%</b> {suffix}</span>;
}

/* ── Status pills ── */
const GREEN = ['paid', 'active', 'approved', 'accepted', 'hired', 'won', 'completed', 'done', 'succeeded', 'connected', 'signed', 'verified', 'converted', 'qualified', 'locked', 'delivered', 'synced', 'settled', 'working', 'scored', 'resolved', 'client', 'on_track', 'advance', 'enabled', 'available'];
const AMBER = ['pending', 'partially_paid', 'submitted', 'review', 'calculated', 'in_progress', 'processing', 'sent', 'viewed', 'onboarding', 'contacted', 'proposal', 'negotiation', 'screening', 'assessment', 'recruiter_review', 'interview', 'client_review', 'client_interview', 'offer', 'on_hold', 'on_leave', 'notice', 'trialing', 'started', 'payment_initiated', 'idle', 'on_break', 'late', 'at_risk', 'retrying', 'pending_review', 'high', 'scheduled', 'unverified', 'grace', 'past_due', 'pending_approval', 'partially_failed', 'warn'];
const RED = ['overdue', 'failed', 'rejected', 'declined', 'cancelled', 'blacklisted', 'lost', 'unqualified', 'absent', 'error', 'expired', 'critical', 'urgent', 'suspended', 'written_off', 'disconnected', 'void', 'no_show', 'reject', 'disabled', 'offline_late'];
const BLUE = ['open', 'new', 'new_applicant', 'draft_open', 'talent_pool', 'discovery', 'initiated', 'normal', 'medium', 'internal', 'retried', 'uploaded', 'running', 'test'];
const PURPLE = ['lead', 'future', 'qualified_lead', 'mapped', 'dry_run'];
// Design handoff tone map (badge.tsx): green paid/active, amber pending, red overdue/rejected, gray draft,
// blue new/open, violet interview-ish review stages, teal hired/converted. Falls back to the keyword lists above.
const STATUS_TONE: Record<string, string> = {
  active: 'green', inactive: 'gray', archived: 'gray', draft: 'gray', pending: 'amber', disabled: 'gray', invited: 'violet',
  new: 'blue', contacted: 'violet', qualified: 'green', unqualified: 'gray', converted: 'teal', prospect: 'violet', lead: 'violet', client: 'green',
  discovery: 'blue', proposal: 'violet', negotiation: 'amber', won: 'green', lost: 'red',
  open: 'blue', in_progress: 'blue', done: 'green', low: 'gray', medium: 'blue', high: 'amber', urgent: 'red', critical: 'red', normal: 'blue',
  new_applicant: 'blue', screening: 'blue', assessment: 'violet', recruiter_review: 'violet', interview: 'violet', talent_pool: 'teal', submitted: 'blue', hired: 'teal',
  on_hold: 'amber', future: 'gray', rejected: 'red', withdrawn: 'gray', blacklisted: 'red', filled: 'teal', closed: 'gray',
  client_review: 'violet', client_interview: 'violet', offer: 'teal', reviewed: 'violet', advanced: 'green',
  scheduled: 'blue', completed: 'green', cancelled: 'gray', no_show: 'red', sent: 'blue', viewed: 'violet', accepted: 'green', declined: 'red', expired: 'red', approved: 'green',
  onboarding: 'violet', on_leave: 'amber', notice: 'amber', ended: 'gray', available: 'teal', verified: 'green', unverified: 'amber',
  working: 'green', idle: 'amber', on_break: 'violet', break: 'violet', offline: 'gray', late: 'amber', absent: 'red', denied: 'red',
  paid: 'green', partially_paid: 'amber', overdue: 'red', written_off: 'gray', void: 'gray', calculated: 'gray', review: 'amber', payment_initiated: 'blue', failed: 'red', partially_failed: 'red', processing: 'blue', initiated: 'blue', retried: 'blue', settled: 'teal', reimbursed: 'teal', invoiced: 'teal', locked: 'gray',
  succeeded: 'green', pending_approval: 'amber', skipped: 'gray', healthy: 'green', error: 'red', connected: 'green', disconnected: 'gray', synced: 'green',
  signed: 'green', pending_signature: 'amber', trialing: 'blue', past_due: 'amber', grace: 'amber', suspended: 'red', comped: 'teal',
};
export function pillTone(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase();
  if (STATUS_TONE[s]) return STATUS_TONE[s];
  if (GREEN.includes(s)) return 'green';
  if (AMBER.includes(s)) return 'amber';
  if (RED.includes(s)) return 'red';
  if (BLUE.includes(s)) return 'blue';
  if (PURPLE.includes(s)) return 'violet';
  return 'gray';
}
export function StatusPill({ status, label, tone, dot = true }: { status: string | null | undefined; label?: string; tone?: string; dot?: boolean }) {
  if (!status && !label) return <span className="muted">—</span>;
  return <span className={`pill pill-${tone ?? pillTone(status)}`}>{dot && <span className="dot" aria-hidden />}{label ?? (status === 'pending_signature' ? 'Awaiting signature' : humanize(status))}</span>;
}

/* ── People ── */
export function Avatar({ name, color, size = 32, src }: { name?: string | null; color?: string | null; size?: number; src?: string | null }) {
  return <span className="avatar" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38), background: color ?? colorFor(name ?? '') }} aria-hidden>{src ? <img src={src} alt="" /> : initials(name)}</span>;
}
const PALETTE = ['#345CFF', '#7044FF', '#0EA5E9', '#14B8A6', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6', '#10B981', '#6366F1'];
export function colorFor(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
export function Person({ name, sub, color, size = 32, src }: { name: string | null | undefined; sub?: ReactNode; color?: string | null; size?: number; src?: string | null }) {
  return <div className="person"><Avatar name={name} color={color} size={size} src={src} /><div style={{ minWidth: 0 }}><div className="nm truncate">{name || '—'}</div>{sub && <div className="sub truncate">{sub}</div>}</div></div>;
}

/* ── Tabs ── */
export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: ReactNode; count?: number | null; hidden?: boolean }[]; value: K; onChange: (k: K) => void }) {
  return <div className="tabs" role="tablist">{tabs.filter(t => !t.hidden).map(t => <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>{t.label}{t.count !== undefined && t.count !== null && <span className="count">{t.count}</span>}</button>)}</div>;
}
export function Segmented<K extends string>({ options, value, onChange }: { options: { key: K; label: ReactNode }[]; value: K; onChange: (k: K) => void }) {
  return <div className="segmented">{options.map(o => <button key={o.key} className={o.key === value ? 'on' : ''} onClick={() => onChange(o.key)}>{o.label}</button>)}</div>;
}

/* ── Overlays ── */
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
}
/** Panel for create/edit forms and details. Renders as a centered window (never a side panel); full screen on phones. */
export function Drawer({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (<>
    <div className="overlay" onClick={onClose} />
    <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="drawer-h"><h2 style={{ flex: 1 }}>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="drawer-b">{children}</div>
      {footer && <div className="drawer-f">{footer}</div>}
    </aside>
  </>);
}
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (<>
    <div className="overlay" onClick={onClose} />
    <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
      <div className="dialog-h row"><h2 style={{ flex: 1 }}>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="dialog-b">{children}</div>
      {footer && <div className="dialog-f">{footer}</div>}
    </div>
  </>);
}

/* ── Confirm (supports required reason and two-step typed confirmation) ── */
interface ConfirmOpts { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; reason?: { label: string; required?: boolean; placeholder?: string }; typeToConfirm?: string }
type ConfirmResult = { ok: boolean; reason: string };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<ConfirmResult>>(async () => ({ ok: false, reason: '' }));
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (r: ConfirmResult) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ask = (o: ConfirmOpts) => new Promise<ConfirmResult>(resolve => { setReason(''); setTyped(''); setState({ ...o, resolve }); });
  const close = (ok: boolean) => { state?.resolve({ ok, reason }); setState(null); };
  const blocked = !!state && ((state.reason?.required && !reason.trim()) || (state.typeToConfirm !== undefined && typed !== state.typeToConfirm));
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Dialog open={!!state} onClose={() => close(false)} title={state?.title}
        footer={<><Button onClick={() => close(false)}>Cancel</Button><Button variant={state?.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)}>{state?.confirmLabel ?? 'Confirm'}</Button></>}>
        {state?.body && <div className="muted" style={{ marginBottom: 12 }}>{state.body}</div>}
        {state?.reason && <Field label={state.reason.label + (state.reason.required ? ' *' : '')}><textarea className="textarea" autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder={state.reason.placeholder} /></Field>}
        {state?.typeToConfirm !== undefined && <Field label={<>Type <b>{state.typeToConfirm}</b> to confirm</>}><input className="input" value={typed} onChange={e => setTyped(e.target.value)} /></Field>}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}
export function useConfirm() { return useContext(ConfirmCtx); }

/* ── Menus ── */
export interface MenuItem { label?: ReactNode; icon?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; sep?: boolean; hidden?: boolean; title?: string }
export function Menu({ items, trigger, align = 'right', label = 'More actions' }: { items: MenuItem[]; trigger?: ReactNode; align?: 'left' | 'right'; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const visible = items.filter(i => !i.hidden);
  if (!visible.length) return null;
  return (
    <div className="menu-wrap" ref={ref} onClick={e => e.stopPropagation()}>
      {trigger ? <span onClick={() => setOpen(o => !o)}>{trigger}</span> : <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><MoreVertical size={18} /></button>}
      {open && <div className={`menu ${align}`} role="menu">{visible.map((it, i) => it.sep ? <div key={i} className="sep" /> : <button key={i} role="menuitem" title={it.title} disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.onClick?.(); }}>{it.icon}{it.label}</button>)}</div>}
    </div>
  );
}

/* ── Form fields ── */
export function Field({ label, error, hint, children, full, htmlFor }: { label?: ReactNode; error?: string | null; hint?: ReactNode; children: ReactNode; full?: boolean; htmlFor?: string }) {
  return <div className={`field ${full ? 'full' : ''}`}>{label && <label htmlFor={htmlFor}>{label}</label>}{children}{error ? <div className="err">{error}</div> : hint ? <div className="hint">{hint}</div> : null}</div>;
}
export function SearchInput({ value, onChange, placeholder = 'Search', width = 240 }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number | string }) {
  return <div className="search-input" style={{ width }}><Search size={16} /><input className="input input-sm" aria-label={placeholder} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>;
}
/** Tag/chip input (comma or Enter to add). */
export function TagInput({ value, onChange, placeholder = 'Type and press Enter', suggestions = [] }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[] }) {
  const [t, setT] = useState('');
  const add = (s: string) => { const v = s.trim(); if (v && !value.includes(v)) onChange([...value, v]); setT(''); };
  const listId = useMemo(() => 'tl' + Math.random().toString(36).slice(2), []);
  return (
    <div>
      {value.length > 0 && <div className="chips mb-2">{value.map(v => <span key={v} className="chip">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter(x => x !== v))}><X size={12} /></button></span>)}</div>}
      <input className="input" list={listId} value={t} placeholder={placeholder} onChange={e => { if (e.target.value.endsWith(',')) add(e.target.value.slice(0, -1)); else setT(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(t); } }} onBlur={() => t && add(t)} />
      {suggestions.length > 0 && <datalist id={listId}>{suggestions.filter(s => !value.includes(s)).map(s => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}
/** Money input that edits dollars but stores integer cents. */
export function MoneyInput({ cents, onChange, placeholder, id }: { cents: number | null | undefined; onChange: (c: number | null) => void; placeholder?: string; id?: string }) {
  const [t, setT] = useState(cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));
  useEffect(() => { const cur = t === '' ? null : Math.round(parseFloat(t) * 100); if (cur !== cents) setT(cents === null || cents === undefined ? '' : (cents / 100).toFixed(2)); /* eslint-disable-next-line */ }, [cents]);
  return <div className="search-input"><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}>$</span><input id={id} className="input" style={{ paddingLeft: 24 }} inputMode="decimal" value={t} placeholder={placeholder ?? '0.00'} onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); setT(v); onChange(v === '' ? null : Math.round(parseFloat(v) * 100)); }} /></div>;
}

/* Members picker (org staff) */
export function useMembers() { return useApi<{ id: string; name: string; email: string; role_key: string; role_name: string; avatar_color: string | null }[]>('/api/v1/members'); }
export function MemberSelect({ value, onChange, placeholder = 'Select person', roles, allowEmpty = true, id }: { value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; roles?: string[]; allowEmpty?: boolean; id?: string }) {
  const { data } = useMembers();
  const list = (data ?? []).filter(m => !roles || roles.includes(m.role_key));
  return <select id={id} className="select" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>{allowEmpty && <option value="">{placeholder}</option>}{list.map(m => <option key={m.id} value={m.id}>{m.name} — {m.role_name}</option>)}</select>;
}
/** Async entity picker. `endpoint` must accept ?search= and return {rows} or an array. */
export function EntitySelect({ endpoint, value, onChange, labelOf, placeholder = 'Select…', id, extra }: { endpoint: string; value: string | null | undefined; onChange: (v: string | null, row?: any) => void; labelOf: (r: any) => string; placeholder?: string; id?: string; extra?: string }) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const { data } = useApi<any>(`${endpoint}${sep}pageSize=200${extra ? '&' + extra : ''}`);
  const rows: any[] = Array.isArray(data) ? data : data?.rows ?? [];
  return <select id={id} className="select" value={value ?? ''} onChange={e => onChange(e.target.value || null, rows.find(r => r.id === e.target.value))}><option value="">{placeholder}</option>{rows.map(r => <option key={r.id} value={r.id}>{labelOf(r)}</option>)}</select>;
}

/* Phone input with compact searchable country picker (never blocks typing) */
export const COUNTRY_CODES: { code: string; name: string; dial: string; flag: string }[] = [
  ['US', 'United States', '+1', '🇺🇸'], ['PH', 'Philippines', '+63', '🇵🇭'], ['MX', 'Mexico', '+52', '🇲🇽'], ['CO', 'Colombia', '+57', '🇨🇴'], ['AR', 'Argentina', '+54', '🇦🇷'], ['PE', 'Peru', '+51', '🇵🇪'],
  ['ZA', 'South Africa', '+27', '🇿🇦'], ['KE', 'Kenya', '+254', '🇰🇪'], ['NG', 'Nigeria', '+234', '🇳🇬'], ['IN', 'India', '+91', '🇮🇳'], ['PK', 'Pakistan', '+92', '🇵🇰'], ['BR', 'Brazil', '+55', '🇧🇷'],
  ['CA', 'Canada', '+1', '🇨🇦'], ['GB', 'United Kingdom', '+44', '🇬🇧'], ['AU', 'Australia', '+61', '🇦🇺'], ['VN', 'Vietnam', '+84', '🇻🇳'], ['ID', 'Indonesia', '+62', '🇮🇩'], ['EG', 'Egypt', '+20', '🇪🇬'],
  ['GH', 'Ghana', '+233', '🇬🇭'], ['CL', 'Chile', '+56', '🇨🇱'], ['EC', 'Ecuador', '+593', '🇪🇨'], ['DO', 'Dominican Republic', '+1', '🇩🇴'], ['GT', 'Guatemala', '+502', '🇬🇹'], ['CR', 'Costa Rica', '+506', '🇨🇷'],
  ['ES', 'Spain', '+34', '🇪🇸'], ['PT', 'Portugal', '+351', '🇵🇹'], ['PL', 'Poland', '+48', '🇵🇱'], ['RO', 'Romania', '+40', '🇷🇴'], ['UA', 'Ukraine', '+380', '🇺🇦'], ['TR', 'Turkey', '+90', '🇹🇷'],
  ['MY', 'Malaysia', '+60', '🇲🇾'], ['TH', 'Thailand', '+66', '🇹🇭'], ['BD', 'Bangladesh', '+880', '🇧🇩'], ['LK', 'Sri Lanka', '+94', '🇱🇰'], ['JM', 'Jamaica', '+1', '🇯🇲'], ['UG', 'Uganda', '+256', '🇺🇬'],
].map(([code, name, dial, flag]) => ({ code, name, dial, flag }));
export function PhoneInput({ value, onChange, defaultCountry = 'US', id }: { value: string; onChange: (e164: string, country: string) => void; defaultCountry?: string; id?: string }) {
  const guess = COUNTRY_CODES.filter(c => value?.startsWith(c.dial)).sort((a, b) => b.dial.length - a.dial.length)[0];
  const [country, setCountry] = useState(guess?.code ?? defaultCountry);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const c = COUNTRY_CODES.find(x => x.code === country) ?? COUNTRY_CODES[0];
  const local = value?.startsWith(c.dial) ? value.slice(c.dial.length).trim() : value ?? '';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
  const filtered = COUNTRY_CODES.filter(x => !q || x.name.toLowerCase().includes(q.toLowerCase()) || x.dial.includes(q) || x.code.toLowerCase() === q.toLowerCase()).slice(0, 40);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', gap: 6 }}>
      <button type="button" className="btn" style={{ padding: '0 10px', flex: 'none' }} aria-label={`Country code ${c.name}`} onClick={() => setOpen(o => !o)}>{c.flag} {c.dial} <ChevronDown size={14} /></button>
      <input id={id} className="input" inputMode="tel" autoComplete="tel-national" value={local} placeholder="Phone number" onChange={e => onChange(`${c.dial} ${e.target.value.replace(/[^\d\s-]/g, '')}`.trim(), c.code)} />
      {open && (
        <div className="menu left" style={{ width: 280, maxHeight: 300, overflowY: 'auto' }}>
          <input className="input input-sm" autoFocus placeholder="Search country or code" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 6 }} />
          {filtered.map(x => <button key={x.code} type="button" onClick={() => { setCountry(x.code); setOpen(false); setQ(''); onChange(`${x.dial} ${local}`.trim(), x.code); }}>{x.flag} <span style={{ flex: 1 }}>{x.name}</span><span className="muted">{x.dial}</span></button>)}
          {!filtered.length && <div className="muted small" style={{ padding: 8 }}>No matches</div>}
        </div>
      )}
    </div>
  );
}

/* ── Date range ── */
export interface DateRange { from: string; to: string; label?: string }
export const RANGE_PRESETS = [
  { label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }, { label: 'Last 3 months', days: 91 }, { label: 'Last 6 months', days: 182 }, { label: 'Last 12 months', days: 365 },
];
export function presetRange(days: number, label?: string): DateRange { const to = todayISO(); return { from: addDaysISO(to, -days + 1), to, label: label ?? `Last ${days} days` }; }
export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(value.from); const [t, setT] = useState(value.to);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn" onClick={() => setOpen(o => !o)}><Calendar size={16} /> {value.label ?? `${fmtDate(value.from, { day: 'numeric', month: 'short' })} – ${fmtDate(value.to)}`} <ChevronDown size={14} /></button>
      {open && <div className="menu" style={{ width: 280, padding: 10 }}>
        {RANGE_PRESETS.map(p => <button key={p.days} onClick={() => { onChange(presetRange(p.days, p.label)); setOpen(false); }}>{p.label}</button>)}
        <div className="sep" />
        <div className="row" style={{ padding: 6 }}><input type="date" className="input input-sm" value={f} onChange={e => setF(e.target.value)} aria-label="From" /><input type="date" className="input input-sm" value={t} onChange={e => setT(e.target.value)} aria-label="To" /></div>
        <div style={{ padding: 6 }}><Button size="sm" variant="primary" block disabled={!f || !t || f > t} onClick={() => { onChange({ from: f, to: t, label: `${fmtDate(f, { day: 'numeric', month: 'short' })} – ${fmtDate(t)}` }); setOpen(false); }}>Apply range</Button></div>
      </div>}
    </div>
  );
}
/** Small "Last 6 months" dropdown used on chart cards. */
export function RangeSelect({ value, onChange, options = [3, 6, 12] }: { value: number; onChange: (months: number) => void; options?: number[] }) {
  return <select className="select input-sm" style={{ width: 'auto', height: 32, fontSize: 13 }} value={value} onChange={e => onChange(Number(e.target.value))} aria-label="Range">{options.map(o => <option key={o} value={o}>Last {o} months</option>)}</select>;
}

/* ── States ── */
export function EmptyState({ icon, title = 'Nothing here yet', text, action }: { icon?: ReactNode; title?: string; text?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="ic">{icon ?? <Inbox size={22} />}</div><h4>{title}</h4>{text && <div className="small">{text}</div>}{action && <div className="mt-2">{action}</div>}</div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error as ApiError;
  if (e?.status === 404) return <EmptyState icon={<Search size={22} />} title="Not found" text="This record does not exist or you do not have access to it." />;
  if (e?.status === 403) return <PermissionDenied text={e.message} />;
  return <div className="errorbox"><AlertTriangle size={20} /><div style={{ flex: 1 }}><b>Could not load this.</b><div className="small">{e?.message ?? String(error)}</div></div>{retry && <Button size="sm" icon={<RefreshCw size={14} />} onClick={retry}>Retry</Button>}</div>;
}
export function PermissionDenied({ text }: { text?: string }) {
  return <EmptyState icon={<Lock size={22} />} title="You don't have access" text={text ?? 'Your role does not include this area. Ask an admin if you need it.'} />;
}
export function Skeleton({ h = 16, w = '100%', r = 8, style }: { h?: number; w?: number | string; r?: number; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="stack" style={{ gap: 12, padding: 20 }}>{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={18} w={`${90 - i * 12}%`} />)}</div>;
}
/** Renders loading / error / content for a useApi result. */
export function Async<T>({ state, children, rows }: { state: { data: T | null; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; rows?: number }) {
  if (state.error && !state.data) return <ErrorState error={state.error} retry={state.reload} />;
  if (!state.data) return <LoadingBlock rows={rows} />;
  return <>{children(state.data)}</>;
}

/** Error boundary so one failing widget never blanks the whole page. */
export class Boundary extends Component<{ children: ReactNode; label?: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: ErrorInfo) { console.error('Widget crashed', this.props.label, err, info); }
  render() {
    if (this.state.err) return <div className="errorbox"><AlertTriangle size={20} /><div style={{ flex: 1 }}><b>{this.props.label ?? 'This section'} failed to render.</b><div className="small">{this.state.err.message}</div></div><Button size="sm" onClick={() => this.setState({ err: null })}>Retry</Button></div>;
    return this.props.children;
  }
}

/* ── Description list ── */
export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v], i) => <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v === null || v === undefined || v === '' ? '—' : v}</dd></div>)}</dl>;
}
export function Meter({ value, tone }: { value: number; tone?: 'green' | 'amber' | 'red' }) {
  const t = tone ?? (value >= 70 ? 'green' : value >= 40 ? 'amber' : 'red');
  return <div className={`meter ${t}`} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
