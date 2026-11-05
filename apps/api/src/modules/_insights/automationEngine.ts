// Automation engine: WHEN (event | schedule) → IF (conditions) → DO (actions), with dedupe, approvals, dry runs and a run log.
import crypto from 'node:crypto';
import { q, one } from '../../core/db';
import { notify, usersWithRoles } from '../../core/notify';
import { activity } from '../../core/audit';
import { render } from '../../core/templates';
import { sendTemplate } from '../../adapters/messaging';
import { WEB_URL } from '../../core/settings';
import { canTransition } from '@veyro/shared';
import { LINK, todayIso, addDaysIso } from './common';

export type Vars = Record<string, any>;
export interface Condition { field: string; op: string; value: unknown }
export interface Action { type: string; [k: string]: any }
export interface Automation { id: string; organization_id: string; name: string; trigger_kind: 'event' | 'schedule'; trigger_event: string | null; schedule: string | null; conditions: Condition[]; actions: Action[]; requires_approval: boolean; enabled: boolean }

// ── Catalogues (used by the builder UI) ──
export const EVENT_TRIGGERS: { key: string; label: string; fields: string[] }[] = [
  { key: 'attendance.late', label: 'Worker is late', fields: ['minutes', 'worker.name', 'company.name'] },
  { key: 'attendance.absent', label: 'Worker is absent', fields: ['worker.name', 'company.name'] },
  { key: 'application.created', label: 'New application received', fields: ['candidate.name', 'position.title', 'source'] },
  { key: 'candidate.created', label: 'Candidate created', fields: ['candidate.name', 'source', 'candidate.country'] },
  { key: 'candidate.status_changed', label: 'Candidate status changed', fields: ['from', 'to', 'candidate.name'] },
  { key: 'position.created', label: 'Position created', fields: ['position.title', 'company.name'] },
  { key: 'lead.converted', label: 'Lead converted to client', fields: ['company.name'] },
  { key: 'opportunity.won', label: 'Opportunity won', fields: ['company.name', 'value_cents'] },
  { key: 'placement.created', label: 'Placement created', fields: ['worker.name', 'company.name'] },
  { key: 'placement.started', label: 'Placement started', fields: ['worker.name', 'company.name'] },
  { key: 'placement.ended', label: 'Placement ended', fields: ['worker.name', 'company.name', 'reason'] },
  { key: 'worker.terminated', label: 'Worker terminated', fields: ['worker.name'] },
  { key: 'timesheet.submitted', label: 'Timesheet submitted', fields: ['worker.name', 'company.name', 'total_minutes'] },
  { key: 'timesheet.approved', label: 'Timesheet approved', fields: ['worker.name', 'company.name', 'total_minutes'] },
  { key: 'invoice.sent', label: 'Invoice sent', fields: ['invoice.number', 'company.name', 'invoice.total_cents'] },
  { key: 'invoice.paid', label: 'Invoice paid', fields: ['invoice.number', 'company.name', 'invoice.total_cents'] },
  { key: 'invoice.overdue', label: 'Invoice became overdue', fields: ['invoice.number', 'company.name', 'invoice.balance_cents'] },
  { key: 'issue.created', label: 'Issue logged', fields: ['severity', 'kind', 'worker.name'] },
  { key: 'rate.changed', label: 'Rate changed', fields: ['worker.name', 'company.name'] },
  { key: 'document.uploaded', label: 'Document uploaded', fields: ['document.name', 'document.category', 'uploaded_by'] },
  { key: 'document.signed', label: 'Document signed', fields: ['document.name', 'signer.name'] },
  { key: 'message.received', label: 'Message from a client/worker/candidate', fields: ['thread.kind', 'author.name'] },
];
export const SCHEDULE_TRIGGERS: { key: string; label: string; fields: string[] }[] = [
  { key: 'application.stale', label: 'Application waiting for recruiter action', fields: ['hours_since', 'position.title', 'source'] },
  { key: 'document.expiring', label: 'Document expiring', fields: ['days_until_expiry', 'document.category', 'document.name'] },
  { key: 'invoice.overdue', label: 'Invoice overdue', fields: ['days_overdue', 'invoice.balance_cents', 'company.name'] },
  { key: 'placement.end_reached', label: 'Placement end date reached', fields: ['days_since_end', 'company.name'] },
  { key: 'task.overdue', label: 'Task overdue', fields: ['days_overdue', 'task.priority'] },
  { key: 'timesheet.unapproved', label: 'Timesheet waiting for approval', fields: ['hours_since', 'company.name'] },
];
export const ACTION_TYPES = ['notify', 'create_task', 'send_template', 'change_status', 'assign', 'webhook', 'start_offboarding'] as const;
export const RECIPIENTS = ['account_manager', 'attributed_recruiter', 'position_recruiters', 'worker', 'candidate', 'client_contact', 'owner_admins', 'role:hr', 'role:finance', 'role:account_manager', 'role:recruiter', 'role:sales', 'role:owner'];
export const STATUS_TARGETS: Record<string, string[]> = { placement: ['on_leave', 'notice', 'active', 'ended'], candidate: ['screening', 'recruiter_review', 'on_hold', 'future', 'talent_pool', 'rejected'], task: ['open', 'in_progress', 'done'], application: ['new', 'reviewed', 'advanced', 'rejected'] };

