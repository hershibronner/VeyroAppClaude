// Shared UI for WORKFORCE + TIME pages (agency app and portals).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Flag, X, Download } from 'lucide-react';
import { Button, StatusPill, Meter, Field, Drawer, useConfirm } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { realtime } from '../../lib/realtime';
import { dateTime, time as fmtTime, relTime, duration } from '../../lib/format';
import './wf.css';

export const LIVE_LABEL: Record<string, string> = { working: 'Working', idle: 'Idle', on_break: 'On Break', late: 'Late', absent: 'Absent', offline: 'Offline', time_off: 'Time off' };
export const LIVE_TONE: Record<string, string> = { working: 'green', idle: 'amber', on_break: 'amber', late: 'amber', absent: 'red', offline: 'gray', time_off: 'purple' };
export function LivePill({ status }: { status: string }) { return <StatusPill status={status} label={LIVE_LABEL[status] ?? status} tone={LIVE_TONE[status]} />; }
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function scheduleText(days: number[] | null | undefined, start?: string | null, end?: string | null) {
  const d = [...(days ?? [])].sort();
  const label = d.length === 5 && d.join() === '1,2,3,4,5' ? 'Mon–Fri' : d.length === 7 ? 'Every day' : d.length === 6 && d.join() === '1,2,3,4,5,6' ? 'Mon–Sat' : d.map(x => DOW[x - 1]).join(', ');
  return `${label || '—'} ${start ? start.slice(0, 5) : ''}${end ? '–' + end.slice(0, 5) : ''}`.trim();
}
export const hrs = (m: number | null | undefined, digits = 1) => (m === null || m === undefined ? '—' : `${(m / 60).toFixed(digits)}h`);
export const hm = (m: number | null | undefined) => { if (m === null || m === undefined) return '—'; const a = Math.abs(Math.round(m)); return `${m < 0 ? '−' : ''}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`; };

/** Subscribe to a realtime event for the lifetime of the component. */
export function useRealtime(event: string, fn: (d: any) => void) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => realtime.on(event, d => ref.current(d)), [event]);
}

/** Ticking duration from a start timestamp (or a base seconds count captured at `at`). */
export function useTicker(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => { if (!active) return; const t = setInterval(() => set(x => x + 1), 1000); return () => clearInterval(t); }, [active]);
}
export function SinceTimer({ from }: { from: string | null | undefined }) {
  useTicker(!!from);
  if (!from) return <span className="muted">—</span>;
  return <span className="wf-timer">{duration(Math.max(0, (Date.now() - new Date(from).getTime()) / 1000))}</span>;
}

