// INSIGHTS: role-aware Home dashboard, Needs Attention, My Tasks and recent activity.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../core/db';
import { staff, can, scopeOf, type Ctx } from '../core/context';
import { notFound } from '../core/errors';
import { activity } from '../core/audit';
import { listParams, paged } from '../core/list';
import { getSetting } from '../core/settings';
import {
  todayIso, addDaysIso, monthStartIso, addMonthsIso, mondayOf, daysBetween, pctDelta, lastMonths, num,
  APPROVED_DAYS, REV_SQL, COST_SQL, ENTRY_MIN, REVENUE_STATUSES, OPEN_AR_STATUSES, PIPELINE_STATUSES, LINK, linkFor, visibleEntityTypes, entityLabelSql,
} from './_insights/common';

type Focus = 'recruiting' | 'sales' | 'money' | 'workforce';
function focusOf(ctx: Ctx): Set<Focus> {
  const k = ctx.role.key;
  if (['owner', 'admin', 'management'].includes(k)) return new Set(['recruiting', 'sales', 'money', 'workforce']);
  if (k === 'recruiter') return new Set(['recruiting']);
  if (k === 'sales') return new Set(['sales']);
  if (k === 'finance') return new Set(['money']);
  if (k === 'account_manager' || k === 'hr') return new Set(['workforce']);
  // Custom / support / viewer roles: whatever they are allowed to see.
  const f = new Set<Focus>();
  if (can(ctx, 'candidates', 'view') || can(ctx, 'positions', 'view')) f.add('recruiting');
  if (can(ctx, 'leads', 'view') || can(ctx, 'clients', 'view')) f.add('sales');
  if (can(ctx, 'invoices', 'view')) f.add('money');
  if (can(ctx, 'workers', 'view')) f.add('workforce');
  return f;
}
const isLeader = (ctx: Ctx) => ['owner', 'admin', 'management'].includes(ctx.role.key);

/** SQL predicate restricting positions to the recruiter's scope. */
function positionScope(ctx: Ctx, alias: string, params: unknown[]): string {
  const s = scopeOf(ctx, 'positions', 'view');
  if (s === 'all') return 'TRUE';
  params.push(ctx.userId);
  return `EXISTS (SELECT 1 FROM position_recruiter_assignments pra WHERE pra.position_id=${alias}.id AND pra.user_id=$${params.length} AND pra.unassigned_at IS NULL)`;
}

export interface Kpi { key: string; label: string; value: number; prev: number | null; delta: number | null; format: 'num' | 'money' | 'pct' | 'hours'; to: string; deltaLabel: string; invert?: boolean; hint?: string }