// ── Variables ──
const first = (n: string | null | undefined) => (n ?? '').split(' ')[0] ?? '';
const usd = (c: unknown, cur = 'USD') => (Number(c ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: cur || 'USD' });

/** Expands a trigger payload with names, emails and links looked up from the database (tenant-scoped). */
export async function enrich(orgId: string, payload: Record<string, any>): Promise<Vars> {
  const v: Vars = { ...payload };
  const org = await one<any>(`SELECT name, slug FROM organizations WHERE id=$1`, [orgId]);
  v.org = { name: org?.name, slug: org?.slug };
  v.today = todayIso();
  if (v.placement_id) {
    const p = await one<any>(`SELECT * FROM placements WHERE id=$1 AND organization_id=$2`, [v.placement_id, orgId]);
    if (p) {
      v.placement = { id: p.id, title: p.title, status: p.status, startDate: p.start_date, endDate: p.end_date };
      v.account_manager_id ??= p.account_manager_id; v.recruiter_id ??= p.recruiter_id; v.company_id ??= p.company_id; v.worker_id ??= p.worker_id;
    }
  }
  if (v.worker_id) {
    const w = await one<any>(`SELECT w.id, w.user_id, w.candidate_id, c.first_name, c.last_name, c.email, c.phone FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id=$1 AND w.organization_id=$2`, [v.worker_id, orgId]);
    if (w) { const nm = [w.first_name, w.last_name].filter(Boolean).join(' '); v.worker = { id: w.id, name: nm, firstName: w.first_name, email: w.email, phone: w.phone, user_id: w.user_id }; v.candidate_id ??= w.candidate_id; v.person ??= { name: nm, firstName: w.first_name, email: w.email }; }
  }
  if (v.application_id) {
    const a = await one<any>(`SELECT * FROM applications WHERE id=$1 AND organization_id=$2`, [v.application_id, orgId]);
    if (a) { v.application = { id: a.id, status: a.status, source: a.source, createdAt: a.created_at }; v.candidate_id ??= a.candidate_id; v.position_id ??= a.position_id; v.recruiter_id ??= a.recruiter_id; v.source ??= a.source; }
  }
  if (v.candidate_id) {
    const c = await one<any>(`SELECT id, first_name, last_name, email, phone, country, source, status, sourced_by, user_id FROM candidates WHERE id=$1 AND organization_id=$2`, [v.candidate_id, orgId]);
    if (c) { const nm = [c.first_name, c.last_name].filter(Boolean).join(' '); v.candidate = { id: c.id, name: nm, firstName: c.first_name, email: c.email, country: c.country, status: c.status, user_id: c.user_id }; v.recruiter_id ??= c.sourced_by; v.person ??= { name: nm, firstName: c.first_name, email: c.email }; }
  }
  if (v.position_id) {
    const p = await one<any>(`SELECT id, title, company_id, status FROM positions WHERE id=$1 AND organization_id=$2`, [v.position_id, orgId]);
    if (p) { v.position = { id: p.id, title: p.title, status: p.status }; v.company_id ??= p.company_id; }
  }
  if (v.invoice_id) {
    const i = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2`, [v.invoice_id, orgId]);
    if (i) { v.invoice = { id: i.id, number: i.number, total: usd(i.total_cents, i.currency), total_cents: Number(i.total_cents), balance: usd(Number(i.total_cents) - Number(i.paid_cents), i.currency), balance_cents: Number(i.total_cents) - Number(i.paid_cents), dueDate: i.due_date, status: i.status }; v.company_id ??= i.company_id; if (i.pay_token) v.link ??= `${WEB_URL}/pay/${i.pay_token}`; }
  }
  if (v.task_id) {
    const t = await one<any>(`SELECT id, title, priority, due_date, status FROM tasks WHERE id=$1 AND organization_id=$2`, [v.task_id, orgId]);
    if (t) v.task = { id: t.id, title: t.title, priority: t.priority, due: t.due_date, status: t.status };
  }
  if (v.timesheet_id) {
    const t = await one<any>(`SELECT id, week_start, total_minutes, status, placement_id, worker_id, company_id FROM timesheets WHERE id=$1 AND organization_id=$2`, [v.timesheet_id, orgId]);
    if (t) { v.timesheet = { id: t.id, weekStart: t.week_start, hours: (t.total_minutes / 60).toFixed(1), status: t.status }; v.total_minutes ??= t.total_minutes; }
  }
  if (v.document_id) {
    const d = await one<any>(`SELECT * FROM documents WHERE id=$1 AND organization_id=$2`, [v.document_id, orgId]);
    if (d) {
      v.document = { id: d.id, name: d.name, category: d.category, expiresAt: d.expires_at, visibility: d.visibility };
      if (d.entity_type === 'worker' && !v.worker) return enrich(orgId, { ...payload, worker_id: d.entity_id, document_id: undefined, __doc: v.document }).then(x => ({ ...x, document: v.document, document_id: d.id }));
      if (d.entity_type === 'candidate' && !v.candidate_id) return enrich(orgId, { ...payload, candidate_id: d.entity_id, document_id: undefined }).then(x => ({ ...x, document: v.document, document_id: d.id }));
      if (d.entity_type === 'company') v.company_id ??= d.entity_id;
      if (d.entity_type === 'placement' && !v.placement_id) return enrich(orgId, { ...payload, placement_id: d.entity_id, document_id: undefined }).then(x => ({ ...x, document: v.document, document_id: d.id }));
    }
  }
  if (v.company_id) {
    const co = await one<any>(`SELECT id, name, stage, payment_terms_days, account_manager_id, owner_id FROM companies WHERE id=$1 AND organization_id=$2`, [v.company_id, orgId]);
    if (co) {
      v.company = { id: co.id, name: co.name, stage: co.stage, terms: co.payment_terms_days };
      v.account_manager_id ??= co.account_manager_id;
      const ct = await one<any>(`SELECT first_name, last_name, email FROM contacts WHERE company_id=$1 AND organization_id=$2 AND archived_at IS NULL ORDER BY is_primary DESC, (email IS NULL), created_at LIMIT 1`, [co.id, orgId]);
      if (ct) v.contact = { firstName: ct.first_name, name: [ct.first_name, ct.last_name].filter(Boolean).join(' '), email: ct.email };
    }
  }
  if (v.account_manager_id) v.account_manager = { id: v.account_manager_id, name: (await one<any>(`SELECT name FROM users WHERE id=$1`, [v.account_manager_id]))?.name };
  if (v.recruiter_id) v.recruiter = { id: v.recruiter_id, name: (await one<any>(`SELECT name FROM users WHERE id=$1`, [v.recruiter_id]))?.name };
  if (typeof v.worker_name === 'string' && !v.worker) v.worker = { name: v.worker_name, firstName: first(v.worker_name) };
  if (typeof v.company_name === 'string' && !v.company) v.company = { name: v.company_name };
  return v;
}

/** Human label of what a run is about (shown in the run log instead of ids). */
export function subjectOf(v: Vars): string {
  return [v.invoice?.number, v.document?.name, v.task?.title, v.worker?.name ?? v.candidate?.name, v.company?.name, v.position?.title].filter(Boolean).slice(0, 3).join(' · ');
}

/** The record an automation run is about (task relation, timeline entries, default links). */
export function relatedOf(v: Vars): { type: string; id: string } | null {
  if (v.placement_id) return { type: 'placement', id: v.placement_id };
  if (v.invoice_id) return { type: 'invoice', id: v.invoice_id };
  if (v.timesheet_id) return { type: 'timesheet', id: v.timesheet_id };
  if (v.candidate_id) return { type: 'candidate', id: v.candidate_id };
  if (v.document_id) return { type: 'document', id: v.document_id };
  if (v.worker_id) return { type: 'worker', id: v.worker_id };
  if (v.task_id) return { type: 'task', id: v.task_id };
  if (v.company_id) return { type: 'company', id: v.company_id };
  return null;
}
function defaultLink(v: Vars): string | null {
  const r = relatedOf(v);
  if (!r) return null;
  if (r.type === 'company') return LINK.company(r.id, v.company?.stage);
  return (LINK as any)[r.type]?.(r.id) ?? null;
}

// ── Conditions ──
function getPath(v: Vars, path: string): unknown {
  let cur: any = v;
  for (const k of path.split('.')) cur = cur && typeof cur === 'object' ? cur[k] : undefined;
  return cur;
}
export function evalConditions(conds: Condition[], v: Vars): { ok: boolean; details: { field: string; op: string; value: unknown; actual: unknown; pass: boolean }[] } {
  const details = (conds ?? []).map(c => {
    const actual = getPath(v, c.field);
    const a = typeof actual === 'number' ? actual : Number(actual);
    const b = Number(c.value);
    const numeric = !Number.isNaN(a) && !Number.isNaN(b) && actual !== null && actual !== undefined && actual !== '';
    let pass = false;
    switch (c.op) {
      case '=': case 'eq': pass = numeric ? a === b : String(actual ?? '') === String(c.value ?? ''); break;
      case '!=': case 'neq': pass = numeric ? a !== b : String(actual ?? '') !== String(c.value ?? ''); break;
      case '>': pass = numeric && a > b; break;
      case '>=': pass = numeric && a >= b; break;
      case '<': pass = numeric && a < b; break;
      case '<=': pass = numeric && a <= b; break;
      case 'contains': pass = String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase()); break;
      case 'in': pass = String(c.value ?? '').split(',').map(s => s.trim().toLowerCase()).includes(String(actual ?? '').toLowerCase()); break;
      case 'exists': pass = actual !== null && actual !== undefined && actual !== ''; break;
      default: pass = false;
    }
    return { field: c.field, op: c.op, value: c.value, actual: actual ?? null, pass };
  });
  return { ok: details.every(d => d.pass), details };
}

// ── Recipients ──
export async function resolveUsers(orgId: string, key: string, v: Vars, opts: { fallback?: boolean } = {}): Promise<string[]> {
  const ids: (string | null | undefined)[] = [];
  if (key === 'account_manager') ids.push(v.account_manager_id);
  else if (key === 'attributed_recruiter') {
    ids.push(v.recruiter_id);
    if (!v.recruiter_id && v.position_id) ids.push(...(await q<any>(`SELECT user_id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL`, [v.position_id])).map(r => r.user_id));
  } else if (key === 'position_recruiters' && v.position_id) ids.push(...(await q<any>(`SELECT user_id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL`, [v.position_id])).map(r => r.user_id));
  else if (key === 'worker') ids.push(v.worker?.user_id);
  else if (key === 'candidate') ids.push(v.candidate?.user_id);
  else if (key === 'client_contact' && v.company_id) ids.push(...(await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.kind='client'`, [orgId, v.company_id])).map(r => r.user_id));
  else if (key === 'owner_admins') ids.push(...(await usersWithRoles(orgId, ['owner', 'admin'])));
  else if (key.startsWith('role:')) ids.push(...(await usersWithRoles(orgId, [key.slice(5)])));
  else if (key.startsWith('user:')) ids.push(key.slice(5));
  let clean = [...new Set(ids.filter(Boolean) as string[])];
  // A role nobody holds in this agency falls back to owners/admins so the work is never silently dropped.
  if (!clean.length && key.startsWith('role:') && opts.fallback !== false) clean = await usersWithRoles(orgId, ['owner', 'admin']);
  if (!clean.length) return [];
  // Only active members of this organization.
  return (await q<any>(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND status='active' AND user_id = ANY($2)`, [orgId, clean])).map(r => r.user_id);
}
export async function resolveEmails(orgId: string, key: string, v: Vars): Promise<string[]> {
  if (key.startsWith('email:')) return [key.slice(6)];
  if (key === 'worker') return [v.worker?.email].filter(Boolean);
  if (key === 'candidate') return [v.candidate?.email].filter(Boolean);
  if (key === 'client_contact') {
    if (v.contact?.email) return [v.contact.email];
    const ids = await resolveUsers(orgId, key, v);
    return ids.length ? (await q<any>(`SELECT email FROM users WHERE id = ANY($1)`, [ids])).map(r => r.email) : [];
  }
  const ids = await resolveUsers(orgId, key, v);
  return ids.length ? (await q<any>(`SELECT email FROM users WHERE id = ANY($1)`, [ids])).map(r => r.email) : [];
}
const RECIPIENT_LABEL: Record<string, string> = { account_manager: 'account manager', attributed_recruiter: 'attributed recruiter', position_recruiters: 'position recruiters', worker: 'worker', candidate: 'candidate', client_contact: 'client contact', owner_admins: 'owners & admins' };
export const recipientLabel = (k: string) => RECIPIENT_LABEL[k] ?? (k.startsWith('role:') ? `role: ${k.slice(5).replace('_', ' ')}` : k.startsWith('email:') ? k.slice(6) : k);

// ── Planning (dry run) and execution ──
export async function planActions(orgId: string, actions: Action[], v: Vars) {
  const out = [];
  for (const a of actions ?? []) {
    let summary = '';
    let recipients: string[] = [];
    if (a.type === 'notify' || a.type === 'create_task' || a.type === 'assign') {
      const key = a.to ?? a.assignee ?? 'account_manager';
      const ids = await resolveUsers(orgId, key, v);
      recipients = ids.length ? (await q<any>(`SELECT name FROM users WHERE id = ANY($1)`, [ids])).map(r => r.name) : [];
      if (a.type === 'notify') summary = `Notify ${recipients.join(', ') || `nobody (no ${recipientLabel(key)} found)`}: "${render(a.title ?? '', v)}"`;
      else if (a.type === 'create_task') summary = `Create ${a.priority ?? 'medium'} task "${render(a.title ?? '', v)}" for ${recipients.join(', ') || `nobody (no ${recipientLabel(key)} found)`}, due ${addDaysIso(todayIso(), Number(a.due_in_days ?? 1))}`;
      else summary = `Assign ${a.entity ?? 'record'} to ${recipients[0] ?? `nobody (no ${recipientLabel(key)} found)`}`;
    } else if (a.type === 'send_template') {
      recipients = await resolveEmails(orgId, a.to ?? 'worker', v);
      summary = `Send template "${a.template}" to ${recipients.join(', ') || `nobody (no ${recipientLabel(a.to ?? 'worker')} email)`}`;
    } else if (a.type === 'change_status') summary = `Change ${a.entity} status to ${String(a.status).replace(/_/g, ' ')}`;
    else if (a.type === 'webhook') summary = `POST payload to ${a.url}`;
    else if (a.type === 'start_offboarding') summary = v.placement_id ? `Start offboarding checklist for ${v.worker?.name ?? 'the placement'}` : 'Start offboarding (no placement in payload — will be skipped)';
    else summary = `Unknown action "${a.type}"`;
    out.push({ type: a.type, summary, recipients });
  }
  return out;
}

const OFFBOARDING_ITEMS = ['Final timesheet submitted & approved', 'Revoke client system access', 'Collect or wipe equipment', 'Exit interview completed', 'Final payroll processed', 'End seat & deactivate worker portal access'];

export async function executeActions(orgId: string, auto: Pick<Automation, 'id' | 'name' | 'trigger_event'>, actions: Action[], v: Vars) {
  const results: { type: string; ok: boolean; detail: string }[] = [];
  const related = relatedOf(v);
  const sys = { orgId, userId: null as string | null };
  for (const a of actions ?? []) {
    try {
      if (a.type === 'notify') {
        const ids = await resolveUsers(orgId, a.to ?? 'account_manager', v);
        const sent = await notify(orgId, ids, { event: auto.trigger_event ?? 'automation', title: render(a.title ?? auto.name, v), body: a.body ? render(a.body, v) : `Automation: ${auto.name}`, link: a.link ? render(a.link, v) : defaultLink(v) });
        if (!ids.length) throw new Error(`No ${recipientLabel(a.to ?? 'account_manager')} to notify`);
        results.push({ type: a.type, ok: true, detail: `Notified ${ids.length} user${ids.length === 1 ? '' : 's'} (${sent.length} in-app)` });
      } else if (a.type === 'create_task') {
        const ids = await resolveUsers(orgId, a.assignee ?? 'account_manager', v);
        if (!ids.length) throw new Error(`No ${recipientLabel(a.assignee ?? 'account_manager')} to assign the task to`);
        const t = await one<any>(`INSERT INTO tasks (organization_id, title, description, priority, due_date, related_type, related_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING id, title`,
          [orgId, render(a.title ?? auto.name, v).slice(0, 200), a.description ? render(a.description, v) : `Created by automation "${auto.name}".`, ['low', 'medium', 'high', 'urgent'].includes(a.priority) ? a.priority : 'medium', addDaysIso(todayIso(), Number(a.due_in_days ?? 1)), related?.type ?? null, related?.id ?? null]);
        for (const u of ids) await q(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, u]);
        await activity(sys, 'task', t.id, 'system', 'Task created by automation', auto.name);
        await notify(orgId, ids, { event: 'task.assigned', title: `New task: ${t.title}`, body: `Assigned by automation "${auto.name}"`, link: `/my-tasks?task=${t.id}` });
        results.push({ type: a.type, ok: true, detail: `Task "${t.title}" created` });
      } else if (a.type === 'send_template') {
        const emails = await resolveEmails(orgId, a.to ?? 'worker', v);
        if (!emails.length) throw new Error(`No email address for ${recipientLabel(a.to ?? 'worker')}`);
        const tpl = await one<any>(`SELECT 1 FROM templates WHERE organization_id=$1 AND key=$2 AND archived_at IS NULL`, [orgId, a.template]);
        if (!tpl) throw new Error(`Template "${a.template}" not found or archived`);
        for (const e of emails) await sendTemplate(orgId, a.template, e, { ...v, link: v.link ?? (defaultLink(v) ? WEB_URL + defaultLink(v) : '') }, { related: related ?? undefined, channel: a.channel });
        results.push({ type: a.type, ok: true, detail: `Sent "${a.template}" to ${emails.join(', ')}` });
      } else if (a.type === 'change_status') {
        const ent = String(a.entity);
        const id = v[`${ent}_id`];
        if (!id || !STATUS_TARGETS[ent]) throw new Error(`No ${ent} in the trigger payload`);
        const table = ent === 'placement' ? 'placements' : ent === 'candidate' ? 'candidates' : ent === 'task' ? 'tasks' : 'applications';
        const row = await one<any>(`SELECT status FROM ${table} WHERE id=$1 AND organization_id=$2`, [id, orgId]);
        if (!row) throw new Error(`${ent} not found`);
        if (row.status === a.status) { results.push({ type: a.type, ok: true, detail: `Already ${a.status}` }); continue; }
        if ((ent === 'placement' || ent === 'candidate') && !canTransition(ent, row.status, a.status)) throw new Error(`Cannot move ${ent} from ${row.status} to ${a.status}`);
        if (!STATUS_TARGETS[ent].includes(a.status)) throw new Error(`Status ${a.status} is not allowed for ${ent}`);
        await q(`UPDATE ${table} SET status=$3${['placements', 'candidates', 'tasks'].includes(table) ? ', updated_at=now()' : ''} WHERE id=$1 AND organization_id=$2`, [id, orgId, a.status]);
        if (ent !== 'application') await activity(sys, ent, id, 'status_change', `Status changed to ${String(a.status).replace(/_/g, ' ')} by automation`, auto.name, { from: row.status, to: a.status });
        results.push({ type: a.type, ok: true, detail: `${ent} ${row.status} → ${a.status}` });
      } else if (a.type === 'assign') {
        const ids = await resolveUsers(orgId, a.to ?? 'account_manager', v);
        if (!ids.length) throw new Error(`No ${recipientLabel(a.to ?? 'account_manager')} to assign`);
        const ent = String(a.entity ?? 'task');
        if (ent === 'application' && v.application_id) await q(`UPDATE applications SET recruiter_id=$3 WHERE id=$1 AND organization_id=$2`, [v.application_id, orgId, ids[0]]);
        else if (ent === 'company' && v.company_id) await q(`UPDATE companies SET owner_id=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`, [v.company_id, orgId, ids[0]]);
        else if (ent === 'placement' && v.placement_id) await q(`UPDATE placements SET account_manager_id=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`, [v.placement_id, orgId, ids[0]]);
        else if (ent === 'task' && v.task_id) await q(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [v.task_id, ids[0]]);
        else throw new Error(`No ${ent} in the trigger payload to assign`);
        await notify(orgId, [ids[0]], { event: 'assigned', title: `You were assigned a ${ent}`, body: `By automation "${auto.name}"`, link: defaultLink(v) });
        results.push({ type: a.type, ok: true, detail: `${ent} assigned` });
      } else if (a.type === 'webhook') {
        const url = String(a.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw new Error('Webhook URL must start with http:// or https://');
        const body = JSON.stringify({ automation: { id: auto.id, name: auto.name }, event: auto.trigger_event, data: v, sent_at: new Date().toISOString() });
        const ep = await one<any>(`SELECT secret FROM webhook_endpoints WHERE organization_id=$1 AND url=$2 LIMIT 1`, [orgId, url]);
        const headers: Record<string, string> = { 'content-type': 'application/json', 'x-veyro-event': `automation.${auto.trigger_event ?? 'run'}`, 'x-veyro-delivery': crypto.randomUUID() };
        if (ep) headers['x-veyro-signature'] = crypto.createHmac('sha256', ep.secret).update(body).digest('hex');
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
        results.push({ type: a.type, ok: true, detail: `POST ${url} → ${res.status}` });
      } else if (a.type === 'start_offboarding') {
        if (!v.placement_id) throw new Error('No placement in the trigger payload');
        const p = await one<any>(`SELECT id, status FROM placements WHERE id=$1 AND organization_id=$2`, [v.placement_id, orgId]);
        if (!p) throw new Error('Placement not found');
        const existing = await one<any>(`SELECT count(*)::int n FROM placement_onboarding_items WHERE placement_id=$1 AND source='offboarding'`, [p.id]);
        let added = 0;
        if (!existing.n) {
          for (const [i, title] of OFFBOARDING_ITEMS.entries()) { await q(`INSERT INTO placement_onboarding_items (organization_id, placement_id, title, source, required, owner, sort) VALUES ($1,$2,$3,'offboarding',true,'agency',$4)`, [orgId, p.id, title, 900 + i]); added++; }
        }
        if (['active', 'on_leave'].includes(p.status) && canTransition('placement', p.status, 'notice')) {
          await q(`UPDATE placements SET status='notice', updated_at=now() WHERE id=$1`, [p.id]);
          await activity(sys, 'placement', p.id, 'status_change', 'Offboarding started — placement moved to notice', `End date reached. Automation: ${auto.name}`, { from: p.status, to: 'notice' });
        } else await activity(sys, 'placement', p.id, 'system', 'Offboarding checklist started', `Automation: ${auto.name}`);
        results.push({ type: a.type, ok: true, detail: added ? `${added} offboarding items added` : 'Offboarding checklist already exists' });
      } else throw new Error(`Unknown action "${a.type}"`);
    } catch (e: any) {
      results.push({ type: a.type, ok: false, detail: String(e?.message ?? e) });
    }
  }
  return results;
}

// ── Running ──
export const hashKey = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);

/** Processes one trigger occurrence for one automation. Returns the run row (or null when deduped). */
export async function processTrigger(auto: Automation, payload: Record<string, any>, opts: { dedupeKey: string | null; recordSkips?: boolean; manualBy?: string | null }) {
  const orgId = auto.organization_id;
  const v = await enrich(orgId, payload);
  const subject = subjectOf(v);
  const cond = evalConditions(auto.conditions, v);
  if (!cond.ok) {
    if (opts.recordSkips) return one<any>(`INSERT INTO automation_runs (organization_id, automation_id, status, trigger_payload, result, dedupe_key) VALUES ($1,$2,'skipped',$3,$4,$5) ON CONFLICT (automation_id, dedupe_key) DO NOTHING RETURNING *`, [orgId, auto.id, JSON.stringify(payload), JSON.stringify({ subject, conditions: cond.details, reason: 'Conditions not met' }), opts.dedupeKey]);
    return null;
  }
  if (auto.requires_approval) {
    const plan = await planActions(orgId, auto.actions, v);
    const r = await one<any>(`INSERT INTO automation_runs (organization_id, automation_id, status, trigger_payload, result, dedupe_key) VALUES ($1,$2,'pending_approval',$3,$4,$5) ON CONFLICT (automation_id, dedupe_key) DO NOTHING RETURNING *`, [orgId, auto.id, JSON.stringify(payload), JSON.stringify({ subject, conditions: cond.details, planned: plan }), opts.dedupeKey]);
    if (r) {
      const approvers = (await q<any>(`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN role_permissions rp ON rp.role_id=m.role_id AND rp.resource='automation' AND rp.action='approve' AND rp.scope <> 'none' WHERE m.organization_id=$1 AND m.status='active'`, [orgId])).map(x => x.user_id);
      await notify(orgId, approvers, { event: 'automation.approval', title: `Approval needed: ${auto.name}`, body: plan.map(p => p.summary).join(' · ').slice(0, 300), link: `/automation/runs?status=pending_approval&run=${r.id}` });
      await q(`UPDATE automations SET last_run_at=now() WHERE id=$1`, [auto.id]);
    }
    return r;
  }
  // Claim the dedupe slot first so concurrent ticks never double-execute.
  const claimed = await one<any>(`INSERT INTO automation_runs (organization_id, automation_id, status, trigger_payload, result, dedupe_key) VALUES ($1,$2,'running',$3,'{}',$4) ON CONFLICT (automation_id, dedupe_key) DO NOTHING RETURNING id`, [orgId, auto.id, JSON.stringify(payload), opts.dedupeKey]);
  if (!claimed) return null;
  const results = await executeActions(orgId, auto, auto.actions, v);
  const ok = results.every(r => r.ok);
  await q(`UPDATE automations SET last_run_at=now() WHERE id=$1`, [auto.id]);
  return one<any>(`UPDATE automation_runs SET status=$2, result=$3, approved_by=$4 WHERE id=$1 RETURNING *`, [claimed.id, ok ? 'succeeded' : 'failed', JSON.stringify({ subject, conditions: cond.details, actions: results, ...(ok ? {} : { error: results.filter(r => !r.ok).map(r => r.detail).join('; ') }), ...(opts.manualBy ? { manual: true } : {}) }), opts.manualBy ?? null]);
}

/** Finds the records a schedule trigger applies to right now. */
export async function scanSchedule(orgId: string, trigger: string, limit = 200): Promise<{ dedupe: string; payload: Record<string, any> }[]> {
  if (trigger === 'application.stale') {
    const rows = await q<any>(`SELECT a.id, a.candidate_id, a.position_id, a.recruiter_id, a.source, floor(EXTRACT(EPOCH FROM now() - a.created_at)/3600)::int hours_since FROM applications a WHERE a.organization_id=$1 AND a.status='new' AND a.reviewed_at IS NULL ORDER BY a.created_at LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `app-stale:${r.id}`, payload: { application_id: r.id, candidate_id: r.candidate_id, position_id: r.position_id, recruiter_id: r.recruiter_id, source: r.source, hours_since: r.hours_since } }));
  }
  if (trigger === 'document.expiring') {
    const rows = await q<any>(`SELECT d.id, d.expires_at::text exp, (d.expires_at - current_date)::int days FROM documents d WHERE d.organization_id=$1 AND d.archived_at IS NULL AND d.expires_at IS NOT NULL AND d.expires_at >= current_date AND d.expires_at <= current_date + 90 AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL) ORDER BY d.expires_at LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `doc-exp:${r.id}:${r.exp}`, payload: { document_id: r.id, days_until_expiry: r.days } }));
  }
  if (trigger === 'invoice.overdue') {
    const rows = await q<any>(`SELECT i.id, i.company_id, (current_date - i.due_date)::int days FROM invoices i WHERE i.organization_id=$1 AND i.status IN ('sent','viewed','partially_paid','overdue') AND i.due_date < current_date ORDER BY i.due_date LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `inv-overdue:${r.id}`, payload: { invoice_id: r.id, company_id: r.company_id, days_overdue: r.days } }));
  }
  if (trigger === 'placement.end_reached') {
    const rows = await q<any>(`SELECT p.id, p.worker_id, p.company_id, p.account_manager_id, (current_date - p.end_date)::int days FROM placements p WHERE p.organization_id=$1 AND p.status IN ('active','on_leave','notice') AND p.end_date IS NOT NULL AND p.end_date <= current_date ORDER BY p.end_date LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `pl-end:${r.id}`, payload: { placement_id: r.id, worker_id: r.worker_id, company_id: r.company_id, account_manager_id: r.account_manager_id, days_since_end: r.days } }));
  }
  if (trigger === 'task.overdue') {
    const rows = await q<any>(`SELECT t.id, t.due_date::text due, (current_date - t.due_date)::int days FROM tasks t WHERE t.organization_id=$1 AND t.status IN ('open','in_progress') AND t.due_date < current_date AND t.archived_at IS NULL ORDER BY t.due_date LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `task-overdue:${r.id}:${r.due}`, payload: { task_id: r.id, days_overdue: r.days } }));
  }
  if (trigger === 'timesheet.unapproved') {
    const rows = await q<any>(`SELECT t.id, t.placement_id, floor(EXTRACT(EPOCH FROM now() - t.submitted_at)/3600)::int hours FROM timesheets t WHERE t.organization_id=$1 AND t.status='submitted' AND t.submitted_at IS NOT NULL ORDER BY t.submitted_at LIMIT $2`, [orgId, limit]);
    return rows.map(r => ({ dedupe: `ts-unapproved:${r.id}`, payload: { timesheet_id: r.id, placement_id: r.placement_id, hours_since: r.hours } }));
  }
  return [];
}