export function Progress({ done, total, label }: { done: number; total: number; label?: ReactNode }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}><div className={`wf-progress ${total && done >= total ? 'done' : ''}`} style={{ flex: 1 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div><span className="small nowrap">{label ?? `${done}/${total}`}</span></div>;
}
export function ActivityMeter({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted small">No activity yet</span>;
  return <div className="row" style={{ gap: 8, alignItems: 'center' }}><div style={{ flex: 1 }}><Meter value={value} /></div><span className="small bold nowrap">{value}%</span></div>;
}

export interface Shot { id: string; url: string | null; taken_at: string; app_label?: string | null; url_label?: string | null; activity_pct?: number | null; flagged?: boolean; flag_note?: string | null; blurred?: boolean; kind?: string; worker_name?: string; company_name?: string; can_delete?: boolean; delete_until?: string }

/** Full-screen screenshot viewer with next/prev (keyboard arrows) and optional flag / delete actions. */
export function Lightbox({ shots, index, onClose, onIndex, canFlag, onFlagged, onDelete }: { shots: Shot[]; index: number; onClose: () => void; onIndex: (i: number) => void; canFlag?: boolean; onFlagged?: (s: Shot) => void; onDelete?: (s: Shot) => void }) {
  const s = shots[index];
  const confirm = useConfirm();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight' && index < shots.length - 1) onIndex(index + 1); if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [index, shots.length, onClose, onIndex]);
  if (!s) return null;
  const flag = async () => {
    let note: string | null = null;
    if (!s.flagged) { const r = await confirm({ title: 'Flag this screenshot', body: 'Flagged screenshots are highlighted for review on the timeline.', reason: { label: 'Note (optional)' }, confirmLabel: 'Flag' }); if (!r.ok) return; note = r.reason || null; }
    try { const r = await api.post(`/api/v1/time/screenshots/${s.id}/flag`, { flagged: !s.flagged, note }); onFlagged?.({ ...s, flagged: r.flagged, flag_note: r.flag_note }); toast.success(r.flagged ? 'Screenshot flagged' : 'Flag removed'); } catch (e) { toast.error(e); }
  };
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot viewer" onClick={onClose}>
      <div className="wf-lb-bar" onClick={e => e.stopPropagation()}>
        <div>
          <div className="bold">{s.worker_name ? `${s.worker_name} · ` : ''}{dateTime(s.taken_at)}</div>
          <div className="small" style={{ opacity: .8 }}>{[s.app_label, s.url_label, s.activity_pct !== null && s.activity_pct !== undefined ? `${s.activity_pct}% activity` : null, s.kind === 'real' ? 'Screen capture' : 'Demo screenshot', s.blurred ? 'Blurred' : null].filter(Boolean).join(' · ')}</div>
          {s.flagged && <div className="small" style={{ color: '#FCA5A5' }}>Flagged{s.flag_note ? ` — ${s.flag_note}` : ''}</div>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="small" style={{ opacity: .8 }}>{index + 1} / {shots.length}</span>
          {s.url && <a href={s.url} target="_blank" rel="noreferrer"><Button size="sm" variant="dark" icon={<Download size={14} />}>Open</Button></a>}
          {canFlag && <Button size="sm" variant={s.flagged ? 'dark' : 'danger'} icon={<Flag size={14} />} onClick={flag}>{s.flagged ? 'Unflag' : 'Flag'}</Button>}
          {onDelete && s.can_delete && <Button size="sm" variant="danger" onClick={() => onDelete(s)}>Delete</Button>}
          <button className="icon-btn" style={{ color: '#fff' }} aria-label="Close viewer" onClick={onClose}><X size={20} /></button>
        </div>
      </div>
      <img src={s.url ?? ''} alt={`Screenshot ${dateTime(s.taken_at)}`} onClick={e => e.stopPropagation()} />
      {index > 0 && <button className="wf-lb-nav" style={{ left: 16 }} aria-label="Previous screenshot" onClick={e => { e.stopPropagation(); onIndex(index - 1); }}><ChevronLeft /></button>}
      {index < shots.length - 1 && <button className="wf-lb-nav" style={{ right: 16 }} aria-label="Next screenshot" onClick={e => { e.stopPropagation(); onIndex(index + 1); }}><ChevronRight /></button>}
    </div>
  );
}

/** Thumbnail with time + activity; opens the lightbox. */
export function ShotThumb({ s, onOpen }: { s: Shot; onOpen: () => void }) {
  return (
    <div className={`shot ${s.flagged ? 'flagged' : ''}`} onClick={onOpen} role="button" tabIndex={0} aria-label={`Open screenshot from ${fmtTime(s.taken_at)}`} onKeyDown={e => e.key === 'Enter' && onOpen()}>
      <img src={s.url ?? ''} alt="" loading="lazy" />
      <div className="meta"><span>{fmtTime(s.taken_at)}</span><span className="muted">{s.activity_pct ?? '—'}%</span></div>
    </div>
  );
}

export function ago(t: string | null | undefined) { return t ? relTime(t) : '—'; }

/** Log-an-issue drawer (used from placement detail and the Issues list). */
export function IssueDrawer({ open, onClose, placementId, onSaved }: { open: boolean; onClose: () => void; placementId?: string; onSaved: () => void }) {
  const [v, setV] = useState<any>({ kind: 'performance', severity: 'medium' });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pls, setPls] = useState<any[]>([]);
  useEffect(() => { if (open) { setV({ kind: 'performance', severity: 'medium', placement_id: placementId }); setErr({}); if (!placementId) api.get('/api/v1/placements?status=active,notice,on_leave,onboarding&pageSize=500&sort=worker_name&dir=asc').then(r => setPls(r.rows)).catch(() => {}); } }, [open, placementId]);
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.placement_id) e.placement_id = 'Choose a placement';
    if (!v.title || v.title.trim().length < 3) e.title = 'Give the issue a title';
    setErr(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await api.post('/api/v1/issues', v); toast.success('Issue logged'); onSaved(); onClose(); } catch (x: any) { if (x.fields) setErr(x.fields); toast.error(x); } finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onClose={onClose} title="Log an issue" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Log issue</Button></>}>
      <div className="form-grid">
        {!placementId && <Field label="Placement *" htmlFor="is-pl" error={err.placement_id} full><select id="is-pl" className="select" value={v.placement_id ?? ''} onChange={e => setV({ ...v, placement_id: e.target.value })}><option value="">Select worker / placement…</option>{pls.map(p => <option key={p.id} value={p.id}>{p.worker_name} — {p.title} @ {p.company_name}</option>)}</select></Field>}
        <Field label="Type" htmlFor="is-kind"><select id="is-kind" className="select" value={v.kind} onChange={e => setV({ ...v, kind: e.target.value })}>{['performance', 'attendance', 'client_complaint', 'conduct', 'other'].map(k => <option key={k} value={k}>{k.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}</select></Field>
        <Field label="Severity" htmlFor="is-sev"><select id="is-sev" className="select" value={v.severity} onChange={e => setV({ ...v, severity: e.target.value })}>{['low', 'medium', 'high', 'critical'].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></Field>
        <Field label="Title *" htmlFor="is-title" error={err.title} full><input id="is-title" className="input" value={v.title ?? ''} onChange={e => setV({ ...v, title: e.target.value })} placeholder="e.g. Missed callback SLA twice this week" /></Field>
        <Field label="Details" htmlFor="is-desc" full><textarea id="is-desc" className="textarea" value={v.description ?? ''} onChange={e => setV({ ...v, description: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}
export { ActivityMeter as Activity };
