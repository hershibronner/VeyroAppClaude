import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, Video, FileText, X, Tag, ArrowRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { shortDate, relTime, humanize } from '../../lib/format';
import { Button, Card, Dialog, Field, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column, type BulkAction } from '../../components/DataTable';
import { AiError, CandidateCell, CandidateForm, CANDIDATE_STATUSES, REASON_REQUIRED, rateRange, useHiddenParams } from './shared';

const HIDDEN = ['stage', 'needs_review', 'exclude_status', 'keywords', 'max_rate', 'min_years', 'bilingual', 'available', 'software', 'languages', 'tag', 'position_id'];
const NL_KEYS = ['skills', 'software', 'languages', 'country', 'max_rate', 'min_years', 'bilingual', 'available', 'keywords'];

export function candidateColumns(): Column<any>[] {
  return [
    { key: 'name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={r} sub={<>{r.headline ?? '—'}{r.has_resume && <FileText size={12} style={{ marginLeft: 6 }} aria-label="Has resume" />}{r.has_video && <Video size={12} style={{ marginLeft: 4 }} aria-label="Has intro video" />}</>} />, csv: r => r.name },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'source', label: 'Source', sortable: true, mobile: 'subtitle', render: r => <span>{r.source ?? '—'}{r.sourced_by_name ? <span className="muted"> · {r.sourced_by_name}</span> : ''}</span>, csv: r => `${r.source ?? ''}${r.sourced_by_name ? ' / ' + r.sourced_by_name : ''}` },
    { key: 'last_applied_at', label: 'Applied', sortable: true, render: r => r.last_applied_at ? <span title={r.last_position_title ?? ''}>{shortDate(r.last_applied_at)}{r.last_position_title ? <div className="tiny muted truncate" style={{ maxWidth: 160 }}>{r.last_position_title}</div> : null}</span> : <span className="muted">Added {shortDate(r.created_at)}</span>, csv: r => r.last_applied_at ?? r.created_at },
    { key: 'country', label: 'Country', sortable: true },
    { key: 'years_experience', label: 'Exp.', align: 'right', sortable: true, render: r => r.years_experience !== null && r.years_experience !== undefined ? `${r.years_experience} yrs` : '—' },
    { key: 'skills', label: 'Skills', mobile: 'hidden', render: r => <span className="small">{(r.skills ?? []).slice(0, 3).join(', ') || '—'}{(r.skills ?? []).length > 3 ? ` +${r.skills.length - 3}` : ''}</span> },
    { key: 'rate_min_cents', label: 'Rate range', align: 'right', sortable: true, render: r => rateRange(r) },
  ];
}

export default function Candidates({ talentPool = false }: { talentPool?: boolean }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [rk, setRk] = useState(0);
  const [nl, setNl] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlErr, setNlErr] = useState<unknown>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<{ ids: string[]; reload: () => void } | null>(null);
  const facets = useApi<any>('/api/v1/candidates/facets');
  const hidden = useHiddenParams(sp, setSp, HIDDEN);
  const runNl = async () => {
    if (nl.trim().length < 2) return;
    setNlBusy(true); setNlErr(null);
    try {
      const r = await api.post('/api/v1/ai/parse-search', { q: nl });
      const f = r.filters; const n = new URLSearchParams(sp);
      for (const k of [...NL_KEYS, 'search', 'page']) n.delete(k);
      if (f.skills.length) n.set('skills', f.skills.join(',')); if (f.software.length) n.set('software', f.software.join(',')); if (f.languages.length) n.set('languages', f.languages.join(','));
      if (f.countries.length) n.set('country', f.countries.join(',')); if (f.max_rate_cents) n.set('max_rate', String(f.max_rate_cents)); if (f.min_years) n.set('min_years', String(f.min_years));
      if (f.bilingual) n.set('bilingual', 'true'); if (f.available) n.set('available', 'true'); if (f.keywords.length) n.set('keywords', f.keywords.join(','));
      setSp(n, { replace: true }); setChips(r.chips);
    } catch (e) { setNlErr(e); } finally { setNlBusy(false); }
  };
  const clearNl = () => { const n = new URLSearchParams(sp); for (const k of [...NL_KEYS, 'page']) n.delete(k); setSp(n, { replace: true }); setChips([]); setNl(''); };
  const bulk: BulkAction[] = can('candidates', 'edit') ? [
    { label: 'Change status', onClick: (ids, reload) => setBulkStatus({ ids, reload }) },
    { label: 'Add to talent pool', icon: <ArrowRight size={14} />, onClick: async (ids, reload) => { const r = await api.post('/api/v1/candidates/bulk', { ids, action: 'status', status: 'talent_pool' }).catch(e => { toast.error(e); return null; }); if (r) { toast.success(`${r.updated} moved${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped[0].reason})` : ''}`); reload(); } } },
    { label: 'Tag', icon: <Tag size={14} />, onClick: async (ids, reload) => { const c = await confirm({ title: `Tag ${ids.length} candidates`, reason: { label: 'Tag', required: true, placeholder: 'e.g. bilingual' }, confirmLabel: 'Add tag' }); if (!c.ok) return; const r = await api.post('/api/v1/candidates/bulk', { ids, action: 'tag', tag: c.reason.trim().slice(0, 40) }).catch(e => { toast.error(e); return null; }); if (r) { toast.success(`Tagged ${r.updated}`); reload(); } } },
  ] : [];
  const params: Record<string, string> = { ...hidden.params };
  if (talentPool) params.status = sp.get('status') || 'talent_pool';
  return (
    <div>
      <PageHeader title={talentPool ? 'Talent Pool' : 'Candidates'} sub={talentPool ? 'Qualified people kept for future matching — they show up in Find Best Matches.' : 'Every person in your pipeline, independent of any one job.'}
        actions={can('candidates', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New candidate</Button>} />
      <Card>
        <form className="rec-nl" onSubmit={e => { e.preventDefault(); runNl(); }}>
          <Sparkles size={18} color="var(--accent)" aria-hidden />
          <input className="input" value={nl} onChange={e => setNl(e.target.value)} placeholder='Try: "bilingual bookkeepers in PH with QuickBooks under $8/hr"' aria-label="Natural-language candidate search" />
          <Button type="submit" variant="primary" loading={nlBusy} disabled={nl.trim().length < 2}>Search</Button>
          {(chips.length > 0 || NL_KEYS.some(k => sp.get(k))) && <Button variant="ghost" icon={<X size={14} />} onClick={clearNl}>Clear AI filters</Button>}
          {chips.length > 0 && <div className="rec-chips" style={{ width: '100%' }}><span className="small muted">Understood as:</span>{chips.map(c => <span key={c} className="chip">{c}</span>)}</div>}
        </form>
        {nlErr ? <div style={{ padding: '0 16px' }}><AiError error={nlErr} retry={runNl} /><div className="small muted mb-2">You can still use the regular search and filters below.</div></div> : null}
        <DataTable noCard endpoint="/api/v1/candidates" exportName={talentPool ? 'talent-pool' : 'candidates'} exportResource="candidates" columns={candidateColumns()} reloadKey={rk} params={params} headerExtra={hidden.chips}
          filters={[
            ...(talentPool ? [] : [{ key: 'status', label: 'Status', options: opts(CANDIDATE_STATUSES) }]),
            { key: 'source', label: 'Source', options: (facets.data?.sources ?? []).map((s: any) => ({ value: s.v, label: `${s.v} (${s.n})` })) },
            { key: 'recruiter_id', label: 'Recruiter', type: 'member' },
            { key: 'country', label: 'Country', options: (facets.data?.countries ?? []).map((s: any) => ({ value: s.v, label: s.v })) },
            { key: 'skills', label: 'Skill', options: (facets.data?.skills ?? []).map((s: any) => ({ value: s.v, label: s.v })) },
            { key: 'has_resume', label: 'Has resume', type: 'boolean' }, { key: 'has_video', label: 'Has video', type: 'boolean' },
            { key: 'from', label: 'Added from', type: 'date' }, { key: 'to', label: 'Added to', type: 'date' },
          ]}
          rowLink={r => `/recruiting/candidates/${r.id}`} bulkActions={bulk} defaultSort="created_at" searchPlaceholder="Search name, email, skill"
          rowActions={r => [{ label: 'Open profile', onClick: () => nav(`/recruiting/candidates/${r.id}`) }, { label: 'Applications', onClick: () => nav(`/recruiting/candidates/${r.id}?tab=applications`) }, { label: 'Activity', onClick: () => nav(`/recruiting/candidates/${r.id}?tab=activity`) }]}
          emptyTitle={talentPool ? 'Talent pool is empty' : 'No candidates yet'} emptyText={talentPool ? 'Move qualified candidates here from their profile.' : 'Share your recruiter link or add a candidate.'} />
      </Card>
      <CandidateForm open={creating} onClose={() => setCreating(false)} onSaved={c => { setRk(k => k + 1); nav(`/recruiting/candidates/${c.id}`); }} />
      <BulkStatusDialog state={bulkStatus} onClose={() => setBulkStatus(null)} />
    </div>
  );
}
export function TalentPool() { return <Candidates talentPool />; }

function BulkStatusDialog({ state, onClose }: { state: { ids: string[]; reload: () => void } | null; onClose: () => void }) {
  const [to, setTo] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  if (!state) return null;
  const need = REASON_REQUIRED.includes(to);
  const go = async () => { setBusy(true); try { const r = await api.post('/api/v1/candidates/bulk', { ids: state.ids, action: 'status', status: to, reason: reason || undefined }); toast.success(`${r.updated} updated${r.skipped.length ? ` · ${r.skipped.length} skipped: ${r.skipped.slice(0, 2).map((s: any) => `${s.name} (${s.reason})`).join('; ')}` : ''}`); state.reload(); onClose(); setTo(''); setReason(''); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Dialog open onClose={onClose} title={`Change status of ${state.ids.length} candidates`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to || (need && !reason.trim())} loading={busy} onClick={go}>Apply</Button></>}>
    <Field label="New status" htmlFor="bs-to"><select id="bs-to" className="select" value={to} onChange={e => setTo(e.target.value)}><option value="">Choose…</option>{CANDIDATE_STATUSES.filter(s => !['hired', 'submitted', 'interview', 'blacklisted'].includes(s)).map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
    <Field label={`Reason${need ? ' *' : ''}`} htmlFor="bs-r"><textarea id="bs-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>
    <div className="small muted">Each candidate is checked against the lifecycle rules; invalid moves are skipped and reported.</div>
  </Dialog>;
}
void relTime;
