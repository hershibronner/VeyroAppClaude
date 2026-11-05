// CRM create/edit drawers and action dialogs (used by pages and Quick Create).
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { money, humanize, todayISO, addDaysISO } from '../../lib/format';
import { FormDrawer, type FieldDef } from '../../components/FormDrawer';
import { Banner, Button, Dialog, EntitySelect, Field, MemberSelect, MoneyInput, Segmented, useMembers, Avatar, LoadingBlock, ErrorState } from '../../components/ui';
import { DuplicateWarning, sourceOpts, industryOpts, sizeOpts, RELATED_TYPES, RELATED_LABEL, TASK_PRIORITIES, CLIENT_ROLES } from './common';
import { opts } from '../../components/DataTable';

const clean = (v: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter(k => k in v).map(k => [k, v[k] === '' ? null : v[k]]));

/* ─────────────── Lead ─────────────── */
const LEAD_KEYS = ['name', 'website', 'industry', 'size', 'country', 'phone', 'email', 'source', 'campaign', 'owner_id', 'lead_score', 'est_workers', 'est_monthly_value_cents', 'next_follow_up', 'notes'];
export function LeadForm({ open, onClose, lead, onSaved }: { open: boolean; onClose: () => void; lead?: any; onSaved?: (row: any) => void }) {
  const edit = !!lead;
  const fields: FieldDef[] = [
    { name: 'name', label: 'Company name', required: true, full: true, placeholder: 'e.g. Cobalt Ridge Realty' },
    { name: 'website', label: 'Website', type: 'url', placeholder: 'company.com' },
    { name: 'industry', label: 'Industry', type: 'select', options: industryOpts },
    { name: 'size', label: 'Company size', type: 'select', options: sizeOpts },
    { name: 'country', label: 'Country', placeholder: 'United States' },
    { name: 'source', label: 'Source', type: 'select', options: sourceOpts },
    { name: 'campaign', label: 'Campaign', placeholder: 'e.g. Q4 Dental Outreach' },
    { name: 'owner_id', label: 'Owner', type: 'member', placeholder: edit ? 'Unassigned' : 'Me' },
    { name: 'lead_score', label: 'Lead score (0–100)', type: 'number' },
    { name: 'est_workers', label: 'Estimated workers needed', type: 'number' },
    { name: 'est_monthly_value_cents', label: 'Estimated monthly value', type: 'money' },
    { name: 'next_follow_up', label: 'Next follow-up', type: 'date' },
    ...(!edit ? [
      { name: 'c_first', label: 'Contact first name', hint: 'Primary contact person (optional)' },
      { name: 'c_last', label: 'Contact last name' },
      { name: 'c_title', label: 'Contact title', placeholder: 'e.g. Practice Manager' },
      { name: 'c_email', label: 'Contact email', type: 'email' as const },
      { name: 'c_phone', label: 'Contact phone', type: 'phone' as const },
    ] : []),
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  return (
    <FormDrawer open={open} onClose={onClose} title={edit ? `Edit ${lead.name}` : 'New lead'} fields={fields} submitLabel={edit ? 'Save changes' : 'Create lead'}
      initial={edit ? { ...lead } : { lead_score: 10 }}
      onSubmit={async v => {
        const body: any = clean(v, LEAD_KEYS);
        if (!edit && v.c_first) body.contact = { first_name: v.c_first, last_name: v.c_last || null, title: v.c_title || null, email: v.c_email || null, phone: v.c_phone && v.c_phone.replace(/\D/g, '').length > 4 ? v.c_phone : null };
        try {
          const row = edit ? await api.patch(`/api/v1/leads/${lead.id}`, body) : await api.post('/api/v1/leads', body);
          toast.success(edit ? 'Lead updated' : `Lead ${row.name} created`);
          onSaved?.(row);
        } catch (e) { mapContactErrors(e); throw e; }
      }}>
      {v => <DuplicateWarning name={v.name} website={v.website} email={v.c_email || v.email} phone={v.c_phone} exclude={lead?.id} />}
    </FormDrawer>
  );
}
function mapContactErrors(e: unknown) {
  if (e instanceof ApiError && e.fields) for (const [k, m] of Object.entries(e.fields)) { const mm = /^contact\.(.+)$/.exec(k); if (mm) e.fields[`c_${({ first_name: 'first', last_name: 'last' } as any)[mm[1]] ?? mm[1]}`] = m; }
}

/* ─────────────── Client ─────────────── */
const CLIENT_KEYS = ['name', 'website', 'industry', 'size', 'country', 'phone', 'email', 'address', 'source', 'owner_id', 'account_manager_id', 'notes', 'timesheet_approval', 'portal_screenshots', 'payment_terms_days'];
export function ClientForm({ open, onClose, client, onSaved }: { open: boolean; onClose: () => void; client?: any; onSaved?: (row: any) => void }) {
  const edit = !!client;
  const fields: FieldDef[] = [
    { name: 'name', label: 'Company name', required: true, full: true },
    { name: 'website', label: 'Website', type: 'url' }, { name: 'industry', label: 'Industry', type: 'select', options: industryOpts },
    { name: 'size', label: 'Company size', type: 'select', options: sizeOpts }, { name: 'country', label: 'Country' },
    { name: 'phone', label: 'Main phone', type: 'phone' }, { name: 'email', label: 'Main email', type: 'email' },
    { name: 'address', label: 'Address', full: true },
    { name: 'account_manager_id', label: 'Account manager', type: 'member', placeholder: 'Unassigned' },
    { name: 'owner_id', label: 'Sales owner', type: 'member', placeholder: edit ? 'Unassigned' : 'Me' },
    { name: 'source', label: 'Source', type: 'select', options: sourceOpts },
    ...(edit ? [
      { name: 'timesheet_approval', label: 'Timesheet approval', type: 'select' as const, options: [{ value: 'client', label: 'Client approves' }, { value: 'agency', label: 'Agency approves' }, { value: 'both', label: 'Agency, then client' }] },
      { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' as const },
      { name: 'portal_screenshots', label: 'Client portal', type: 'checkbox' as const, placeholder: 'Client can view worker screenshots' },
    ] : [
      { name: 'c_first', label: 'Primary contact first name' }, { name: 'c_last', label: 'Primary contact last name' },
      { name: 'c_title', label: 'Contact title' }, { name: 'c_email', label: 'Contact email', type: 'email' as const },
    ]),
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  return (
    <FormDrawer open={open} onClose={onClose} title={edit ? `Edit ${client.name}` : 'New client'} fields={fields} submitLabel={edit ? 'Save changes' : 'Create client'}
      initial={edit ? { ...client } : {}}
      onSubmit={async v => {
        const body: any = clean(v, CLIENT_KEYS);
        if (!edit) { delete body.timesheet_approval; delete body.payment_terms_days; delete body.portal_screenshots; }
        if (body.phone && body.phone.replace(/\D/g, '').length < 5) body.phone = null;
        if (!edit && v.c_first) body.contact = { first_name: v.c_first, last_name: v.c_last || null, title: v.c_title || null, email: v.c_email || null };
        try {
          const row = edit ? await api.patch(`/api/v1/companies/${client.id}`, body) : await api.post('/api/v1/companies', body);
          toast.success(edit ? 'Client updated' : `Client ${row.name} created`);
          onSaved?.(row);
        } catch (e) { mapContactErrors(e); throw e; }
      }}>
      {v => <DuplicateWarning name={v.name} website={v.website} email={v.c_email || v.email} phone={v.phone} exclude={client?.id} />}
    </FormDrawer>
  );
}

/* ─────────────── Contact ─────────────── */
export function ContactForm({ open, onClose, contact, companyId, onSaved }: { open: boolean; onClose: () => void; contact?: any; companyId?: string | null; onSaved?: (row: any) => void }) {
  const edit = !!contact;
  const fields: FieldDef[] = [
    { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
    { name: 'title', label: 'Job title' },
    { name: 'company_id', label: 'Company', type: 'entity', endpoint: '/api/v1/companies', labelOf: r => `${r.name}${r.stage === 'lead' || r.stage === 'qualified' ? ' (lead)' : ''}`, placeholder: 'No company', hint: 'Optional — can be changed later' },
    ...(!edit ? [{ name: 'email', label: 'Email', type: 'email' as const }, { name: 'phone', label: 'Phone', type: 'phone' as const }] : []),
    { name: 'is_primary', label: 'Primary contact', type: 'checkbox', placeholder: 'Primary contact for this company', hidden: v => !v.company_id },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  return (
    <FormDrawer open={open} onClose={onClose} title={edit ? `Edit ${contact.first_name} ${contact.last_name ?? ''}` : 'New contact'} fields={fields} submitLabel={edit ? 'Save changes' : 'Create contact'}
      initial={edit ? { ...contact } : { company_id: companyId ?? null, is_primary: false }}
      onSubmit={async v => {
        const body: any = clean(v, ['first_name', 'last_name', 'title', 'company_id', 'is_primary', 'notes', ...(edit ? [] : ['email', 'phone'])]);
        if (body.phone && body.phone.replace(/\D/g, '').length < 5) body.phone = null;
        if (!body.company_id) body.is_primary = false;
        const row = edit ? await api.patch(`/api/v1/contacts/${contact.id}`, body) : await api.post('/api/v1/contacts', body);
        toast.success(edit ? 'Contact updated' : `Contact ${row.first_name} created`);
        onSaved?.(row);
      }}>
      {v => (!edit ? <DuplicateWarning email={v.email} phone={v.phone} /> : null)}
    </FormDrawer>
  );
}

/* ─────────────── Opportunity ─────────────── */
export function OpportunityForm({ open, onClose, opp, companyId, onSaved }: { open: boolean; onClose: () => void; opp?: any; companyId?: string | null; onSaved?: (row: any) => void }) {
  const edit = !!opp;
  const fields: FieldDef[] = [
    { name: 'name', label: 'Opportunity name', required: true, full: true, placeholder: 'e.g. Brightline Dental — 2 front desk VAs' },
    { name: 'company_id', label: 'Company', type: 'entity', endpoint: '/api/v1/companies', labelOf: r => `${r.name}${r.stage === 'lead' || r.stage === 'qualified' ? ' (lead)' : ''}`, placeholder: 'No company' },
    { name: 'contact_id', label: 'Contact', type: 'custom', render: (val, set, vals) => <EntitySelect id="f-contact_id" endpoint={`/api/v1/contacts${vals.company_id ? `?company_id=${vals.company_id}` : ''}`} value={val} onChange={set} labelOf={r => r.name + (r.company_name && !vals.company_id ? ` (${r.company_name})` : '')} placeholder="No contact" /> },
    ...(!edit ? [{ name: 'stage', label: 'Stage', type: 'select' as const, options: opts(['new', 'discovery', 'proposal', 'negotiation']) }] : []),
    { name: 'owner_id', label: 'Owner', type: 'member', placeholder: edit ? 'Unassigned' : 'Me' },
    { name: 'value_cents', label: 'Monthly value', type: 'money' }, { name: 'est_workers', label: 'Estimated workers', type: 'number' },
    { name: 'expected_close', label: 'Expected close', type: 'date' }, { name: 'probability', label: 'Probability %', type: 'number', hint: 'Defaults from the stage' },
    { name: 'source', label: 'Source', type: 'select', options: sourceOpts }, { name: 'campaign', label: 'Campaign' },
  ];
  return (
    <FormDrawer open={open} onClose={onClose} title={edit ? `Edit ${opp.name}` : 'New opportunity'} fields={fields} submitLabel={edit ? 'Save changes' : 'Create opportunity'}
      initial={edit ? { ...opp } : { company_id: companyId ?? null, stage: 'new' }}
      onSubmit={async v => {
        const body: any = clean(v, ['name', 'company_id', 'contact_id', 'owner_id', 'value_cents', 'est_workers', 'expected_close', 'probability', 'source', 'campaign', ...(edit ? [] : ['stage'])]);
        const row = edit ? await api.patch(`/api/v1/opportunities/${opp.id}`, body) : await api.post('/api/v1/opportunities', body);
        toast.success(edit ? 'Opportunity updated' : `Opportunity created`);
        onSaved?.(row);
      }} />
  );
}

/* ─────────────── Task ─────────────── */
const REL_ENDPOINT: Record<string, string> = { company: '/api/v1/companies', contact: '/api/v1/contacts', opportunity: '/api/v1/opportunities', position: '/api/v1/positions', candidate: '/api/v1/candidates', placement: '/api/v1/placements', invoice: '/api/v1/invoices', worker: '/api/v1/workers' };
export const genericLabel = (r: any) => r.name || r.title && (r.worker_name ? `${r.worker_name} — ${r.title}` : r.title) || (r.number ? `Invoice ${r.number}${r.company_name ? ' · ' + r.company_name : ''}` : '') || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.worker_name || r.email || 'Record';

export function MembersMulti({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) {
  const { data } = useMembers();
  const list = data ?? [];
  return (
    <div>
      {value.length > 0 && <div className="chips mb-2">{value.map(uid => { const m = list.find(x => x.id === uid); return <span key={uid} className="chip"><Avatar name={m?.name} color={m?.avatar_color} size={18} /> {m?.name ?? 'Member'}<button type="button" aria-label={`Remove ${m?.name ?? 'assignee'}`} onClick={() => onChange(value.filter(x => x !== uid))}><X size={12} /></button></span>; })}</div>}
      <select id={id} className="select" value="" onChange={e => { if (e.target.value) onChange([...new Set([...value, e.target.value])]); }} aria-label="Add assignee">
        <option value="">{value.length ? 'Add another assignee…' : 'Add assignee…'}</option>
        {list.filter(m => !value.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name} — {m.role_name}</option>)}
      </select>
    </div>
  );
}

export function TaskForm({ open, onClose, task, related, onSaved }: { open: boolean; onClose: () => void; task?: any; related?: { type: string; id: string; label?: string }; onSaved?: (row: any) => void }) {
  const edit = !!task;
  const fields: FieldDef[] = [
    { name: 'title', label: 'Title', required: true, full: true, placeholder: 'e.g. Follow up on proposal' },
    { name: 'priority', label: 'Priority', type: 'select', options: opts(TASK_PRIORITIES), placeholder: 'Medium' },
    { name: 'assignee_ids', label: 'Assignees', type: 'custom', render: (val, set) => <MembersMulti id="f-assignee_ids" value={val ?? []} onChange={set} />, hint: edit ? undefined : 'Defaults to you' },
    { name: 'due_date', label: 'Due date', type: 'date' }, { name: 'due_time', label: 'Due time (optional)', type: 'time' },
    ...(!edit ? [
      { name: 'reminder', label: 'Reminder', type: 'select' as const, placeholder: 'No reminder', options: [{ value: 'at_due', label: 'At due time' }, { value: '15m', label: '15 minutes before' }, { value: '1h', label: '1 hour before' }, { value: '1d', label: '1 day before' }, { value: 'custom', label: 'Custom date & time…' }], hint: 'In-app notification + email' },
      { name: 'remind_at', label: 'Remind at', type: 'datetime' as const, hidden: (v: any) => v.reminder !== 'custom' },
    ] : []),
    { name: 'related_type', label: 'Related to', type: 'select', options: RELATED_TYPES.map(t => ({ value: t, label: RELATED_LABEL[t] })), placeholder: 'Nothing', hidden: () => !!related },
    { name: 'related_id', label: 'Record', type: 'custom', hidden: v => !!related || !v.related_type, render: (val, set, vals) => <EntitySelect key={vals.related_type} id="f-related_id" endpoint={REL_ENDPOINT[vals.related_type]} value={val} onChange={set} labelOf={genericLabel} placeholder={`Pick a ${RELATED_LABEL[vals.related_type]?.toLowerCase()}`} /> },
    { name: 'description', label: 'Details', type: 'textarea' },
  ];
  return (
    <FormDrawer open={open} onClose={onClose} title={edit ? 'Edit task' : related?.label ? `New task · ${related.label}` : 'New task'} fields={fields} submitLabel={edit ? 'Save changes' : 'Create task'}
      initial={edit ? { ...task, assignee_ids: (task.assignees ?? []).map((a: any) => a.id) } : { priority: 'medium', assignee_ids: [], related_type: related?.type ?? null, related_id: related?.id ?? null, due_date: addDaysISO(todayISO(), 1) }}
      onSubmit={async v => {
        if (v.related_type && !v.related_id) throw new ApiError(400, 'Pick the related record', { related_id: 'Pick a record' });
        const body: any = clean(v, ['title', 'priority', 'assignee_ids', 'due_date', 'due_time', 'related_type', 'related_id', 'description', ...(edit ? [] : ['reminder', 'remind_at'])]);
        if (!body.priority) body.priority = 'medium';
        if (!edit && !body.reminder) body.reminder = 'none';
        if (!body.related_type) { body.related_type = null; body.related_id = null; }
        const row = edit ? await api.patch(`/api/v1/tasks/${task.id}`, body) : await api.post('/api/v1/tasks', body);
        toast.success(edit ? 'Task updated' : 'Task created');
        onSaved?.(row);
      }} />
  );
}

/* ─────────────── Log activity ─────────────── */
export function LogActivityDialog({ open, onClose, type, id, onDone }: { open: boolean; onClose: () => void; type: string; id: string; onDone?: () => void }) {
  const [kind, setKind] = useState<'call' | 'email' | 'meeting' | 'note'>('call');
  const [body, setBody] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setBody(''); setKind('call'); } }, [open]);
  const submit = async () => {
    setBusy(true);
    try { await api.post(`/api/v1/timeline/${type}/${id}`, { kind, body }); toast.success(kind === 'note' ? 'Note added' : `${humanize(kind)} logged`); onDone?.(); onClose(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Log activity" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!body.trim()} onClick={submit}>Log {kind}</Button></>}>
      <Segmented value={kind} onChange={setKind} options={[{ key: 'call', label: 'Call' }, { key: 'email', label: 'Email' }, { key: 'meeting', label: 'Meeting' }, { key: 'note', label: 'Note' }]} />
      <Field label="What happened?" htmlFor="la-body"><textarea id="la-body" className="textarea mt-2" autoFocus value={body} onChange={e => setBody(e.target.value)} placeholder={kind === 'call' ? 'Spoke with the practice manager about 2 front-desk VAs…' : 'Details'} /></Field>
      {type === 'company' && kind !== 'note' && <div className="muted small">Calls, emails and meetings raise the lead score and mark new leads as contacted.</div>}
    </Dialog>
  );
}

/* ─────────────── Send email from template (→ Dev Outbox) ─────────────── */
export function SendEmailDialog({ open, onClose, leadId, contacts, onDone }: { open: boolean; onClose: () => void; leadId: string; contacts: any[]; onDone?: () => void }) {
  const withEmail = contacts.filter(c => c.email);
  const [contactId, setContactId] = useState<string>(withEmail[0]?.id ?? '');
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false);
  const preview = useApi<any>(open ? `/api/v1/leads/${leadId}/email-preview${contactId ? `?contact_id=${contactId}` : ''}` : null, [contactId, open]);
  useEffect(() => { if (preview.data) { setSubject(preview.data.subject); setBody(preview.data.body); setTo(preview.data.to ?? ''); } }, [preview.data]);
  const send = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/v1/leads/${leadId}/send-email`, { contact_id: contactId || null, to: to || null, subject, body, template_key: 'lead_outreach' }); toast.success(`Email sent to ${r.to} — see Dev Outbox`); onDone?.(); onClose(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} wide title="Send email" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!to || !subject || !body} onClick={send}>Send email</Button></>}>
      {preview.error ? <ErrorState error={preview.error} retry={preview.reload} /> : !preview.data ? <LoadingBlock rows={3} /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-grid">
            <Field label="Contact" htmlFor="se-c"><select id="se-c" className="select" value={contactId} onChange={e => setContactId(e.target.value)}><option value="">— Type an address —</option>{withEmail.map(c => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ')} · {c.email}</option>)}</select></Field>
            <Field label="To" htmlFor="se-to"><input id="se-to" className="input" type="email" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
          <Field label="Subject" htmlFor="se-s"><input id="se-s" className="input" value={subject} onChange={e => setSubject(e.target.value)} /></Field>
          <Field label="Message" htmlFor="se-b" hint="From the “Lead outreach” template. Demo mode: delivered to the Dev Outbox and logged on the timeline."><textarea id="se-b" className="textarea" style={{ minHeight: 180 }} value={body} onChange={e => setBody(e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}

/* ─────────────── Convert lead → client ─────────────── */
export function ConvertDialog({ open, onClose, lead }: { open: boolean; onClose: () => void; lead: any }) {
  const nav = useNavigate();
  const contacts: any[] = lead?.contacts ?? [];
  const [keep, setKeep] = useState<string[]>([]); const [primary, setPrimary] = useState<string>('');
  const [newContacts, setNewContacts] = useState<any[]>([]);
  const [am, setAm] = useState<string | null>(null);
  const [withOpp, setWithOpp] = useState(true); const [opp, setOpp] = useState<any>({});
  const [withPos, setWithPos] = useState(false); const [pos, setPos] = useState<any>({ title: '', openings: 1 });
  const [busy, setBusy] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open || !lead) return;
    setKeep(contacts.map(c => c.id)); setPrimary(contacts.find(c => c.is_primary)?.id ?? contacts[0]?.id ?? ''); setNewContacts([]); setAm(lead.account_manager_id ?? null);
    setWithOpp(true); setOpp({ name: `${lead.name} — remote staffing`, value_cents: lead.est_monthly_value_cents ?? null, est_workers: lead.est_workers ?? null, expected_close: addDaysISO(todayISO(), 30), stage: 'proposal' });
    setWithPos(false); setPos({ title: '', openings: lead.est_workers || 1 }); setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead?.id]);
  if (!lead) return null;
  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const r = await api.post(`/api/v1/leads/${lead.id}/convert`, {
        keep_contact_ids: keep, primary_contact_id: primary || null, account_manager_id: am,
        new_contacts: newContacts.filter(c => c.first_name?.trim()).map(c => ({ first_name: c.first_name, last_name: c.last_name || null, title: c.title || null, email: c.email || null, phone: c.phone || null })),
        opportunity: withOpp ? { name: opp.name, value_cents: opp.value_cents, est_workers: opp.est_workers, expected_close: opp.expected_close || null, stage: opp.stage } : null,
        position: withPos ? { title: pos.title, openings: Number(pos.openings) || 1 } : null,
      });
      toast.success(`${lead.name} converted to a client${r.opportunity_id ? ' · opportunity created' : ''}${r.position_id ? ' · position drafted' : ''}`);
      onClose(); nav(`/crm/clients/${r.id}`);
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  const status = lead.lead_status ?? 'new';
  return (
    <Dialog open={open} onClose={onClose} wide title={`Convert ${lead.name} to a client`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Convert to client</Button></>}>
      <div className="stack" style={{ gap: 6 }}>
        <Banner>The same company record becomes a client — its full activity history, tasks and documents stay attached.{status !== 'qualified' && <> It will be marked <b>Qualified</b> first (currently {humanize(status)}).</>}</Banner>
        <div className="crm-section-title">Contacts to keep</div>
        {contacts.length === 0 && <div className="muted small">This lead has no contacts yet — add one below.</div>}
        {contacts.map(c => (
          <label key={c.id} className={`crm-pick ${keep.includes(c.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={keep.includes(c.id)} onChange={e => setKeep(k => (e.target.checked ? [...k, c.id] : k.filter(x => x !== c.id)))} />
            <div style={{ flex: 1 }}><b>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</b> <span className="muted small">{c.title ?? ''}</span><div className="small muted">{[c.email, c.phone].filter(Boolean).join(' · ') || 'No email or phone'}</div></div>
            <label className="check small" onClick={e => e.stopPropagation()}><input type="radio" name="primary" disabled={!keep.includes(c.id)} checked={primary === c.id} onChange={() => setPrimary(c.id)} /> Primary</label>
          </label>
        ))}
        {contacts.some(c => !keep.includes(c.id)) && <div className="muted small">Unchecked contacts are detached from the company but kept as standalone contacts.</div>}
        {newContacts.map((c, i) => (
          <div key={i} className="crm-new-contact form-grid">
            {(['first_name', 'last_name', 'title', 'email'] as const).map(k => <Field key={k} label={humanize(k)} htmlFor={`nc-${i}-${k}`} error={errors[`new_contacts.${i}.${k}`]}><input id={`nc-${i}-${k}`} className="input" value={c[k] ?? ''} onChange={e => setNewContacts(l => l.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} /></Field>)}
            <div className="full"><Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setNewContacts(l => l.filter((_, j) => j !== i))}>Remove</Button></div>
          </div>
        ))}
        <div><Button size="sm" icon={<Plus size={14} />} onClick={() => setNewContacts(l => [...l, {}])}>Add a contact</Button></div>

        <div className="crm-section-title">Account management</div>
        <Field label="Account manager" htmlFor="cv-am"><MemberSelect id="cv-am" value={am} onChange={setAm} placeholder="Assign later" /></Field>

        <label className="check mt-2"><input type="checkbox" checked={withOpp} onChange={e => setWithOpp(e.target.checked)} /> <b>Create an opportunity</b></label>
        {withOpp && <div className="form-grid crm-new-contact">
          <Field full label="Name *" htmlFor="cv-on" error={errors['opportunity.name']}><input id="cv-on" className="input" value={opp.name ?? ''} onChange={e => setOpp({ ...opp, name: e.target.value })} /></Field>
          <Field label="Monthly value" htmlFor="cv-ov"><MoneyInput id="cv-ov" cents={opp.value_cents} onChange={c => setOpp({ ...opp, value_cents: c })} /></Field>
          <Field label="Estimated workers" htmlFor="cv-ow"><input id="cv-ow" type="number" className="input" value={opp.est_workers ?? ''} onChange={e => setOpp({ ...opp, est_workers: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          <Field label="Stage" htmlFor="cv-os"><select id="cv-os" className="select" value={opp.stage} onChange={e => setOpp({ ...opp, stage: e.target.value })}>{['new', 'discovery', 'proposal', 'negotiation'].map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
          <Field label="Expected close" htmlFor="cv-oc"><input id="cv-oc" type="date" className="input" value={opp.expected_close ?? ''} onChange={e => setOpp({ ...opp, expected_close: e.target.value })} /></Field>
        </div>}
        <label className="check mt-2"><input type="checkbox" checked={withPos} onChange={e => setWithPos(e.target.checked)} /> <b>Create a position</b> <span className="muted small">(saved as Draft in Recruiting)</span></label>
        {withPos && <div className="form-grid crm-new-contact">
          <Field label="Position title *" htmlFor="cv-pt" error={errors['position.title']}><input id="cv-pt" className="input" value={pos.title} placeholder="e.g. Dental Front Desk VA" onChange={e => setPos({ ...pos, title: e.target.value })} /></Field>
          <Field label="Openings" htmlFor="cv-po"><input id="cv-po" type="number" min={1} className="input" value={pos.openings} onChange={e => setPos({ ...pos, openings: e.target.value })} /></Field>
        </div>}
      </div>
    </Dialog>
  );
}

/* ─────────────── Opportunity Won ─────────────── */
export function WonDialog({ open, onClose, opp, onDone }: { open: boolean; onClose: () => void; opp: any; onDone?: (r: any) => void }) {
  const [activate, setActivate] = useState(true); const [withPos, setWithPos] = useState(false);
  const [title, setTitle] = useState(''); const [openings, setOpenings] = useState<number>(1); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && opp) { setActivate(true); setWithPos(!!opp.company_id); setTitle(''); setOpenings(opp.est_workers || 1); } }, [open, opp]);
  if (!opp) return null;
  const isClient = opp.company_stage === 'client';
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/v1/opportunities/${opp.id}/stage`, { stage: 'won', activate_client: activate, position: withPos ? { title, openings } : null });
      toast.success(`Won ${opp.name}${r.client_activated ? ` · ${opp.company_name} is now a client` : ''}${r.position_id ? ' · position drafted' : ''}`);
      onDone?.(r); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Mark “${opp.name}” as won`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="success" loading={busy} disabled={withPos && title.trim().length < 2} onClick={submit}>Mark won</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {opp.company_id ? (
          <>
            {!isClient && <label className="check"><input type="checkbox" checked={activate} onChange={e => setActivate(e.target.checked)} /> Activate <b>{opp.company_name}</b> as a client</label>}
            {isClient && <div className="muted small">{opp.company_name} is already an active client.</div>}
            <label className="check"><input type="checkbox" checked={withPos} onChange={e => setWithPos(e.target.checked)} /> Create a position for this deal</label>
            {withPos && <div className="form-grid">
              <Field label="Position title *" htmlFor="won-t"><input id="won-t" className="input" autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Insurance Claims VA" /></Field>
              <Field label="Openings" htmlFor="won-o"><input id="won-o" type="number" min={1} className="input" value={openings} onChange={e => setOpenings(Number(e.target.value) || 1)} /></Field>
            </div>}
          </>
        ) : <div className="muted">No company is linked to this opportunity, so no client or position will be created.</div>}
        <div className="muted small">Value {money(Number(opp.value_cents ?? 0), opp.currency ?? 'USD')} / month · writes an activity and an audit entry.</div>
      </div>
    </Dialog>
  );
}

/* ─────────────── Invite to client portal ─────────────── */
export function InvitePortalDialog({ open, onClose, company, onDone }: { open: boolean; onClose: () => void; company: any; onDone?: () => void }) {
  const contacts = useApi<any>(open ? `/api/v1/contacts?company_id=${company.id}&pageSize=200` : null, [open]);
  const rows: any[] = contacts.data?.rows ?? [];
  const [contactId, setContactId] = useState(''); const [role, setRole] = useState('client_owner'); const [days, setDays] = useState(7); const [busy, setBusy] = useState(false); const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setContactId(''); setRole('client_owner'); setDays(7); setErr({}); } }, [open]);
  useEffect(() => { if (open && !contactId && rows.length) setContactId((rows.find(r => r.is_primary && r.email) ?? rows.find(r => r.email))?.id ?? ''); }, [rows, open, contactId]);
  const submit = async () => {
    setBusy(true); setErr({});
    try { const r = await api.post(`/api/v1/companies/${company.id}/portal-invitations`, { contact_id: contactId, role_key: role, expires_days: days }); toast.success(`Invitation sent to ${r.email} (see Dev Outbox)`); onDone?.(); onClose(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErr(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Invite to client portal`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!contactId} onClick={submit}>Send invitation</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="muted small">The contact gets an email with a personal sign-up link for the {company.name} portal (team, timesheets, invoices). Nothing is sent automatically.</div>
        {contacts.loading && !contacts.data ? <LoadingBlock rows={2} /> : rows.length === 0 ? <Banner tone="warn">Add a contact with an email address first.</Banner> : (
          <Field label="Contact" htmlFor="ip-c" error={err.contact_id}><select id="ip-c" className="select" value={contactId} onChange={e => setContactId(e.target.value)}><option value="">Choose a contact…</option>{rows.map(r => <option key={r.id} value={r.id} disabled={!r.email}>{r.name}{r.email ? ` · ${r.email}` : ' · no email'}</option>)}</select></Field>
        )}
        <Field label="Portal role" htmlFor="ip-r"><select id="ip-r" className="select" value={role} onChange={e => setRole(e.target.value)}>{CLIENT_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
        <Field label="Link expires after" htmlFor="ip-d"><select id="ip-d" className="select" value={days} onChange={e => setDays(Number(e.target.value))}>{[3, 7, 14, 30].map(d => <option key={d} value={d}>{d} days</option>)}</select></Field>
      </div>
    </Dialog>
  );
}

/* ─────────────── Permanent delete: dependency analysis + two-step confirm ─────────────── */
export function PermanentDeleteDialog({ open, onClose, company, onDeleted }: { open: boolean; onClose: () => void; company: { id: string; name: string }; onDeleted: () => void }) {
  const deps = useApi<any>(open ? `/api/v1/companies/${company.id}/dependencies` : null, [open]);
  const [step, setStep] = useState(1); const [typed, setTyped] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setStep(1); setTyped(''); setReason(''); } }, [open]);
  const d = deps.data;
  const del = async () => {
    setBusy(true);
    try { await api.del(`/api/v1/companies/${company.id}`, { confirm: typed, reason }); toast.success(`${company.name} was permanently deleted`); onClose(); onDeleted(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  let footer: ReactNode = <Button onClick={onClose}>Cancel</Button>;
  if (d && step === 1) footer = <><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={d.blocked} onClick={() => setStep(2)}>Continue</Button></>;
  if (d && step === 2) footer = <><Button onClick={() => setStep(1)}>Back</Button><Button variant="danger" loading={busy} disabled={typed !== company.name || reason.trim().length < 3} onClick={del}>Delete permanently</Button></>;
  return (
    <Dialog open={open} onClose={onClose} title={step === 1 ? `Delete ${company.name}?` : 'Confirm permanent delete'} footer={footer}>
      {deps.error ? <ErrorState error={deps.error} retry={deps.reload} /> : !d ? <LoadingBlock rows={3} /> : step === 1 ? (
        <div className="stack" style={{ gap: 12 }}>
          {d.blocked ? <Banner tone="danger">This record cannot be deleted because it has {d.financial ? 'financial or workforce history' : 'recruiting pipeline records'} that must be kept. {d.financial ? 'Deactivate the client instead.' : 'Remove those records first or deactivate instead.'}</Banner>
            : <Banner tone="warn">This cannot be undone. The following related records will be removed:</Banner>}
          {d.items.length === 0 ? <div className="muted">No related records.</div> : (
            <table className="crm-source-table"><thead><tr><th>Related records</th><th>Count</th><th>Effect</th></tr></thead>
              <tbody>{d.items.map((i: any) => <tr key={i.key}><td>{i.label}</td><td>{i.count}</td><td><span className={`pill pill-${i.effect === 'block' ? 'red' : i.effect === 'revoke' ? 'amber' : 'gray'}`}>{i.effect === 'block' ? 'Blocks delete' : i.effect === 'revoke' ? 'Access removed' : 'Deleted'}</span></td></tr>)}</tbody></table>
          )}
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <Field label={<>Type <b>{company.name}</b> to confirm</>} htmlFor="pd-n"><input id="pd-n" className="input" autoFocus value={typed} onChange={e => setTyped(e.target.value)} /></Field>
          <Field label="Reason *" htmlFor="pd-r" hint="Recorded in the audit log."><textarea id="pd-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}

/* ─────────────── Create position / invoice for a client (other areas' APIs) ─────────────── */
export function CreatePositionForm({ open, onClose, company }: { open: boolean; onClose: () => void; company: { id: string; name: string } }) {
  const nav = useNavigate();
  return (
    <FormDrawer open={open} onClose={onClose} title={`New position · ${company.name}`} submitLabel="Create draft position" initial={{ openings: 1, employment_type: 'full_time', urgency: 'normal' }}
      fields={[
        { name: 'title', label: 'Position title', required: true, full: true, placeholder: 'e.g. Dental Front Desk VA' },
        { name: 'openings', label: 'Openings', type: 'number', required: true },
        { name: 'employment_type', label: 'Employment type', type: 'select', options: opts(['full_time', 'part_time', 'contract', 'project']) },
        { name: 'urgency', label: 'Urgency', type: 'select', options: opts(['low', 'normal', 'high', 'critical']) },
      ]}
      onSubmit={async v => {
        const r = await api.post('/api/v1/positions', { title: v.title, company_id: company.id, openings: Number(v.openings) || 1, employment_type: v.employment_type || undefined, urgency: v.urgency || undefined, status: 'draft' });
        const id = r?.id ?? r?.position?.id;
        toast.success('Draft position created');
        if (id) nav(`/recruiting/positions/${id}`);
      }} />
  );
}
export function CreateInvoiceForm({ open, onClose, company }: { open: boolean; onClose: () => void; company: { id: string; name: string } }) {
  const nav = useNavigate();
  const end = todayISO(); const start = addDaysISO(end, -13);
  return (
    <FormDrawer open={open} onClose={onClose} title={`New invoice · ${company.name}`} submitLabel="Create draft invoice" initial={{ period_start: start, period_end: end }}
      fields={[
        { name: 'period_start', label: 'Period start', type: 'date', required: true }, { name: 'period_end', label: 'Period end', type: 'date', required: true },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ]}
      onSubmit={async v => {
        const r = await api.post('/api/v1/invoices', { company_id: company.id, period_start: v.period_start, period_end: v.period_end, notes: v.notes || null });
        const id = r?.invoice?.id ?? r?.id;
        toast.success(`Draft invoice ${r?.invoice?.number ?? ''} created from approved time`);
        if (id) nav(`/finance/invoices/${id}`);
      }}>
      {() => <div className="muted small mt-2">Lines are built from approved, not-yet-invoiced timesheet days for this client in the period.</div>}
    </FormDrawer>
  );
}
