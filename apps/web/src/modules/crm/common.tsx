// Shared CRM constants and small display components.
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { qs } from '../../lib/api';
import { Avatar, Banner } from '../../components/ui';
import { opts } from '../../components/DataTable';
import './crm.css';

export const LEAD_SOURCES = ['Website', 'Referral', 'LinkedIn', 'Cold Outreach', 'Event', 'Ads', 'Partner'];
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted'] as const;
export const OPP_STAGES = ['new', 'discovery', 'proposal', 'negotiation', 'won', 'lost'] as const;
export const INDUSTRIES = ['dental', 'real estate', 'ecommerce', 'law', 'insurance', 'marketing', 'healthcare', 'accounting', 'logistics', 'technology', 'other'];
export const SIZES = ['1-10', '11-50', '51-200', '201-500', '500+'];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const RELATED_TYPES = ['company', 'contact', 'opportunity', 'position', 'candidate', 'placement', 'invoice', 'worker'] as const;
export const CLIENT_ROLES = [
  { value: 'client_owner', label: 'Client Owner — full access' }, { value: 'client_manager', label: 'Client Manager — team & approvals' },
  { value: 'client_supervisor', label: 'Client Supervisor — team & timesheets' }, { value: 'client_finance', label: 'Client Finance — invoices & payments' }, { value: 'client_viewer', label: 'Client Viewer — read only' },
];
export const sourceOpts = LEAD_SOURCES.map(s => ({ value: s, label: s }));
export const industryOpts = opts(INDUSTRIES);
export const sizeOpts = SIZES.map(s => ({ value: s, label: `${s} employees` }));

/** Web path for any related record (tasks, activities). */
export function relatedLink(type: string | null | undefined, id: string | null | undefined, stage?: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'company': return stage === 'lead' || stage === 'qualified' ? `/crm/leads/${id}` : stage ? `/crm/clients/${id}` : `/crm/companies/${id}`;
    case 'contact': return `/crm/contacts/${id}`;
    case 'opportunity': return `/crm/opportunities/${id}`;
    case 'task': return `/crm/tasks?task=${id}`;
    case 'position': return `/recruiting/positions/${id}`;
    case 'candidate': return `/recruiting/candidates/${id}`;
    case 'placement': return `/workforce/placements/${id}`;
    case 'worker': return `/workforce/workers/${id}`;
    case 'invoice': return `/finance/invoices/${id}`;
    case 'timesheet': return `/time/timesheets/${id}`;
    case 'offer': return `/recruiting/offers`;
    case 'interview': return `/recruiting/interviews`;
    case 'submission': return `/recruiting/submissions`;
    case 'payroll_run': return `/finance/payroll/${id}`;
    case 'document': return `/documents`;
    default: return null;
  }
}
export const RELATED_LABEL: Record<string, string> = { company: 'Company', contact: 'Contact', opportunity: 'Opportunity', position: 'Position', candidate: 'Candidate', placement: 'Placement', invoice: 'Invoice', worker: 'Worker', task: 'Task', timesheet: 'Timesheet', offer: 'Offer', interview: 'Interview', submission: 'Submission', payroll_run: 'Payroll run', document: 'Document' };
export const companyLink = (c: { id: string; stage?: string | null }) => relatedLink('company', c.id, c.stage ?? 'client')!;

/** Lead score badge: hot ≥70, warm 40–69, cold <40. */
export function ScoreBadge({ score }: { score: number | null | undefined }) {
  const s = Number(score ?? 0);
  const tone = s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold';
  return <span className={`crm-score crm-score-${tone}`} title={`Lead score ${s}/100 (${tone})`}>{s}</span>;
}

export function Assignees({ list, max = 3 }: { list: { id: string; name: string; avatar_color?: string | null }[]; max?: number }) {
  if (!list?.length) return <span className="muted">Unassigned</span>;
  return (
    <span className="crm-avatars" title={list.map(a => a.name).join(', ')}>
      {list.slice(0, max).map(a => <Avatar key={a.id} name={a.name} color={a.avatar_color} size={24} />)}
      {list.length > max && <span className="crm-more">+{list.length - max}</span>}
      {list.length === 1 && <span className="small" style={{ marginLeft: 6 }}>{list[0].name}</span>}
    </span>
  );
}

/** Live duplicate warning (warns, never blocks). */
export function DuplicateWarning({ name, website, email, phone, exclude }: { name?: string; website?: string; email?: string; phone?: string; exclude?: string }) {
  const key = useDebounced(JSON.stringify({ name: name ?? '', website: website ?? '', email: email ?? '', phone: phone ?? '' }), 450);
  const p = JSON.parse(key);
  const enough = (p.name?.trim().length ?? 0) >= 3 || p.website || p.email || (p.phone?.replace(/\D/g, '').length ?? 0) >= 7;
  const state = useApi<{ matches: { type: string; id: string; name: string; reason: string; link: string }[] }>(enough ? `/api/v1/companies/duplicates${qs({ ...p, exclude })}` : null, [key]);
  const m = state.data?.matches ?? [];
  if (!enough || !m.length) return null;
  return (
    <div className="mt-3">
      <Banner tone="warn" icon={<AlertTriangle size={18} />}>
        <b>Possible duplicate{m.length > 1 ? 's' : ''}.</b> You can still save — review these first:
        <ul className="crm-dups">{m.slice(0, 5).map(x => <li key={x.type + x.id}><Link to={x.link} target="_blank" rel="noreferrer">{x.name}</Link> <span className="muted small">— {x.reason}</span></li>)}</ul>
      </Banner>
    </div>
  );
}

export const leadStatusLabel = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : 'New');