async function revenueBetween(orgId: string, from: string, to: string) {
  return num((await one<any>(`SELECT COALESCE(sum(total_cents),0)::bigint v FROM invoices WHERE organization_id=$1 AND status IN ${REVENUE_STATUSES} AND issue_date BETWEEN $2::date AND $3::date`, [orgId, from, to]))?.v);
}
async function payrollBetween(orgId: string, from: string, to: string) {
  return num((await one<any>(`SELECT COALESCE(sum(pi.gross_cents),0)::bigint v FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE pi.organization_id=$1 AND r.pay_date BETWEEN $2::date AND $3::date`, [orgId, from, to]))?.v);
}
export async function marginBetween(orgId: string, from: string, to: string) {
  const r = await one<any>(`SELECT ${REV_SQL} rev, ${COST_SQL} cost FROM ${APPROVED_DAYS} WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date`, [orgId, from, to]);
  const rev = num(r?.rev), cost = num(r?.cost);
  return { rev, cost, pct: rev ? Math.round(((rev - cost) / rev) * 1000) / 10 : null };
}
async function minutesBetween(orgId: string, from: string, to: string) {
  return Math.round(num((await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN}),0) v FROM time_entries te WHERE te.organization_id=$1 AND te.work_date BETWEEN $2::date AND $3::date`, [orgId, from, to]))?.v));
}

async function buildKpis(ctx: Ctx, focus: Set<Focus>): Promise<Kpi[]> {
  const org = ctx.orgId;
  const today = todayIso();
  const ms = monthStartIso(today);
  const elapsed = daysBetween(ms, today);
  const pms = addMonthsIso(ms, -1);
  const pmTo = addDaysIso(pms, Math.min(elapsed, daysBetween(pms, addDaysIso(ms, -1))));
  const mon = mondayOf(today);
  const pmon = addDaysIso(mon, -7);
  const out: Kpi[] = [];
  const add = (k: Omit<Kpi, 'delta'>) => out.push({ ...k, delta: k.prev === null ? null : pctDelta(k.value, k.prev) });
  const leader = isLeader(ctx);

  if (can(ctx, 'clients', 'view') && (leader || focus.has('sales') || focus.has('workforce') || focus.has('money'))) {
    const r = await one<any>(`SELECT count(*) FILTER (WHERE stage='client')::int cur,
      count(*) FILTER (WHERE (stage='client' OR stage='inactive') AND COALESCE(converted_at, created_at) < $2::date)::int prev FROM companies WHERE organization_id=$1 AND archived_at IS NULL`, [org, ms]);
    add({ key: 'active_clients', label: 'Active Clients', value: r.cur, prev: r.prev, format: 'num', to: '/crm/clients?stage=client', deltaLabel: 'vs start of month' });
  }
  if (can(ctx, 'workers', 'view') && (leader || focus.has('workforce'))) {
    const r = await one<any>(`SELECT (SELECT count(*) FROM workers WHERE organization_id=$1 AND status='active')::int cur,
      (SELECT count(DISTINCT worker_id) FROM placements WHERE organization_id=$1 AND activated_at IS NOT NULL AND start_date < $2::date AND (ended_at IS NULL OR ended_at >= $2::date))::int prev`, [org, ms]);
    add({ key: 'active_workers', label: 'Active Workers', value: r.cur, prev: r.prev, format: 'num', to: '/workforce/active', deltaLabel: 'vs start of month' });
  }
  if (can(ctx, 'positions', 'view') && (leader || focus.has('recruiting') || focus.has('sales'))) {
    const params: unknown[] = [org, ms, pms];
    const sc = positionScope(ctx, 'p', params);
    const r = await one<any>(`SELECT count(*) FILTER (WHERE status='open')::int cur,
      count(*) FILTER (WHERE created_at >= $2::date)::int new_m, count(*) FILTER (WHERE created_at >= $3::date AND created_at < $2::date)::int new_pm
      FROM positions p WHERE organization_id=$1 AND archived_at IS NULL AND ${sc}`, params);
    out.push({ key: 'open_positions', label: 'Open Positions', value: r.cur, prev: r.new_pm, delta: null, format: 'num', to: '/recruiting/positions?status=open', deltaLabel: `${r.new_m} new this month` });
  }
  if (can(ctx, 'candidates', 'view') && (leader || focus.has('recruiting'))) {
    const r = await one<any>(`SELECT count(*) FILTER (WHERE status = ANY($2))::int cur,
      count(*) FILTER (WHERE created_at >= $3::date)::int new_m, count(*) FILTER (WHERE created_at >= $4::date AND created_at < $3::date)::int new_pm
      FROM candidates WHERE organization_id=$1 AND archived_at IS NULL`, [org, PIPELINE_STATUSES, ms, pms]);
    out.push({ key: 'pipeline', label: 'Candidates in Pipeline', value: r.cur, prev: null, delta: pctDelta(r.new_m, r.new_pm), format: 'num', to: '/recruiting/candidates', deltaLabel: 'new candidates vs last month' });
  }
  if ((can(ctx, 'time', 'view') || can(ctx, 'timesheets', 'view')) && (leader || focus.has('workforce'))) {
    const cur = await minutesBetween(org, mon, today);
    const prev = await minutesBetween(org, pmon, addDaysIso(pmon, daysBetween(mon, today)));
    add({ key: 'hours_week', label: 'Hours This Week', value: cur, prev, format: 'hours', to: `/time/timesheets?from=${mon}&to=${today}`, deltaLabel: 'vs same point last week' });
  }
  if (can(ctx, 'invoices', 'view') && (leader || focus.has('money'))) {
    add({ key: 'revenue_mtd', label: 'Revenue MTD', value: await revenueBetween(org, ms, today), prev: await revenueBetween(org, pms, pmTo), format: 'money', to: `/finance/invoices?from=${ms}&to=${today}`, deltaLabel: 'vs last month to date' });
  }
  if (can(ctx, 'payroll', 'view') && (leader || focus.has('money'))) {
    add({ key: 'payroll_mtd', label: 'Payroll MTD', value: await payrollBetween(org, ms, today), prev: await payrollBetween(org, pms, pmTo), format: 'money', to: `/finance/payroll?from=${ms}&to=${today}`, deltaLabel: 'vs last month to date', invert: true });
  }
  if ((can(ctx, 'margin', 'view') || can(ctx, 'invoices', 'view')) && (leader || focus.has('money'))) {
    const cur = await marginBetween(org, ms, today);
    const prev = await marginBetween(org, pms, pmTo);
    out.push({ key: 'margin_pct', label: 'Gross Margin %', value: cur.pct ?? 0, prev: prev.pct, delta: cur.pct !== null && prev.pct !== null ? Math.round((cur.pct - prev.pct) * 10) / 10 : null, format: 'pct', to: `/finance/margin?from=${ms}&to=${today}`, deltaLabel: 'pts vs last month to date', hint: 'From approved timesheet hours × effective bill and pay rates' });
  }
  // Focus-specific extras so non-owner roles still get a full KPI row.
  if (!leader) {
    if (focus.has('recruiting') && can(ctx, 'candidates', 'view')) {
      const r = await one<any>(`SELECT count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int cur, count(*) FILTER (WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days')::int prev FROM applications WHERE organization_id=$1 ${ctx.role.key === 'recruiter' ? 'AND (recruiter_id=$2 OR position_id IN (SELECT position_id FROM position_recruiter_assignments WHERE user_id=$2 AND unassigned_at IS NULL))' : ''}`, ctx.role.key === 'recruiter' ? [org, ctx.userId] : [org]);
      add({ key: 'applications_7d', label: 'New Applications (7d)', value: r.cur, prev: r.prev, format: 'num', to: '/recruiting/applications?status=new', deltaLabel: 'vs previous 7 days' });
      if (can(ctx, 'interviews', 'view')) {
        const iv = await one<any>(`SELECT count(*) FILTER (WHERE scheduled_at::date BETWEEN $2::date AND $3::date)::int cur, count(*) FILTER (WHERE scheduled_at::date BETWEEN $4::date AND $5::date)::int prev FROM interviews WHERE organization_id=$1 AND status <> 'cancelled'`, [org, mon, addDaysIso(mon, 6), pmon, addDaysIso(pmon, 6)]);
        add({ key: 'interviews_week', label: 'Interviews This Week', value: iv.cur, prev: iv.prev, format: 'num', to: '/recruiting/interviews', deltaLabel: 'vs last week' });
      }
    }
    if (focus.has('sales') && can(ctx, 'leads', 'view')) {
      const r = await one<any>(`SELECT count(*) FILTER (WHERE stage IN ('lead','qualified'))::int cur, count(*) FILTER (WHERE created_at >= $2::date)::int new_m, count(*) FILTER (WHERE created_at >= $3::date AND created_at < $2::date)::int new_pm FROM companies WHERE organization_id=$1 AND archived_at IS NULL`, [org, ms, pms]);
      out.push({ key: 'open_leads', label: 'Open Leads', value: r.cur, prev: null, delta: pctDelta(r.new_m, r.new_pm), format: 'num', to: '/crm/leads', deltaLabel: 'new leads vs last month' });
      if (can(ctx, 'opportunities', 'view')) {
        const o = await one<any>(`SELECT COALESCE(sum(value_cents) FILTER (WHERE stage NOT IN ('won','lost')),0)::bigint cur, COALESCE(sum(value_cents) FILTER (WHERE stage='won' AND closed_at >= $2::date),0)::bigint won FROM opportunities WHERE organization_id=$1 AND archived_at IS NULL`, [org, ms]);
        out.push({ key: 'pipeline_value', label: 'Open Pipeline Value', value: num(o.cur), prev: null, delta: null, format: 'money', to: '/crm/opportunities', deltaLabel: `${(num(o.won) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} won this month` });
      }
    }
    if (focus.has('money') && can(ctx, 'invoices', 'view')) {
      const r = await one<any>(`SELECT COALESCE(sum(total_cents - paid_cents),0)::bigint ar, COALESCE(sum(total_cents - paid_cents) FILTER (WHERE status='overdue'),0)::bigint od FROM invoices WHERE organization_id=$1 AND status IN ${OPEN_AR_STATUSES}`, [org]);
      out.push({ key: 'ar_open', label: 'Accounts Receivable', value: num(r.ar), prev: null, delta: null, format: 'money', to: '/finance/ar', deltaLabel: `${(num(r.od) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} overdue` });
    }
    if (focus.has('workforce') && can(ctx, 'attendance', 'view')) {
      const r = await one<any>(`SELECT count(*) FILTER (WHERE work_date=current_date AND kind IN ('late','absent'))::int cur, count(*) FILTER (WHERE work_date=current_date-7 AND kind IN ('late','absent'))::int prev FROM attendance_events WHERE organization_id=$1`, [org]);
      add({ key: 'late_today', label: 'Late / Absent Today', value: r.cur, prev: r.prev, format: 'num', to: `/time/attendance?from=${today}&to=${today}`, deltaLabel: 'vs same day last week', invert: true });
    }
  }
  return out;
}

