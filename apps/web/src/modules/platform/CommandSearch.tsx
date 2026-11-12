import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, CornerDownLeft, LifeBuoy, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { StatusPill } from '../../components/ui';

export interface NavPage { to: string; label: string; group: string }
type Hit = { key: string; icon: React.ReactNode; title: string; sub?: string; to: string; pill?: React.ReactNode };

/** ⌘K / Ctrl+K jump-to for the Platform Control Center: pages, agencies and tickets (#number or text). */
export function CommandSearch({ pages }: { pages: NavPage[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [agencies, setAgencies] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [i, setI] = useState(0);
  const dq = useDebounced(q.trim(), 180);
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    if (!open || !dq) { setAgencies([]); setTickets([]); return; }
    let live = true;
    const s = encodeURIComponent(dq);
    Promise.all([
      /^#?\d+$/.test(dq) ? Promise.resolve({ rows: [] }) : api.get(`/api/v1/platform/agencies?search=${s}&pageSize=5`).catch(() => ({ rows: [] })),
      api.get(`/api/v1/platform/tickets?view=all&search=${s}&pageSize=6&sort=last_activity_at`).catch(() => ({ rows: [] })),
    ]).then(([a, t]) => { if (live) { setAgencies(a.rows); setTickets(t.rows); setI(0); } });
    return () => { live = false; };
  }, [dq, open]);

  const hits: Hit[] = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const pg = pages.filter(p => !ql || p.label.toLowerCase().includes(ql) || p.group.toLowerCase().includes(ql)).slice(0, ql ? 5 : 8)
      .map(p => ({ key: `p${p.to}`, icon: <ArrowRight size={15} />, title: p.label, sub: p.group, to: p.to }));
    const ag = agencies.map(a => ({ key: `a${a.id}`, icon: <Building2 size={15} />, title: a.name, sub: `${a.plan_name ?? 'No plan'} · ${a.slug}`, to: `/platform/agencies/${a.id}`, pill: <StatusPill status={a.status} /> }));
    const tk = tickets.map(t => ({ key: `t${t.id}`, icon: <LifeBuoy size={15} />, title: `#${t.number} ${t.subject}`, sub: t.org_name ?? 'No agency', to: `/platform/tickets?view=all&ticket=${t.id}`, pill: <StatusPill status={t.status} label={t.status === 'pending' ? 'Waiting' : undefined} /> }));
    return [...tk, ...ag, ...pg];
  }, [q, pages, agencies, tickets]);

  const go = (h?: Hit) => { if (!h) return; setOpen(false); nav(h.to); };
  if (!open) return <button className="st-cmd-trigger" onClick={() => setOpen(true)} aria-label="Search the control center"><Search size={15} /><span>Search agencies, tickets…</span><kbd>⌘K</kbd></button>;
  return <>
    <button className="st-cmd-trigger" aria-hidden tabIndex={-1}><Search size={15} /><span>Search agencies, tickets…</span><kbd>⌘K</kbd></button>
    {createPortal(
      <div className="st-cmd-overlay" onMouseDown={() => setOpen(false)}>
        <div className="st-cmd" role="dialog" aria-label="Search" onMouseDown={e => e.stopPropagation()}>
          <div className="st-cmd-input"><Search size={17} /><input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Search agencies, tickets (#1001) or pages…"
            onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(hits.length - 1, x + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); } else if (e.key === 'Enter') { e.preventDefault(); go(hits[i]); } else if (e.key === 'Escape') setOpen(false); }} /><kbd>esc</kbd></div>
          <div className="st-cmd-list" role="listbox">
            {hits.length === 0 ? <div className="st-cmd-empty">No matches for “{q}”</div> : hits.map((h, k) => (
              <button key={h.key} role="option" aria-selected={k === i} className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => go(h)}>
                <span className="ic">{h.icon}</span><span className="tx"><b className="truncate">{h.title}</b>{h.sub && <span className="truncate">{h.sub}</span>}</span>{h.pill}{k === i && <CornerDownLeft size={14} className="enter" />}
              </button>))}
          </div>
        </div>
      </div>, document.body)}
  </>;
}
