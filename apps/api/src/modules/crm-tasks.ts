import { humanDate } from '../core/templates';
// CRM — Tasks: multiple assignees, priority, due date/time, related to any record, reminders
// (in-app + simulated email via a recurring job), overdue notifications, My/Team/Overdue views.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx, type Db } from '../core/db';
import { staff, need, can, scopeOf, type Ctx } from '../core/context';
import { conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { every } from '../jobs/queue';
import { sendTemplate } from '../adapters/messaging';
import { TASK_PRIORITIES, TASK_STATUSES, RELATED_TYPES, ENTITY_RESOURCE, relatedLabelSql, relatedStageSql, optStr, optDate, assertMembers, assertRelated, assertScope, isUuid, fieldError } from './_crm/util';

const TZ = `(SELECT timezone FROM organizations WHERE id=t.organization_id)`;
const LOCAL_NOW = `(now() AT TIME ZONE ${TZ})`;
const OVERDUE = `(t.status IN ('open','in_progress') AND t.due_date IS NOT NULL AND (t.due_date < ${LOCAL_NOW}::date OR (t.due_date = ${LOCAL_NOW}::date AND t.due_time IS NOT NULL AND t.due_time < ${LOCAL_NOW}::time)))`;
const DUE_AT = `((t.due_date + COALESCE(t.due_time, time '09:00')) AT TIME ZONE ${TZ})`;
const REMINDER_OPTS = ['none', 'at_due', '15m', '1h', '1d', 'custom'] as const;
const OFFSETS: Record<string, string> = { at_due: '0 minutes', '15m': '15 minutes', '1h': '1 hour', '1d': '1 day' };

const taskBody = z.object({
  title: z.string().trim().min(2, 'Title is required').max(200), description: optStr(5000),
  priority: z.enum(TASK_PRIORITIES).default('medium'), status: z.enum(TASK_STATUSES).default('open'),
  due_date: optDate, due_time: z.preprocess(v => (v === '' ? null : v), z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM').nullable().optional()),
  assignee_ids: z.array(z.string().uuid()).max(20).default([]),
  related_type: z.preprocess(v => (v === '' ? null : v), z.enum(RELATED_TYPES).nullable().optional()),
  related_id: z.preprocess(v => (v === '' ? null : v), z.string().uuid().nullable().optional()),
  reminder: z.enum(REMINDER_OPTS).default('none'),
  remind_at: z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional()),
});

function scopeWhere(ctx: Ctx, where: string[], params: unknown[]) {
  if (scopeOf(ctx, 'tasks', 'view') === 'own') { params.push(ctx.userId); where.push(`(t.created_by = $${params.length} OR EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id=t.id AND x.user_id=$${params.length}))`); }
}
const SELECT = `t.id, t.title, t.description, t.status, t.priority, t.due_date, to_char(t.due_time, 'HH24:MI') due_time, t.related_type, t.related_id, t.completed_at, t.created_at, t.created_by, cu.name created_by_name,
  ${relatedLabelSql('t.related_type', 't.related_id')} related_label, ${relatedStageSql('t.related_type', 't.related_id')} related_stage,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'avatar_color', u.avatar_color) ORDER BY u.name) FROM task_assignees a JOIN users u ON u.id=a.user_id WHERE a.task_id=t.id), '[]') assignees,
  ${OVERDUE} is_overdue, (SELECT min(remind_at) FROM reminders r WHERE r.task_id=t.id AND r.sent_at IS NULL) next_reminder_at`;
const FROM = `tasks t LEFT JOIN users cu ON cu.id=t.created_by`;
function maskRelated(ctx: Ctx, r: any) {
  const res = r.related_type ? ENTITY_RESOURCE[r.related_type] : null;
  const visible = !res || (r.related_type === 'company' ? (can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view')) : can(ctx, res, 'view'));
  return visible ? r : { ...r, related_label: null, related_hidden: true };
}

async function taskOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const t = await one<any>(`SELECT t.*, EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=$3) assigned_to_me FROM tasks t WHERE t.id=$1 AND t.organization_id=$2`, [id, ctx.orgId, ctx.userId]);
  if (!t) throw notFound();
  if (scopeOf(ctx, 'tasks', 'view') === 'own' && t.created_by !== ctx.userId && !t.assigned_to_me) throw notFound();
  return t;
}
async function setReminder(ctx: Ctx, taskId: string, opt: string, custom: string | null | undefined, db: Db) {
  if (opt === 'none') return;
  if (opt === 'custom') {
    if (!custom || Number.isNaN(new Date(custom).getTime())) fieldError('remind_at', 'Pick a reminder date and time');
    await db.query(`INSERT INTO reminders (organization_id, task_id, remind_at, channels, created_by) VALUES ($1,$2,($3::timestamp AT TIME ZONE (SELECT timezone FROM organizations WHERE id=$1)),'{in_app,email}',$4)`, [ctx.orgId, taskId, custom, ctx.userId]);
    return;
  }
  const t = (await db.query(`SELECT due_date FROM tasks WHERE id=$1`, [taskId])).rows[0];
  if (!t?.due_date) fieldError('reminder', 'Set a due date to use this reminder');
  await db.query(`INSERT INTO reminders (organization_id, task_id, remind_at, channels, created_by) SELECT $1, t.id, ${DUE_AT} - $3::interval, '{in_app,email}', $4 FROM tasks t WHERE t.id=$2`, [ctx.orgId, taskId, OFFSETS[opt], ctx.userId]);
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/tasks', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId];
    const where = ['t.organization_id=$1', 't.archived_at IS NULL'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    scopeWhere(ctx, where, params);
    if (f.view === 'my') add('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=?)', ctx.userId);
    if (f.view === 'created') add('t.created_by = ?', ctx.userId);
    if (f.view === 'overdue' || f.overdue === 'true') where.push(OVERDUE);
    const statuses = (f.status ?? '').split(',').filter(s => (TASK_STATUSES as readonly string[]).includes(s) || s === 'active');
    if (statuses.includes('active')) where.push(`t.status IN ('open','in_progress')`); else if (statuses.length) add('t.status = ANY(?)', statuses);
    if ((TASK_PRIORITIES as readonly string[]).includes(f.priority)) add('t.priority = ?', f.priority);
    if (isUuid(f.assignee) || f.assignee === 'me') add('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=?)', f.assignee === 'me' ? ctx.userId : f.assignee);
    if (f.assignee === 'none') where.push('NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id)');
    if (f.related_type) add('t.related_type = ?', f.related_type);
    if (isUuid(f.related_id)) add('t.related_id = ?', f.related_id);
    if (f.due === 'today') where.push(`t.due_date = ${LOCAL_NOW}::date`);
    else if (f.due === 'week') where.push(`t.due_date BETWEEN ${LOCAL_NOW}::date AND ${LOCAL_NOW}::date + 7`);
    else if (f.due === 'none') where.push('t.due_date IS NULL');
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.due_from ?? '')) add('t.due_date >= ?::date', f.due_from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.due_to ?? '')) add('t.due_date <= ?::date', f.due_to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.completed_from ?? '')) add('t.completed_at >= ?::date', f.completed_from);
    const res = await paged<any>({ select: SELECT, from: FROM, where, params, lp, searchCols: ['t.title', 't.description', relatedLabelSql('t.related_type', 't.related_id')],
      sortMap: { title: 't.title', due_date: 't.due_date', priority: `array_position(ARRAY['urgent','high','medium','low'], t.priority)`, status: 't.status', created_at: 't.created_at', completed_at: 't.completed_at' },
      defaultSort: `(t.status IN ('done','cancelled')), t.due_date ASC NULLS LAST, array_position(ARRAY['urgent','high','medium','low'], t.priority), t.created_at DESC` });
    res.rows = res.rows.map(r => maskRelated(ctx, r));
    return res;
  });

  app.get('/api/v1/tasks/stats', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'view');
    const params: unknown[] = [ctx.orgId, ctx.userId]; const where = ['t.organization_id=$1', 't.archived_at IS NULL'];
    scopeWhere(ctx, where, params);
    const mine = `EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=$2)`;
    const r = await one<any>(`SELECT
      count(*) FILTER (WHERE ${mine} AND t.status IN ('open','in_progress'))::int my_open,
      count(*) FILTER (WHERE ${mine} AND ${OVERDUE})::int my_overdue,
      count(*) FILTER (WHERE ${mine} AND t.status IN ('open','in_progress') AND t.due_date = ${LOCAL_NOW}::date)::int my_due_today,
      count(*) FILTER (WHERE t.status IN ('open','in_progress'))::int team_open,
      count(*) FILTER (WHERE ${OVERDUE})::int overdue,
      count(*) FILTER (WHERE t.status='done' AND t.completed_at >= date_trunc('week', now()))::int done_this_week,
      count(*) FILTER (WHERE t.status='done' AND t.completed_at >= date_trunc('week', now()) - interval '7 days' AND t.completed_at < date_trunc('week', now()))::int done_last_week,
      count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.priority IN ('high','urgent'))::int high_priority,
      to_char(date_trunc('week', now()), 'YYYY-MM-DD') week_start
      FROM tasks t WHERE ${where.join(' AND ')}`, params);
    return r;
  });

  app.get('/api/v1/tasks/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'view');
    const t = await taskOr404(ctx, (req.params as any).id);
    const row = await one<any>(`SELECT ${SELECT} FROM ${FROM} WHERE t.id=$1`, [t.id]);
    const reminders = await q<any>(`SELECT id, remind_at, channels, sent_at FROM reminders WHERE task_id=$1 ORDER BY remind_at`, [t.id]);
    return { ...maskRelated(ctx, row), reminders, can_edit: scopeOf(ctx, 'tasks', 'edit') === 'all' || (scopeOf(ctx, 'tasks', 'edit') !== 'none' && (t.created_by === ctx.userId || t.assigned_to_me)) };
  });

  app.post('/api/v1/tasks', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'create');
    const b = taskBody.parse(req.body);
    if (b.due_time && !b.due_date) fieldError('due_date', 'Pick a due date for the time');
    await assertMembers(ctx, b.assignee_ids); await assertRelated(ctx, b.related_type, b.related_id);
    const assignees = b.assignee_ids.length ? [...new Set(b.assignee_ids)] : [ctx.userId];
    const t = await tx(async db => {
      const t = (await db.query(`INSERT INTO tasks (organization_id, title, description, status, priority, due_date, due_time, related_type, related_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.orgId, b.title, b.description ?? null, b.status, b.priority, b.due_date ?? null, b.due_time ?? null, b.related_type ?? null, b.related_id ?? null, ctx.userId])).rows[0];
      for (const u of assignees) await db.query(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, u]);
      await setReminder(ctx, t.id, b.reminder, b.remind_at, db);
      await activity(ctx, 'task', t.id, 'system', 'Task created', null, {}, db);
      if (b.related_type && b.related_id) await activity(ctx, b.related_type, b.related_id, 'system', `Task created: ${b.title}`, b.due_date ? `Due ${humanDate(b.due_date)}${b.due_time ? ' ' + b.due_time : ''}` : null, { task_id: t.id }, db);
      return t;
    });
    await notify(ctx.orgId, assignees.filter(u => u !== ctx.userId), { event: 'task.assigned', title: `New task: ${t.title}`, body: `${ctx.user.name} assigned you a task${t.due_date ? ` due ${humanDate(t.due_date)}` : ''}.`, link: `/crm/tasks?task=${t.id}` });
    return t;
  });

  app.patch('/api/v1/tasks/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'edit');
    const t = await taskOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'tasks', 'edit', t, t.assigned_to_me);
    const b = taskBody.partial().omit({ reminder: true, remind_at: true }).parse(req.body);
    if (b.assignee_ids) await assertMembers(ctx, b.assignee_ids);
    if ('related_type' in b || 'related_id' in b) await assertRelated(ctx, b.related_type ?? null, b.related_id ?? null);
    const before = await q<any>(`SELECT user_id FROM task_assignees WHERE task_id=$1`, [t.id]);
    const row = await tx(async db => {
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'description', 'priority', 'status', 'due_date', 'due_time', 'related_type', 'related_id'] as const) if (k in b) patch[k] = (b as any)[k] ?? null;
      if ('status' in patch) { patch.completed_at = patch.status === 'done' ? new Date() : null; }
      if ('due_date' in patch || 'due_time' in patch) patch.overdue_notified_at = null;
      const keys = Object.keys(patch);
      const r = keys.length ? (await db.query(`UPDATE tasks SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [t.id, ctx.orgId, ...Object.values(patch)])).rows[0] : t;
      if (b.assignee_ids) {
        await db.query(`DELETE FROM task_assignees WHERE task_id=$1`, [t.id]);
        for (const u of new Set(b.assignee_ids)) await db.query(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2)`, [t.id, u]);
      }
      if ('due_date' in patch || 'due_time' in patch) {
        // Re-anchor relative reminders that have not fired yet.
        await db.query(`UPDATE reminders r SET remind_at = r.remind_at + (x.new_due - x.old_due)
          FROM (SELECT ((tk.due_date + COALESCE(tk.due_time, time '09:00')) AT TIME ZONE o.timezone) new_due, (($2::date + COALESCE($3::time, time '09:00')) AT TIME ZONE o.timezone) old_due
                FROM tasks tk JOIN organizations o ON o.id=tk.organization_id WHERE tk.id=$1 AND tk.due_date IS NOT NULL) x
          WHERE r.task_id=$1 AND r.sent_at IS NULL AND $2::date IS NOT NULL`, [t.id, t.due_date, t.due_time]);
      }
      const changed = keys.filter(k => !['completed_at', 'overdue_notified_at'].includes(k)).concat(b.assignee_ids ? ['assignees'] : []);
      if (changed.length) await activity(ctx, 'task', t.id, 'system', `Updated ${changed.map(k => k.replace(/_/g, ' ')).join(', ')}`, null, {}, db);
      return r;
    });
    if (b.assignee_ids) {
      const added = b.assignee_ids.filter(u => !before.some(x => x.user_id === u) && u !== ctx.userId);
      await notify(ctx.orgId, added, { event: 'task.assigned', title: `New task: ${row.title}`, body: `${ctx.user.name} assigned you a task.`, link: `/crm/tasks?task=${t.id}` });
    }
    return row;
  });

  async function setStatus(req: any, to: 'done' | 'open') {
    const ctx = staff(req); need(ctx, 'tasks', 'edit');
    const t = await taskOr404(ctx, req.params.id);
    assertScope(ctx, 'tasks', 'edit', t, t.assigned_to_me);
    if (to === 'done' && t.status === 'done') throw conflict('This task is already complete');
    if (to === 'open' && !['done', 'cancelled'].includes(t.status)) throw conflict('Only completed or cancelled tasks can be reopened');
    const r = await one<any>(`UPDATE tasks SET status=$3, completed_at=$4, overdue_notified_at=CASE WHEN $3='open' THEN NULL ELSE overdue_notified_at END, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [t.id, ctx.orgId, to, to === 'done' ? new Date() : null]);
    await activity(ctx, 'task', t.id, 'status_change', to === 'done' ? 'Task completed' : 'Task reopened', null, { from: t.status, to });
    if (t.related_type && t.related_id) await activity(ctx, t.related_type, t.related_id, 'system', `${to === 'done' ? 'Completed' : 'Reopened'} task: ${t.title}`, null, { task_id: t.id });
    if (to === 'done' && t.created_by && t.created_by !== ctx.userId) await notify(ctx.orgId, [t.created_by], { event: 'task.completed', title: `Task completed: ${t.title}`, body: `Completed by ${ctx.user.name}`, link: `/crm/tasks?task=${t.id}` });
    return r;
  }
  app.post('/api/v1/tasks/:id/complete', (req) => setStatus(req, 'done'));
  app.post('/api/v1/tasks/:id/reopen', (req) => setStatus(req, 'open'));

  app.post('/api/v1/tasks/:id/reminders', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'edit');
    const t = await taskOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'tasks', 'edit', t, t.assigned_to_me);
    const b = z.object({ reminder: z.enum(REMINDER_OPTS).default('custom'), remind_at: z.string().nullable().optional() }).parse(req.body);
    if (b.reminder === 'none') fieldError('reminder', 'Pick when to be reminded');
    await tx(db => setReminder(ctx, t.id, b.reminder, b.remind_at, db));
    await activity(ctx, 'task', t.id, 'system', 'Reminder added');
    return q(`SELECT id, remind_at, channels, sent_at FROM reminders WHERE task_id=$1 ORDER BY remind_at`, [t.id]);
  });
  app.delete('/api/v1/tasks/:id/reminders/:rid', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'edit');
    const t = await taskOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'tasks', 'edit', t, t.assigned_to_me);
    const { rid } = req.params as any;
    if (!isUuid(rid)) throw notFound();
    const r = await one(`DELETE FROM reminders WHERE id=$1 AND task_id=$2 AND organization_id=$3 RETURNING id`, [rid, t.id, ctx.orgId]);
    if (!r) throw notFound();
    return { ok: true };
  });

  app.delete('/api/v1/tasks/:id', async (req) => {
    const ctx = staff(req);
    const t = await taskOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'tasks', 'delete', t);
    await q(`UPDATE tasks SET archived_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [t.id, ctx.orgId]);
    await q(`DELETE FROM reminders WHERE task_id=$1 AND sent_at IS NULL`, [t.id]);
    await activity(ctx, 'task', t.id, 'system', 'Task deleted');
    await audit(ctx, 'task.deleted', { type: 'task', id: t.id, label: t.title });
    return { ok: true };
  });

  app.post('/api/v1/tasks/bulk', async (req) => {
    const ctx = staff(req); need(ctx, 'tasks', 'edit');
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['complete', 'reopen', 'assign']), user_id: z.string().uuid().optional() }).parse(req.body);
    const rows = await q<any>(`SELECT t.*, EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=$3) assigned_to_me FROM tasks t WHERE t.organization_id=$1 AND t.id = ANY($2) AND t.archived_at IS NULL`, [ctx.orgId, b.ids, ctx.userId]);
    for (const t of rows) assertScope(ctx, 'tasks', 'edit', t, t.assigned_to_me);
    if (b.action === 'assign') {
      if (!b.user_id) fieldError('user_id', 'Pick a person');
      await assertMembers(ctx, [b.user_id!]);
      for (const t of rows) { await q(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, b.user_id]); await activity(ctx, 'task', t.id, 'system', 'Assignee added'); }
      if (b.user_id !== ctx.userId) await notify(ctx.orgId, [b.user_id], { event: 'task.assigned', title: `${rows.length} task(s) assigned to you`, body: `Assigned by ${ctx.user.name}`, link: '/crm/tasks?view=my' });
    } else {
      const to = b.action === 'complete' ? 'done' : 'open';
      const ids = rows.filter(t => (to === 'done' ? t.status !== 'done' : ['done', 'cancelled'].includes(t.status))).map(t => t.id);
      await q(`UPDATE tasks SET status=$3, completed_at=$4, updated_at=now() WHERE organization_id=$1 AND id = ANY($2)`, [ctx.orgId, ids, to, to === 'done' ? new Date() : null]);
      for (const id of ids) await activity(ctx, 'task', id, 'status_change', to === 'done' ? 'Task completed' : 'Task reopened');
      return { ok: true, count: ids.length };
    }
    return { ok: true, count: rows.length };
  });

  // ── Background: fire due reminders (in-app notification + simulated email) ──
  every('crm.task-reminders', 15_000, async () => {
    const due = await q<any>(`UPDATE reminders SET sent_at=now() WHERE id IN (SELECT id FROM reminders WHERE sent_at IS NULL AND remind_at <= now() AND task_id IS NOT NULL ORDER BY remind_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING *`);
    for (const r of due) {
      const t = await one<any>(`SELECT t.*, to_char(t.due_time, 'HH24:MI') due_hm FROM tasks t WHERE t.id=$1 AND t.archived_at IS NULL`, [r.task_id]);
      if (!t || ['done', 'cancelled'].includes(t.status)) continue;
      const users = await q<any>(`SELECT u.id, u.email FROM task_assignees a JOIN users u ON u.id=a.user_id WHERE a.task_id=$1`, [t.id]);
      const recipients = users.length ? users : await q<any>(`SELECT id, email FROM users WHERE id=$1`, [t.created_by]);
      const dueText = t.due_date ? `${humanDate(t.due_date)}${t.due_hm ? ' at ' + t.due_hm : ''}` : 'soon';
      if (r.channels.includes('in_app')) await notify(t.organization_id, recipients.map(u => u.id), { event: 'task.reminder', title: `Reminder: ${t.title}`, body: `Due ${dueText}`, link: `/crm/tasks?task=${t.id}` });
      if (r.channels.includes('email')) for (const u of recipients) await sendTemplate(t.organization_id, 'task_reminder', u.email, { task: { title: t.title, due: dueText } }, { related: { type: 'task', id: t.id } });
    }
  });

  // ── Background: notify assignees once when a task becomes overdue ──
  every('crm.task-overdue', 60_000, async () => {
    const rows = await q<any>(`UPDATE tasks t SET overdue_notified_at=now() WHERE t.id IN (SELECT t.id FROM tasks t WHERE t.archived_at IS NULL AND t.overdue_notified_at IS NULL AND ${OVERDUE} LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING t.id, t.organization_id, t.title, t.due_date, t.created_by`);
    for (const t of rows) {
      const users = (await q<any>(`SELECT user_id FROM task_assignees WHERE task_id=$1`, [t.id])).map(u => u.user_id);
      await notify(t.organization_id, users.length ? users : [t.created_by], { event: 'task.overdue', title: `Overdue: ${t.title}`, body: `This task was due ${humanDate(t.due_date)}.`, link: `/crm/tasks?task=${t.id}` });
    }
  });
}