/** Most recent real record for a trigger — used for test runs and "fire sample event". */
export async function samplePayload(orgId: string, trigger: string): Promise<Record<string, any>> {
  const sched = await scanSchedule(orgId, trigger, 1);
  if (sched.length) return sched[0].payload;
  const pick = async (sql: string) => (await one<any>(sql, [orgId])) ?? {};
  switch (trigger) {
    case 'attendance.late': case 'attendance.absent': {
      const r = await pick(`SELECT a.worker_id, a.placement_id, a.minutes, a.work_date::text work_date FROM attendance_events a WHERE a.organization_id=$1 AND a.kind='${trigger === 'attendance.late' ? 'late' : 'absent'}' ORDER BY a.work_date DESC, a.created_at DESC LIMIT 1`);
      return { ...r, minutes: r.minutes ?? 20 };
    }
    case 'application.created': case 'candidate.created': case 'candidate.status_changed': return pick(`SELECT id application_id, candidate_id, position_id, recruiter_id, source FROM applications WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`);
    case 'position.created': return pick(`SELECT id position_id, company_id FROM positions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`);
    case 'lead.converted': case 'opportunity.won': return pick(`SELECT id company_id FROM companies WHERE organization_id=$1 AND stage='client' ORDER BY converted_at DESC NULLS LAST LIMIT 1`);
    case 'placement.created': case 'placement.started': case 'rate.changed': return pick(`SELECT id placement_id FROM placements WHERE organization_id=$1 AND status='active' ORDER BY start_date DESC LIMIT 1`);
    case 'placement.ended': case 'worker.terminated': return pick(`SELECT id placement_id FROM placements WHERE organization_id=$1 ORDER BY (status='ended') DESC, updated_at DESC LIMIT 1`);
    case 'timesheet.submitted': case 'timesheet.approved': return pick(`SELECT id timesheet_id, placement_id, total_minutes FROM timesheets WHERE organization_id=$1 ORDER BY (status='${trigger === 'timesheet.submitted' ? 'submitted' : 'approved'}') DESC, week_start DESC LIMIT 1`);
    case 'invoice.sent': case 'invoice.paid': case 'invoice.overdue': return pick(`SELECT id invoice_id, company_id FROM invoices WHERE organization_id=$1 ORDER BY (status='${trigger.split('.')[1]}') DESC, issue_date DESC LIMIT 1`);
    case 'issue.created': return pick(`SELECT id issue_id, placement_id, worker_id, severity, kind FROM issues WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`);
    case 'document.uploaded': case 'document.signed': return pick(`SELECT id document_id FROM documents WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`);
    default: return {};
  }
}

const SCHEDULE_INTERVAL: Record<string, number> = { every_5m: 5 * 60_000, hourly: 3600_000, daily: 86400_000 };
export const scheduleMs = (s: string | null) => SCHEDULE_INTERVAL[s ?? 'hourly'] ?? 3600_000;

/** Evaluates one schedule automation now. Executes at most `cap` new items per pass (the rest next pass). */
export async function runSchedule(auto: Automation, cap = 25, manualBy: string | null = null) {
  const items = await scanSchedule(auto.organization_id, auto.trigger_event ?? '', 500);
  let executed = 0, matched = 0;
  const runs: any[] = [];
  for (const it of items) {
    if (executed >= cap) break;
    const done = await one<any>(`SELECT 1 FROM automation_runs WHERE automation_id=$1 AND dedupe_key=$2`, [auto.id, it.dedupe]);
    if (done) continue;
    const r = await processTrigger(auto, it.payload, { dedupeKey: it.dedupe, manualBy });
    if (r) { executed++; runs.push(r); }
    if (r) matched++;
  }
  await q(`UPDATE automations SET last_run_at=now() WHERE id=$1`, [auto.id]);
  return { scanned: items.length, executed, matched, runs };
}
