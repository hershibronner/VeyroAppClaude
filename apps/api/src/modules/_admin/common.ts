// Shared helpers for the ADMIN + PLATFORM area.
import type { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Ctx } from '../../core/context';
import { q, type Db, pool } from '../../core/db';
import { notFound } from '../../core/errors';

/** Requires a VeyroApp platform admin acting as themselves (never while impersonating). */
export function platform(req: FastifyRequest): Ctx {
  const ctx = req.ctx;
  if (!ctx || !ctx.isPlatformAdmin || ctx.impersonatorId) throw notFound();
  return ctx;
}

/** Audit context for platform actions that concern a specific tenant (audit row lands in that tenant's log). */
export function auditAs(ctx: Ctx, orgId: string | null) {
  return { orgId: orgId ?? '', userId: ctx.userId, user: ctx.user, impersonatorId: ctx.impersonatorId, ip: ctx.ip };
}

/** In-app notifications for platform admins (organization_id NULL; shown in the Platform Control Center). */
export async function notifyPlatform(title: string, body: string | null, link: string | null, event = 'platform', db: Db = pool) {
  const admins = await q<any>(`SELECT user_id FROM platform_admins WHERE status='active' AND (expires_at IS NULL OR expires_at > now())`, [], db);
  for (const a of admins) await q(`INSERT INTO notifications (organization_id, user_id, event, title, body, link) VALUES (NULL,$1,$2,$3,$4,$5)`, [a.user_id, event, title, body, link], db);
  return admins.length;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

/** Catalog of domain events (webhooks, admin subscriptions, notifications settings). */
export const EVENT_CATALOG: { key: string; label: string; group: string }[] = [
  { key: 'lead.created', label: 'Lead created', group: 'CRM' },
  { key: 'lead.converted', label: 'Lead converted to client', group: 'CRM' },
  { key: 'opportunity.won', label: 'Opportunity won', group: 'CRM' },
  { key: 'position.created', label: 'Position created', group: 'Recruiting' },
  { key: 'position.requested', label: 'Client requested a worker', group: 'Recruiting' },
  { key: 'candidate.created', label: 'Candidate created', group: 'Recruiting' },
  { key: 'application.created', label: 'New public application', group: 'Recruiting' },
  { key: 'submission.created', label: 'Candidate submitted to client', group: 'Recruiting' },
  { key: 'interview.scheduled', label: 'Interview scheduled', group: 'Recruiting' },
  { key: 'offer.accepted', label: 'Offer accepted', group: 'Recruiting' },
  { key: 'placement.created', label: 'Placement created', group: 'Workforce' },
  { key: 'placement.started', label: 'Placement started (seat started)', group: 'Workforce' },
  { key: 'placement.ended', label: 'Placement ended', group: 'Workforce' },
  { key: 'worker.terminated', label: 'Worker terminated', group: 'Workforce' },
  { key: 'activation.override', label: 'Activation override', group: 'Workforce' },
  { key: 'attendance.late', label: 'Worker late', group: 'Time' },
  { key: 'attendance.absent', label: 'Worker absent', group: 'Time' },
  { key: 'timesheet.submitted', label: 'Timesheet submitted', group: 'Time' },
  { key: 'timesheet.approved', label: 'Timesheet approved', group: 'Time' },
  { key: 'timesheet.rejected', label: 'Timesheet rejected', group: 'Time' },
  { key: 'invoice.sent', label: 'Invoice sent', group: 'Finance' },
  { key: 'invoice.paid', label: 'Invoice paid', group: 'Finance' },
  { key: 'invoice.overdue', label: 'Invoice overdue', group: 'Finance' },
  { key: 'payroll.approved', label: 'Payroll approved', group: 'Finance' },
  { key: 'payout.failed', label: 'Payout failed', group: 'Finance' },
  { key: 'rate.created', label: 'Rate change', group: 'Finance' },
  { key: 'document.signed', label: 'Document signed', group: 'Documents' },
  { key: 'document.expiring', label: 'Document expiring', group: 'Documents' },
  { key: 'integration.error', label: 'Integration error', group: 'Admin' },
  { key: 'import.completed', label: 'Import completed', group: 'Admin' },
  { key: 'role.changed', label: 'Role or permission change', group: 'Admin' },
  { key: 'export.created', label: 'Sensitive export', group: 'Admin' },
];

/** Number formatting for SaaS invoice numbers etc. */
export const pad = (n: number, w = 3) => String(n).padStart(w, '0');
export function monthBounds(ym: string): { start: string; end: string; days: number } {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${pad(days, 2)}`, days };
}

/** Field-level validation error in the same shape as zod errors ({ error, fields }) so forms highlight inputs. */
import { ZodError } from 'zod';
export function fieldError(fields: Record<string, string>) {
  return new ZodError(Object.entries(fields).map(([k, message]) => ({ code: 'custom' as const, path: [k], message })));
}
