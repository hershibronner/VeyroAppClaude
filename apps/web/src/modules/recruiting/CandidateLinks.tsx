import { useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { Button, Dialog, EmptyState, EntitySelect, Field } from '../../components/ui';
import { ShareLinkBox } from '../../components/ShareLink';

/** Candidates → Generate link: application links (resume first, AI pre-fill, one question per screen) credited to you. */
export function CandidateLinksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useApi<any>(open ? '/api/v1/sourcing/links' : null, [open]);
  const [positionId, setPositionId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const l = await api.post('/api/v1/sourcing/links', { position_id: positionId, label: label || undefined }); setCreated(l); setLabel(''); list.reload(); toast.success('Application link created'); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const toggle = async (l: any) => { try { await api.post(`/api/v1/sourcing/links/${l.id}/active`, { active: !l.active }); list.reload(); } catch (e) { toast.error(e); } };
  const rows: any[] = list.data?.rows ?? [];
  return (
    <Dialog open={open} onClose={() => { setCreated(null); onClose(); }} wide title="Candidate application link">
      <p className="muted" style={{ marginTop: 0 }}>Share this anywhere. Candidates upload their resume, our AI reads it and fills in their answers, then they confirm the rest one question at a time. Every applicant is credited to you and you are notified.</p>
      {created ? <div className="card card-pad" style={{ background: 'var(--primary-50)', borderColor: 'var(--primary-100)' }}><ShareLinkBox url={created.url} label={created.position_title ? `For ${created.position_title}` : created.label} /><div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Create another</Button></div></div> : (
        <div className="card card-pad" style={{ background: 'var(--bg-2)' }}>
          <div className="form-grid">
            <Field label="Position (optional)" htmlFor="cl-pos" hint="Leave empty for a general link — candidates pick a role or join the talent pool."><EntitySelect id="cl-pos" endpoint="/api/v1/positions" extra="status=open" value={positionId} onChange={setPositionId} labelOf={p => `${p.title}${p.company_name ? ` — ${p.company_name}` : ''}`} placeholder="Any open role" /></Field>
            <Field label="Link name (optional)" htmlFor="cl-label" hint="Only you see this."><input id="cl-label" className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Facebook group, Nov" /></Field>
          </div>
          <div className="mt-2"><Button variant="primary" icon={<Plus size={16} />} loading={busy} onClick={create}>Generate my link</Button></div>
        </div>
      )}
      <div className="mt-3">
        <b className="small">Your links</b>
        {!list.data ? <div className="muted small mt-1">Loading…</div> : rows.length === 0 ? <EmptyState icon={<Link2 size={20} />} title="No links yet" text="Generate one above." /> : (
          <table className="table mt-1"><thead><tr><th>Link</th><th>Position</th><th className="right">Clicks</th><th className="right">Applications</th><th /></tr></thead>
            <tbody>{rows.map(l => <tr key={l.id}>
              <td><div className="bold">{l.label}</div><button className="btn btn-xs mt-1" onClick={() => { navigator.clipboard.writeText(l.url); toast.success('Link copied'); }}>Copy link</button></td>
              <td>{l.position_title ?? <span className="muted">Any role</span>}</td><td className="money">{l.clicks}</td><td className="money">{l.applications}</td>
              <td className="right"><Button size="xs" variant="ghost" onClick={() => toggle(l)}>{l.active ? 'Turn off' : 'Turn on'}</Button></td>
            </tr>)}</tbody></table>
        )}
      </div>
    </Dialog>
  );
}
