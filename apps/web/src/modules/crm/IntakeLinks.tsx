import { useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { relTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, Dialog, EmptyState, Field, StatusPill } from '../../components/ui';
import { ShareLinkBox } from '../../components/ShareLink';
import { LEAD_SOURCES } from './common';

/** Leads → Generate link: shareable client sign-up links (one question per screen) that create leads owned by you. */
export function IntakeLinksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useApi<any>(open ? '/api/v1/leads/intake-links' : null, [open]);
  const [label, setLabel] = useState('');
  const [source, setSource] = useState('Website');
  const [campaign, setCampaign] = useState('');
  const [created, setCreated] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const l = await api.post('/api/v1/leads/intake-links', { label, source, campaign }); setCreated(l); setLabel(''); setCampaign(''); list.reload(); toast.success('Sign-up link created'); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const toggle = async (l: any) => { try { await api.post(`/api/v1/leads/intake-links/${l.id}/active`, { active: !l.active }); list.reload(); } catch (e) { toast.error(e); } };
  const d = list.data;
  return (
    <Dialog open={open} onClose={() => { setCreated(null); onClose(); }} wide title="Client sign-up link">
      <p className="muted" style={{ marginTop: 0 }}>Share this with prospects. They answer one question at a time — how many VAs, which roles, the work, their hourly budget — and each sign-up lands here as a new lead assigned to you, with a follow-up task.</p>
      {created ? <div className="card card-pad" style={{ background: 'var(--primary-50)', borderColor: 'var(--primary-100)' }}><ShareLinkBox url={created.url} label={`${created.label} · source ${created.source}${created.campaign ? ` · ${created.campaign}` : ''}`} /><div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Create another</Button></div></div> : (
        <div className="card card-pad" style={{ background: 'var(--bg-2)' }}>
          <div className="form-grid">
            <Field label="Link name" htmlFor="il-label" hint="Only you see this — e.g. where you'll post it."><input id="il-label" className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="LinkedIn post, Nov" /></Field>
            <Field label="Lead source" htmlFor="il-source"><select id="il-source" className="select" value={source} onChange={e => setSource(e.target.value)}>{LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Campaign (optional)" htmlFor="il-camp" full><input id="il-camp" className="input" value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="Q4 dental outreach" /></Field>
          </div>
          <div className="mt-2"><Button variant="primary" icon={<Plus size={16} />} loading={busy} onClick={create}>Generate my link</Button></div>
        </div>
      )}
      {d && <div className="mt-3"><ShareLinkBox url={d.general.url} label={`General sign-up page (no owner) · ${d.general.submissions} sign-ups`} /></div>}
      <div className="mt-3">
        <b className="small">Your team's links</b>
        {!d ? <div className="muted small mt-1">Loading…</div> : d.rows.length === 0 ? <EmptyState icon={<Link2 size={20} />} title="No links yet" text="Generate one above." /> : (
          <table className="table mt-1"><thead><tr><th>Link</th><th>Owner</th><th>Source</th><th className="right">Clicks</th><th className="right">Sign-ups</th><th>Last sign-up</th><th /></tr></thead>
            <tbody>{d.rows.map((l: any) => <tr key={l.id}>
              <td><div className="bold">{l.label}</div><button className="btn btn-xs mt-1" onClick={() => { navigator.clipboard.writeText(l.url); toast.success('Link copied'); }}>Copy link</button></td>
              <td>{l.owner_name}</td><td>{l.source}{l.campaign ? <div className="tiny muted">{l.campaign}</div> : null}</td>
              <td className="money">{l.clicks}</td><td className="money">{l.submissions}</td><td className="small muted">{l.last_submission_at ? relTime(l.last_submission_at) : '—'}</td>
              <td className="right">{l.mine ? <Button size="xs" variant="ghost" onClick={() => toggle(l)}>{l.active ? 'Turn off' : 'Turn on'}</Button> : <StatusPill status={l.active ? 'active' : 'inactive'} />}</td>
            </tr>)}</tbody></table>
        )}
      </div>
    </Dialog>
  );
}
