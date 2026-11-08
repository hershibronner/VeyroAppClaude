import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Clock, Plus, Building2, User, Briefcase, FileText, Receipt, MessageSquare, Users, Target } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced } from '../lib/hooks';
import { useQuickCreate } from './QuickCreate';
import { toBody } from './ui';

interface Result { type: string; id: string; title: string; subtitle?: string | null; link: string }
const ICON: Record<string, any> = { client: Building2, lead: Target, contact: User, candidate: User, worker: Users, position: Briefcase, invoice: Receipt, document: FileText, message: MessageSquare };
const recentKey = (org: string) => `veyro:recent:${org}`;
export function pushRecent(orgId: string, r: Result) {
  try { const list: Result[] = JSON.parse(localStorage.getItem(recentKey(orgId)) ?? '[]'); localStorage.setItem(recentKey(orgId), JSON.stringify([r, ...list.filter(x => x.link !== r.link)].slice(0, 8))); } catch { /* storage unavailable */ }
}

/** ⌘K palette: searches only records the user may see (server-enforced), plus recent items and quick actions. */
export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQuickCreate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const orgId = me?.workspace?.org.id ?? '';
  const recent: Result[] = useMemo(() => { try { return JSON.parse(localStorage.getItem(recentKey(orgId)) ?? '[]'); } catch { return []; } }, [open, orgId]);
  useEffect(() => { if (open) { setQ(''); setResults([]); setIdx(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);
  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    api.get<{ results: Result[] }>(`/api/v1/search?q=${encodeURIComponent(dq)}`).then(r => { setResults(r.results); setIdx(0); }).catch(() => setResults([])).finally(() => setLoading(false));
  }, [dq]);
  const actions = q.trim().length < 2 ? qc.items.slice(0, 6).map(i => ({ type: 'action', id: i.key, title: `New ${i.label}`, link: '' })) : [];
  const list: Result[] = q.trim().length < 2 ? [...recent, ...actions] : results;
  const go = (r: Result) => { onClose(); if (r.type === 'action') { qc.open(r.id); return; } pushRecent(orgId, r); nav(r.link); };
  if (!open) return qc.element;
  return toBody(<>
    {qc.element}
    <div className="overlay" onClick={onClose} />
    <div className="dialog" style={{ top: '18%', transform: 'translate(-50%, 0)', width: 'min(620px, calc(100vw - 24px))' }} role="dialog" aria-label="Search">
      <div className="search-input" style={{ padding: 14, borderBottom: '1px solid var(--border-2)' }}>
        <Search size={18} style={{ left: 28 }} />
        <input ref={inputRef} className="input" style={{ height: 46, fontSize: 16, paddingLeft: 40 }} placeholder="Search clients, candidates, workers, invoices…" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); } if (e.key === 'Enter' && list[idx]) go(list[idx]); if (e.key === 'Escape') onClose(); }} aria-label="Search" />
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto', padding: 8 }}>
        {q.trim().length < 2 && recent.length > 0 && <div className="tiny muted" style={{ padding: '6px 10px' }}>Recent</div>}
        {list.map((r, i) => {
          const Ic = r.type === 'action' ? Plus : ICON[r.type] ?? (recent.includes(r) ? Clock : FileText);
          const showHeader = q.trim().length < 2 && r.type === 'action' && list[i - 1]?.type !== 'action';
          return (<div key={r.type + r.id + i}>
            {showHeader && <div className="tiny muted" style={{ padding: '10px 10px 6px' }}>Quick actions</div>}
            <button onClick={() => go(r)} onMouseEnter={() => setIdx(i)} style={{ all: 'unset', boxSizing: 'border-box', display: 'flex', gap: 12, alignItems: 'center', width: '100%', padding: '9px 10px', borderRadius: 10, cursor: 'pointer', background: i === idx ? 'var(--primary-50)' : undefined }}>
              <span className="tl-ic"><Ic size={15} /></span>
              <span style={{ flex: 1, minWidth: 0 }}><div className="bold truncate">{r.title}</div>{r.subtitle && <div className="small muted truncate">{r.subtitle}</div>}</span>
              {r.type !== 'action' && <span className="pill pill-gray">{r.type}</span>}
            </button>
          </div>);
        })}
        {q.trim().length >= 2 && !loading && results.length === 0 && <div className="empty"><h4>No results for "{q}"</h4><div className="small">Only records you have access to are searched.</div></div>}
        {loading && <div className="muted small" style={{ padding: 12 }}>Searching…</div>}
      </div>
      <div className="tiny muted" style={{ padding: '8px 16px', borderTop: '1px solid var(--border-2)' }}>↑↓ to navigate · Enter to open · Esc to close</div>
    </div>
  </>);
}
