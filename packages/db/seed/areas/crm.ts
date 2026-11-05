// CRM area seed: reminders for upcoming open tasks (idempotent, works for any org).
import type { PoolClient } from 'pg';

export default async function (c: PoolClient) {
  await c.query(`INSERT INTO reminders (organization_id, task_id, remind_at, channels, created_by)
    SELECT t.organization_id, t.id, ((t.due_date - 1) + time '09:00') AT TIME ZONE o.timezone, '{in_app,email}', t.created_by
    FROM tasks t JOIN organizations o ON o.id=t.organization_id
    WHERE t.status IN ('open','in_progress') AND t.archived_at IS NULL AND t.due_date > current_date + 1
      AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.task_id=t.id)`);
}