export interface AttentionItem { kind: string; title: string; subtitle: string | null; link: string | null; severity: 'danger' | 'warn' | 'info'; at: string | null }
export const ATTENTION_KINDS: Record<string, string> = {
  overdue_tasks: 'Overdue tasks', late_workers: 'Late or absent today', onboarding_blockers: 'Missing required onboarding', unapproved_timesheets: 'Unapproved timesheets',
  overdue_invoices: 'Overdue invoices', failed_payouts: 'Failed payouts', expiring_documents: 'Expiring documents', stale_applications: 'Applications waiting 48h+', pending_approvals: 'Automations awaiting approval',
};

export async function buildAttention(ctx: Ctx, limit: number, onlyKind?: string): Promise<{ groups: { kind: string; label: string; count: number; items: AttentionItem[]; link: string }[] }> {
  const org = ctx.orgId;
  const leader = isLeader(ctx);
  const groups: { kind: string; label: string; count: number; items: AttentionItem[]; link: string }[] = [];
  const focus = focusOf(ctx);
  const area: Record<string, Focus | null> = { overdue_tasks: null, late_workers: 'workforce', onboarding_blockers: 'workforce', unapproved_timesheets: 'workforce', overdue_invoices: 'money', failed_payouts: 'money', expiring_documents: 'workforce', stale_applications: 'recruiting', pending_approvals: null };
  const want = (k: string) => (!onlyKind || onlyKind === k) && (leader || area[k] === null || focus.has(area[k]!) || (k === 'unapproved_timesheets' && focus.has('money')));
  const push = (kind: string, link: string, count: number, items: AttentionItem[]) => { if (count > 0) groups.push({ kind, label: ATTENTION_KINDS[kind], count, items, link }); };

  if (want('overdue_tasks') && can(ctx, 'tasks', 'view')) {
    const all = leader || scopeOf(ctx, 'tasks', 'view') === 'all';
    const where = `t.organization_id=$1 AND t.status IN ('open','in_progress') AND t.due_date < current_date AND t.archived_at IS NULL ${all ? '' : 'AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$2)'}`;
    const params = all ? [org] : [org, ctx.userId];
    const c = await one<any>(`SELECT count(*)::int n FROM tasks t WHERE ${where}`, params);
    const rows = await q<any>(`SELECT t.id, t.title, t.due_date, t.priority, (SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id) assignees, EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$${params.length + 1}) mine FROM tasks t WHERE ${where} ORDER BY t.due_date LIMIT ${limit}`, [...params, ctx.userId]);
    push('overdue_tasks', '/my-tasks?status=overdue', c.n, rows.map(r => ({ kind: 'overdue_tasks', title: r.title, subtitle: `Due ${fmtD(r.due_date)}${r.assignees ? ' · ' + r.assignees : ''}`, link: r.mine ? `/my-tasks?task=${r.id}` : LINK.task(r.id), severity: r.priority === 'urgent' || r.priority === 'high' ? 'danger' : 'warn', at: r.due_date })));
  }
  if (want('late_workers') && can(ctx, 'attendance', 'view')) {
    const where = `a.organization_id=$1 AND a.work_date=current_date AND a.kind IN ('late','absent')`;
    const c = await one<any>(`SELECT count(*)::int n FROM attendance_events a WHERE ${where}`, [org]);
    const rows = await q<any>(`SELECT a.id, a.kind, a.minutes, a.worker_id, a.created_at, concat_ws(' ', c.first_name, c.last_name) worker_name, co.name company_name FROM attendance_events a JOIN workers w ON w.id=a.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN placements p ON p.id=a.placement_id LEFT JOIN companies co ON co.id=p.company_id WHERE ${where} ORDER BY a.created_at DESC LIMIT ${limit}`, [org]);
    push('late_workers', `/time/attendance?from=${todayIso()}&to=${todayIso()}`, c.n, rows.map(r => ({ kind: 'late_workers', title: `${r.worker_name} — ${r.kind === 'absent' ? 'absent' : `${r.minutes ?? '?'} min late`}`, subtitle: r.company_name, link: LINK.worker(r.worker_id), severity: r.kind === 'absent' ? 'danger' : 'warn', at: r.created_at })));
  }
  if (want('onboarding_blockers') && (can(ctx, 'onboarding', 'view') || can(ctx, 'placements', 'view'))) {
    const base = `FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id
      JOIN LATERAL (SELECT count(*)::int missing, string_agg(i.title, ', ' ORDER BY i.sort) titles FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL) m ON m.missing > 0
      WHERE p.organization_id=$1 AND p.status='onboarding'`;
    const c = await one<any>(`SELECT count(*)::int n ${base}`, [org]);
    const rows = await q<any>(`SELECT p.id, p.start_date, concat_ws(' ', c.first_name, c.last_name) worker_name, co.name company_name, m.missing, m.titles ${base} ORDER BY p.start_date LIMIT ${limit}`, [org]);
    push('onboarding_blockers', '/workforce/onboarding', c.n, rows.map(r => ({ kind: 'onboarding_blockers', title: `${r.worker_name} — ${r.missing} required item${r.missing === 1 ? '' : 's'} missing`, subtitle: `${r.company_name} · starts ${fmtD(r.start_date)} · ${r.titles}`, link: LINK.placement(r.id), severity: r.start_date <= addDaysIso(todayIso(), 3) ? 'danger' : 'warn', at: r.start_date })));
  }
  if (want('unapproved_timesheets') && can(ctx, 'timesheets', 'view')) {
    const where = `t.organization_id=$1 AND t.status='submitted'`;
    const c = await one<any>(`SELECT count(*)::int n FROM timesheets t WHERE ${where}`, [org]);
    const rows = await q<any>(`SELECT t.id, t.week_start, t.total_minutes, t.submitted_at, concat_ws(' ', c.first_name, c.last_name) worker_name, co.name company_name FROM timesheets t JOIN workers w ON w.id=t.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=t.company_id WHERE ${where} ORDER BY t.submitted_at NULLS LAST LIMIT ${limit}`, [org]);
    push('unapproved_timesheets', '/time/timesheets?status=submitted', c.n, rows.map(r => ({ kind: 'unapproved_timesheets', title: `${r.worker_name} — week of ${fmtD(r.week_start)}`, subtitle: `${r.company_name} · ${(r.total_minutes / 60).toFixed(1)}h submitted`, link: LINK.timesheet(r.id), severity: 'info', at: r.submitted_at })));
  }
  if (want('overdue_invoices') && can(ctx, 'invoices', 'view')) {
    const where = `i.organization_id=$1 AND i.status='overdue'`;
    const c = await one<any>(`SELECT count(*)::int n FROM invoices i WHERE ${where}`, [org]);
    const rows = await q<any>(`SELECT i.id, i.number, i.due_date, i.total_cents - i.paid_cents balance, i.currency, co.name company_name FROM invoices i JOIN companies co ON co.id=i.company_id WHERE ${where} ORDER BY i.due_date LIMIT ${limit}`, [org]);
    push('overdue_invoices', '/finance/invoices?status=overdue', c.n, rows.map(r => ({ kind: 'overdue_invoices', title: `${r.number} — ${(num(r.balance) / 100).toLocaleString('en-US', { style: 'currency', currency: r.currency })} overdue`, subtitle: `${r.company_name} · due ${fmtD(r.due_date)}`, link: LINK.invoice(r.id), severity: 'danger', at: r.due_date })));
  }
  if (want('failed_payouts') && can(ctx, 'payouts', 'view')) {
    const where = `pi.organization_id=$1 AND pi.status='failed'`;
    const c = await one<any>(`SELECT count(*)::int n FROM payout_items pi WHERE ${where}`, [org]);
    const rows = await q<any>(`SELECT pi.id, pi.payout_id, pi.amount_cents, pi.currency, pi.failure_reason, pi.updated_at, COALESCE(concat_ws(' ', c.first_name, c.last_name), u.name) payee FROM payout_items pi LEFT JOIN workers w ON w.id=pi.worker_id LEFT JOIN candidates c ON c.id=w.candidate_id LEFT JOIN users u ON u.id=pi.user_id WHERE ${where} ORDER BY pi.updated_at DESC LIMIT ${limit}`, [org]);
    push('failed_payouts', '/finance/payouts?status=failed', c.n, rows.map(r => ({ kind: 'failed_payouts', title: `${r.payee} — ${(num(r.amount_cents) / 100).toLocaleString('en-US', { style: 'currency', currency: r.currency })} payout failed`, subtitle: r.failure_reason, link: LINK.payout(r.payout_id), severity: 'danger', at: r.updated_at })));
  }
  if (want('expiring_documents') && can(ctx, 'documents', 'view')) {
    const where = `d.organization_id=$1 AND d.archived_at IS NULL AND d.expires_at IS NOT NULL AND d.expires_at <= current_date + 30 AND d.source_document_id IS NULL AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id)`;
    const c = await one<any>(`SELECT count(*)::int n FROM documents d WHERE ${where}`, [org]);
    const rows = await q<any>(`SELECT d.id, d.name, d.expires_at, (d.expires_at < current_date) expired FROM documents d WHERE ${where} ORDER BY d.expires_at LIMIT ${limit}`, [org]);
    push('expiring_documents', '/documents/compliance', c.n, rows.map(r => ({ kind: 'expiring_documents', title: r.name, subtitle: r.expired ? `Expired ${fmtD(r.expires_at)}` : `Expires ${fmtD(r.expires_at)}`, link: LINK.document(r.id), severity: r.expired ? 'danger' : 'warn', at: r.expires_at })));
  }
  if (want('stale_applications') && can(ctx, 'candidates', 'view')) {
    const mineOnly = ctx.role.key === 'recruiter';
    const where = `a.organization_id=$1 AND a.status='new' AND a.reviewed_at IS NULL AND a.created_at < now() - interval '48 hours' ${mineOnly ? 'AND (a.recruiter_id=$2 OR a.position_id IN (SELECT position_id FROM position_recruiter_assignments WHERE user_id=$2 AND unassigned_at IS NULL))' : ''}`;
    const params = mineOnly ? [org, ctx.userId] : [org];
    const c = await one<any>(`SELECT count(*)::int n FROM applications a WHERE ${where}`, params);
    const rows = await q<any>(`SELECT a.id, a.candidate_id, a.created_at, concat_ws(' ', c.first_name, c.last_name) cand, p.title position_title FROM applications a JOIN candidates c ON c.id=a.candidate_id LEFT JOIN positions p ON p.id=a.position_id WHERE ${where} ORDER BY a.created_at LIMIT ${limit}`, params);
    push('stale_applications', '/recruiting/applications?status=new', c.n, rows.map(r => ({ kind: 'stale_applications', title: `${r.cand} — no recruiter action`, subtitle: r.position_title ?? 'General application', link: LINK.candidate(r.candidate_id), severity: 'warn', at: r.created_at })));
  }
  if (want('pending_approvals') && can(ctx, 'automation', 'approve')) {
    const c = await one<any>(`SELECT count(*)::int n FROM automation_runs WHERE organization_id=$1 AND status='pending_approval'`, [org]);
    const rows = await q<any>(`SELECT r.id, r.created_at, a.name FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.organization_id=$1 AND r.status='pending_approval' ORDER BY r.created_at DESC LIMIT ${limit}`, [org]);
    push('pending_approvals', '/automation/runs?status=pending_approval', c.n, rows.map(r => ({ kind: 'pending_approvals', title: `${r.name} — waiting for approval`, subtitle: null, link: `/automation/runs?status=pending_approval&run=${r.id}`, severity: 'info', at: r.created_at })));
  }
  return { groups };
}

