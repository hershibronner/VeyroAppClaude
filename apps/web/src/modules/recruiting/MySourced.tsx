import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Plus, QrCode, Users, Eye, CheckCircle2, Send, CalendarClock, BadgeDollarSign, Trophy, Percent } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { num, pct, shortDate } from '../../lib/format';
import { Boundary, Button, Card, CardHeader, DateRangePicker, Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, Person, presetRange, type DateRange, EntitySelect, Field } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { TrackBars, fmtNum } from '../../components/charts';
import { candidateColumns } from './Candidates';

export default function MySourced() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useState<DateRange>(presetRange(365, 'Last 12 months'));
  const recruiter = sp.get('recruiter') ?? 'me';
  const st = useApi<any>(`/api/v1/recruiting/my-sourced?from=${range.from}&to=${range.to}&recruiter_id=${recruiter}`, [range.from, range.to, recruiter]);
  const [qr, setQr] = useState<any>(null);
  const [newLink, setNewLink] = useState(false);
  const [pos, setPos] = useState<string | null>(null);
  const d = st.data;
  const rid = d?.recruiter?.id;
  const base = rid ? `/recruiting/candidates?recruiter_id=${rid}&from=${range.from}&to=${range.to}` : '#';
  const m = d?.metrics;
  const cards = m ? [
    { label: 'Sourced', icon: <Users size={16} />, value: m.sourced, to: base },
    { label: 'Needs review', icon: <Eye size={16} />, value: m.needs_review, to: `${base}&needs_review=true` },
    { label: 'Qualified', icon: <CheckCircle2 size={16} />, value: m.qualified, to: `${base}&stage=qualified` },
    { label: 'Submitted', icon: <Send size={16} />, value: m.submitted, to: `${base}&stage=submitted` },
    { label: 'Client interview', icon: <CalendarClock size={16} />, value: m.client_interview, to: `${base}&stage=client_interview` },
    { label: 'Offer', icon: <BadgeDollarSign size={16} />, value: m.offer, to: `${base}&stage=offer` },
    { label: 'Hired', icon: <Trophy size={16} />, value: m.hired, to: `${base}&stage=hired` },
    { label: 'Conversion (hired ÷ sourced)', icon: <Percent size={16} />, value: m.conversion_pct === null ? '—' : pct(m.conversion_pct), to: `${base}&stage=hired` },
  ] : [];
  const copy = (u: string) => navigator.clipboard?.writeText(u).then(() => toast.success('Link copied'), () => toast.error('Copy failed'));
  const createLink = async () => { try { const l = await api.post('/api/v1/sourcing/links', { position_id: pos }); toast.success('Link created'); setNewLink(false); setPos(null); st.reload(); setQr(l); } catch (e) { toast.error(e); } };
  return (
    <div>
      <PageHeader title={recruiter === 'me' ? 'My Sourced' : `Sourced by ${d?.recruiter?.name ?? '…'}`} sub="Candidates attributed to you through your links or added by you — and how far they got."
        actions={<><DateRangePicker value={range} onChange={setRange} /><Button variant="primary" icon={<Plus size={16} />} onClick={() => setNewLink(true)}>New sourcing link</Button></>} />
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock rows={6} /> : <>
        <div className="kpi-tiles">{cards.map(c => <button key={c.label} className="kpi-tile" onClick={() => nav(c.to)}><div className="kpi-label">{c.icon}{c.label}</div><div className="kpi-value">{typeof c.value === 'number' ? num(c.value) : c.value}</div><div className="small muted">Open the list</div></button>)}</div>
        <div className="grid-2 mb-3">
          <Boundary label="Links"><Card><CardHeader title="Sourcing links" sub="Every link resolves attribution on the server. Clicks and applications in the selected range." />
            <div className="card-b">{d.links.length === 0 ? <EmptyState title="No links yet" action={<Button size="sm" onClick={() => setNewLink(true)}>Create one</Button>} /> : d.links.map((l: any) => <div key={l.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="bold small">{l.position_title ?? 'Personal recruiter link'}{!l.active && ' (inactive)'}</div><div className="tiny muted truncate">{l.url}</div></div><div className="small right nowrap">{l.clicks} clicks · {l.applications} apps</div><Button size="xs" icon={<Copy size={13} />} aria-label="Copy link" onClick={() => copy(l.url)} /><Button size="xs" icon={<QrCode size={13} />} aria-label="Show QR code" onClick={() => setQr(l)} /></div>)}</div></Card></Boundary>
          <Boundary label="By source"><Card pad><div className="card-title-lg">Sourced by channel</div>{d.by_source.length === 0 ? <EmptyState title="Nothing sourced in this range" /> : <TrackBars data={d.by_source} fmt={fmtNum} height={220} valueName="Candidates" onBarClick={(x: any) => nav(`${base}&source=${encodeURIComponent(x.label)}`)} />}</Card></Boundary>
        </div>
        {d.is_admin && d.recruiters && <Boundary label="Team"><Card className="mb-3"><CardHeader title="All recruiters" sub="Admins see every recruiter's metrics. Click a row to drill in." />
          <div className="table-wrap"><table className="table"><thead><tr><th>Recruiter</th>{['Sourced', 'Needs review', 'Qualified', 'Submitted', 'Client interview', 'Offer', 'Hired', 'Conversion'].map(h => <th key={h} style={{ textAlign: 'right' }}>{h}</th>)}</tr></thead>
            <tbody>{d.recruiters.map((r: any) => <tr key={r.id} className={`clickable ${r.id === rid ? 'selected' : ''}`} onClick={() => { const n = new URLSearchParams(sp); n.set('recruiter', r.id); setSp(n, { replace: true }); }}><td><Person name={r.name} color={r.avatar_color} sub={r.role_name} /></td>{['sourced', 'needs_review', 'qualified', 'submitted', 'client_interview', 'offer', 'hired'].map(k => <td key={k} className="money">{r[k]}</td>)}<td className="money">{r.conversion_pct === null ? '—' : pct(r.conversion_pct)}</td></tr>)}</tbody></table></div></Card></Boundary>}
        {rid && <DataTable title={`Candidates sourced${recruiter === 'me' ? ' by me' : ''}`} endpoint="/api/v1/candidates" params={{ recruiter_id: rid, from: range.from, to: range.to }} columns={candidateColumns()} rowLink={r => `/recruiting/candidates/${r.id}`} exportName="my-sourced" exportResource="candidates" urlState={false} emptyTitle="No candidates sourced in this range" emptyText={<>Share your link: <Link to="#" onClick={e => { e.preventDefault(); d.links[0] && copy(d.links[0].url); }}>copy personal link</Link></>} />}
      </>}
      <Dialog open={!!qr} onClose={() => setQr(null)} title={qr?.position_title ?? qr?.label ?? 'Sourcing link'}>
        {qr && <div className="stack" style={{ alignItems: 'center', gap: 12 }}><img className="rec-qr" src={`/api/v1/qr?text=${encodeURIComponent(qr.url)}`} alt={`QR code for ${qr.url}`} /><div className="rec-linkbox" style={{ width: '100%' }}><input className="input" readOnly value={qr.url} aria-label="Link" onFocus={e => e.target.select()} /><Button icon={<Copy size={16} />} onClick={() => copy(qr.url)}>Copy</Button></div><div className="small muted">Created {shortDate(qr.created_at)}</div></div>}
      </Dialog>
      <Dialog open={newLink} onClose={() => setNewLink(false)} title="New sourcing link" footer={<><Button onClick={() => setNewLink(false)}>Cancel</Button><Button variant="primary" onClick={createLink}>Create link</Button></>}>
        <Field label="Position (optional)" htmlFor="nl-pos" hint="Leave empty for a personal link to your agency's general application page."><EntitySelect id="nl-pos" endpoint="/api/v1/positions?status=open,on_hold" value={pos} onChange={setPos} labelOf={r => r.title + (r.company_name ? ` — ${r.company_name}` : '')} placeholder="Personal link (no position)" /></Field>
      </Dialog>
    </div>
  );
}