async function buildBanner(ctx: Ctx, focus: Set<Focus>) {
  const org = ctx.orgId;
  const out: { tone: 'info' | 'warn' | 'danger'; text: string; link: string; cta: string }[] = [];
  const leader = isLeader(ctx);
  if (can(ctx, 'payroll', 'view') && (leader || focus.has('money'))) {
    const s = await getSetting<any>(org, 'payroll');
    const today = todayIso();
    const day = Number(today.slice(8, 10));
    const ms = monthStartIso(today);
    const monthEnd = addDaysIso(addMonthsIso(ms, 1), -1);
    let pStart: string, pEnd: string;
    if (s.frequency === 'monthly') { pStart = ms; pEnd = monthEnd; }
    else if (day <= 15) { pStart = ms; pEnd = ms.slice(0, 8) + '15'; }
    else { pStart = ms.slice(0, 8) + '16'; pEnd = monthEnd; }
    const payDate = addDaysIso(pEnd, Number(s.pay_day_offset ?? 5));
    const run = await one<any>(`SELECT status FROM payroll_runs WHERE organization_id=$1 AND period_start=$2::date AND period_end=$3::date`, [org, pStart, pEnd]);
    const daysTo = daysBetween(today, payDate);
    if (!run || ['calculated', 'review'].includes(run.status)) {
      const workers = await one<any>(`SELECT count(DISTINCT p.worker_id)::int n FROM placements p WHERE p.organization_id=$1 AND p.status IN ('active','on_leave','notice')`, [org]);
      out.push({ tone: daysTo <= 3 ? 'warn' : 'info', text: `Payroll for ${fmtD(pStart)} – ${fmtD(pEnd)} is due in ${daysTo} day${daysTo === 1 ? '' : 's'} (pay date ${fmtD(payDate)}). ${run ? `The run is in ${run.status} — approve it` : `Run it`} for ${workers.n} active workers.`, link: '/finance/payroll', cta: 'Open payroll' });
    }
  }
  if (can(ctx, 'invoices', 'view') && (leader || focus.has('money'))) {
    const r = await one<any>(`SELECT count(*)::int n, COALESCE(sum(total_cents - paid_cents),0)::bigint amt FROM invoices WHERE organization_id=$1 AND status='overdue'`, [org]);
    if (r.n) out.push({ tone: 'danger', text: `${r.n} invoice${r.n === 1 ? ' is' : 's are'} overdue — ${(num(r.amt) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} outstanding.`, link: '/finance/invoices?status=overdue', cta: 'Review invoices' });
  }
  if ((can(ctx, 'onboarding', 'view') || can(ctx, 'placements', 'view')) && (leader || focus.has('workforce'))) {
    const r = await one<any>(`SELECT count(*)::int n FROM placements p WHERE p.organization_id=$1 AND p.status='onboarding' AND EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL)`, [org]);
    if (r.n) out.push({ tone: 'warn', text: `${r.n} placement${r.n === 1 ? ' is' : 's are'} blocked from activation by missing required onboarding items.`, link: '/workforce/onboarding', cta: 'Resolve blockers' });
  }
  if (can(ctx, 'attendance', 'view') && (leader || focus.has('workforce'))) {
    const r = await one<any>(`SELECT count(*) FILTER (WHERE kind='late')::int late, count(*) FILTER (WHERE kind='absent')::int absent FROM attendance_events WHERE organization_id=$1 AND work_date=current_date`, [org]);
    if (r.late || r.absent) out.push({ tone: 'warn', text: `${r.late} worker${r.late === 1 ? ' was' : 's were'} late today${r.absent ? ` and ${r.absent} ${r.absent === 1 ? 'is' : 'are'} absent` : ''}.`, link: `/time/attendance?from=${todayIso()}&to=${todayIso()}`, cta: 'View attendance' });
  }
  if (can(ctx, 'candidates', 'view') && focus.has('recruiting') && !leader) {
    const r = await one<any>(`SELECT count(*)::int n FROM applications a WHERE a.organization_id=$1 AND a.status='new' AND a.reviewed_at IS NULL AND a.created_at < now() - interval '48 hours' ${ctx.role.key === 'recruiter' ? 'AND (a.recruiter_id=$2 OR a.position_id IN (SELECT position_id FROM position_recruiter_assignments WHERE user_id=$2 AND unassigned_at IS NULL))' : ''}`, ctx.role.key === 'recruiter' ? [org, ctx.userId] : [org]);
    if (r.n) out.push({ tone: 'warn', text: `${r.n} application${r.n === 1 ? ' has' : 's have'} been waiting more than 48 hours for a recruiter.`, link: '/recruiting/applications?status=new', cta: 'Review applications' });
  }
  return out;
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/dashboard/home', async (req) => {
    const ctx = staff(req);
    const focus = focusOf(ctx);
    const [kpis, banners, attention] = await Promise.all([buildKpis(ctx, focus), buildBanner(ctx, focus), buildAttention(ctx, 4)]);
    return {
      role: { key: ctx.role.key, name: ctx.role.name }, focus: [...focus], kpis, banners, attention: attention.groups,
      charts: {
        revenue: can(ctx, 'invoices', 'view') && (isLeader(ctx) || focus.has('money')),
        margin: (can(ctx, 'margin', 'view') || can(ctx, 'invoices', 'view')) && (isLeader(ctx) || focus.has('money') || focus.has('workforce')),
        funnel: can(ctx, 'candidates', 'view') && (isLeader(ctx) || focus.has('recruiting')),
        hours: (can(ctx, 'time', 'view') || can(ctx, 'timesheets', 'view')) && (isLeader(ctx) || focus.has('workforce') || focus.has('money')),
      },
      today: todayIso(),
    };
  });

  // Revenue (invoice totals by issue month) vs payroll (gross by pay date month).
  app.get('/api/v1/dashboard/revenue-trend', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'invoices', 'view')) throw notFound();
    const months = [3, 6, 12].includes(Number((req.query as any).months)) ? Number((req.query as any).months) : 6;
    const ms = lastMonths(months);
    const from = ms[0].month;
    const rev = await q<any>(`SELECT date_trunc('month', issue_date)::date::text m, COALESCE(sum(total_cents),0)::bigint v FROM invoices WHERE organization_id=$1 AND status IN ${REVENUE_STATUSES} AND issue_date >= $2::date GROUP BY 1`, [ctx.orgId, from]);
    const pay = can(ctx, 'payroll', 'view') ? await q<any>(`SELECT date_trunc('month', r.pay_date)::date::text m, COALESCE(sum(pi.gross_cents),0)::bigint v FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE pi.organization_id=$1 AND r.pay_date >= $2::date GROUP BY 1`, [ctx.orgId, from]) : [];
    const rows = ms.map(m => ({ label: m.label, month: m.month, revenue: num(rev.find(r => r.m === m.month)?.v), payroll: can(ctx, 'payroll', 'view') ? num(pay.find(r => r.m === m.month)?.v) : null }));
    const totRev = rows.reduce((a, r) => a + r.revenue, 0);
    const totPay = rows.reduce((a, r) => a + (r.payroll ?? 0), 0);
    const prevFrom = addMonthsIso(from, -months);
    const prevRev = num((await one<any>(`SELECT COALESCE(sum(total_cents),0)::bigint v FROM invoices WHERE organization_id=$1 AND status IN ${REVENUE_STATUSES} AND issue_date >= $2::date AND issue_date < $3::date`, [ctx.orgId, prevFrom, from]))?.v);
    return { months, rows, totals: { revenue: totRev, payroll: can(ctx, 'payroll', 'view') ? totPay : null, delta: pctDelta(totRev, prevRev) }, showPayroll: can(ctx, 'payroll', 'view') };
  });

  // Gross margin by client from approved timesheet days × effective rates.
  app.get('/api/v1/dashboard/margin-by-client', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'margin', 'view') && !can(ctx, 'invoices', 'view')) throw notFound();
    const months = [3, 6, 12].includes(Number((req.query as any).months)) ? Number((req.query as any).months) : 6;
    const from = lastMonths(months)[0].month;
    const rows = await q<any>(`SELECT co.id, co.name, ${REV_SQL} rev, ${COST_SQL} cost FROM ${APPROVED_DAYS} JOIN companies co ON co.id=p.company_id WHERE td.organization_id=$1 AND td.work_date >= $2::date GROUP BY co.id, co.name ORDER BY 3 DESC LIMIT 8`, [ctx.orgId, from]);
    const out = rows.map(r => ({ id: r.id, label: r.name, revenue: num(r.rev), cost: num(r.cost), profit: num(r.rev) - num(r.cost), value: num(r.rev) ? Math.round(((num(r.rev) - num(r.cost)) / num(r.rev)) * 1000) / 10 : 0, link: LINK.client(r.id) }));
    const t = await marginBetween(ctx.orgId, from, todayIso());
    return { months, rows: out, total: t };
  });

  // Recruiting funnel for activity created in the window.
  app.get('/api/v1/dashboard/funnel', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'candidates', 'view')) throw notFound();
    const months = [3, 6, 12].includes(Number((req.query as any).months)) ? Number((req.query as any).months) : 6;
    const from = lastMonths(months)[0].month;
    const r = await one<any>(`SELECT
      (SELECT count(*) FROM applications WHERE organization_id=$1 AND created_at >= $2::date)::int applied,
      (SELECT count(*) FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.organization_id=$1 AND a.created_at >= $2::date AND (a.status <> 'new' OR c.status <> 'new_applicant'))::int screened,
      (SELECT count(*) FROM candidate_submissions WHERE organization_id=$1 AND created_at >= $2::date)::int submitted,
      (SELECT count(DISTINCT candidate_id) FROM interviews WHERE organization_id=$1 AND scheduled_at >= $2::date AND status <> 'cancelled')::int interviewed,
      (SELECT count(*) FROM offers WHERE organization_id=$1 AND created_at >= $2::date)::int offered,
      (SELECT count(*) FROM placements WHERE organization_id=$1 AND created_at >= $2::date)::int hired`, [ctx.orgId, from]);
    return { months, from, steps: [
      { key: 'applied', label: 'Applied', value: r.applied, link: `/recruiting/applications?from=${from}` },
      { key: 'screened', label: 'Screened', value: r.screened, link: `/recruiting/candidates` },
      { key: 'submitted', label: 'Submitted', value: r.submitted, link: `/recruiting/submissions?from=${from}` },
      { key: 'interviewed', label: 'Interviewed', value: r.interviewed, link: `/recruiting/interviews?from=${from}` },
      { key: 'offered', label: 'Offered', value: r.offered, link: `/recruiting/offers?from=${from}` },
      { key: 'hired', label: 'Hired', value: r.hired, link: `/workforce/placements?from=${from}` },
    ] };
  });

  // Tracked hours per day (last N days).
  app.get('/api/v1/dashboard/hours-by-day', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'time', 'view') && !can(ctx, 'timesheets', 'view')) throw notFound();
    const days = [7, 14, 30].includes(Number((req.query as any).days)) ? Number((req.query as any).days) : 14;
    const from = addDaysIso(todayIso(), -days + 1);
    const rows = await q<any>(`SELECT te.work_date::text d, round(sum(${ENTRY_MIN}))::int m FROM time_entries te WHERE te.organization_id=$1 AND te.work_date >= $2::date GROUP BY 1`, [ctx.orgId, from]);
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDaysIso(from, i);
      const dt = new Date(d + 'T00:00:00Z');
      out.push({ date: d, label: days <= 7 ? dt.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' }) : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), value: num(rows.find(r => r.d === d)?.m), link: `/time/attendance?from=${d}&to=${d}` });
    }
    const total = out.reduce((a, r) => a + r.value, 0);
    const prev = Math.round(num((await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN}),0) v FROM time_entries te WHERE te.organization_id=$1 AND te.work_date >= $2::date AND te.work_date < $3::date`, [ctx.orgId, addDaysIso(from, -days), from]))?.v));
    return { days, rows: out, total, delta: pctDelta(total, prev) };
  });

  app.get('/api/v1/dashboard/attention', async (req) => {
    const ctx = staff(req);
    const kind = (req.query as any).kind as string | undefined;
    const r = await buildAttention(ctx, 200, kind && ATTENTION_KINDS[kind] ? kind : undefined);
    return { ...r, kinds: ATTENTION_KINDS };
  });

  // ── My Tasks ──
  app.get('/api/v1/dashboard/my-tasks', async (req) => {
    const ctx = staff(req);
    const lp = listParams(req);
    const where = ['t.organization_id=$1', 't.archived_at IS NULL', 'EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$2)'];
    const params: unknown[] = [ctx.orgId, ctx.userId];
    const st = lp.filters.status || 'open';
    if (st === 'open') where.push(`t.status IN ('open','in_progress')`);
    else if (st === 'overdue') where.push(`t.status IN ('open','in_progress') AND t.due_date < current_date`);
    else if (st === 'today') where.push(`t.status IN ('open','in_progress') AND t.due_date = current_date`);
    else if (st === 'week') where.push(`t.status IN ('open','in_progress') AND t.due_date BETWEEN current_date AND current_date + 7`);
    else if (st === 'done') where.push(`t.status = 'done'`);
    if (lp.filters.priority) { params.push(lp.filters.priority); where.push(`t.priority=$${params.length}`); }
    if (lp.filters.task) { params.push(lp.filters.task); where.push(`t.id::text=$${params.length}`); }
    const res = await paged<any>({ select: `t.*, (t.due_date < current_date AND t.status IN ('open','in_progress')) overdue, ${entityLabelSql('t.related_type', 't.related_id')} related_label, (SELECT stage FROM companies WHERE id=t.related_id) related_stage, u.name created_by_name`,
      from: 'tasks t LEFT JOIN users u ON u.id=t.created_by', where, params, lp, searchCols: ['t.title', 't.description'],
      sortMap: { due_date: 't.due_date', priority: `CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`, title: 't.title', created_at: 't.created_at' }, defaultSort: `t.due_date ASC NULLS LAST, t.created_at DESC` });
    res.rows = res.rows.map(r => ({ ...r, related_link: linkFor(r.related_type, r.related_id, { stage: r.related_stage }) }));
    const counts = await one<any>(`SELECT count(*) FILTER (WHERE t.status IN ('open','in_progress'))::int open, count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_date < current_date)::int overdue, count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_date = current_date)::int today, count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_date BETWEEN current_date AND current_date + 7)::int week, count(*) FILTER (WHERE t.status='done')::int done FROM tasks t WHERE t.organization_id=$1 AND t.archived_at IS NULL AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$2)`, [ctx.orgId, ctx.userId]);
    return { ...res, counts };
  });
  app.post('/api/v1/dashboard/my-tasks/:id/status', async (req) => {
    const ctx = staff(req);
    const { id } = req.params as { id: string };
    const b = z.object({ status: z.enum(['open', 'in_progress', 'done']) }).parse(req.body);
    const t = await one<any>(`SELECT t.* FROM tasks t WHERE t.id::text=$1 AND t.organization_id=$2 AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$3)`, [id, ctx.orgId, ctx.userId]);
    if (!t) throw notFound();
    if (t.status === b.status) return t;
    const r = await one<any>(`UPDATE tasks SET status=$3, completed_at=CASE WHEN $3='done' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, b.status]);
    await activity(ctx, 'task', id, 'status_change', b.status === 'done' ? 'Task completed' : `Task moved to ${b.status.replace('_', ' ')}`, null, { from: t.status, to: b.status });
    return r;
  });

  // ── Recent activity feed (only entity types the viewer can see) ──
  app.get('/api/v1/dashboard/activity', async (req) => {
    const ctx = staff(req);
    const types = visibleEntityTypes(ctx);
    const limit = Math.min(100, Number((req.query as any).limit) || 15);
    const rows = await q<any>(`SELECT a.id, a.entity_type, a.entity_id, a.kind, a.title, a.body, a.created_at, u.name actor_name, u.avatar_color actor_color,
      ${entityLabelSql('a.entity_type', 'a.entity_id')} entity_label, (SELECT stage FROM companies WHERE id=a.entity_id) stage
      FROM activities a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND a.entity_type = ANY($2) ORDER BY a.created_at DESC LIMIT ${limit}`, [ctx.orgId, types]);
    return { rows: rows.map(r => ({ ...r, body: r.body ? String(r.body).slice(0, 200) : null, link: linkFor(r.entity_type, r.entity_id, { stage: r.stage }) })) };
  });
}

/** 'YYYY-MM-DD' → 'Nov 5, 2026' for human-facing text. */
function fmtD(d: string) { return new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
