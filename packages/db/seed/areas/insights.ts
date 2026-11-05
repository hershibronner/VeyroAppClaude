// INSIGHTS + OPS demo data: client/worker conversations, worker portal tasks, open signature requests, a scheduled report.
// Idempotent and tenant-agnostic (loops over every organization).
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';

export default async function (c: PoolClient) {
  const orgs = (await c.query(`SELECT id, name FROM organizations WHERE status <> 'deleted'`)).rows;
  for (const org of orgs) {
    const owner = (await c.query(`SELECT m.user_id, u.email FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND r.key='owner' AND m.status='active' ORDER BY m.created_at LIMIT 1`, [org.id])).rows[0];
    if (!owner) continue;

    // Client conversation (portal users of one client + its account manager).
    const hasClient = (await c.query(`SELECT 1 FROM message_threads WHERE organization_id=$1 AND kind='client' LIMIT 1`, [org.id])).rowCount;
    if (!hasClient) {
      const cl = (await c.query(`SELECT co.id, co.name, COALESCE(co.account_manager_id, $2) am, array_agg(m.user_id) users FROM companies co JOIN organization_memberships m ON m.company_id=co.id AND m.organization_id=co.organization_id AND m.status='active' WHERE co.organization_id=$1 GROUP BY co.id LIMIT 1`, [org.id, owner.user_id])).rows[0];
      if (cl) {
        const t = (await c.query(`INSERT INTO message_threads (organization_id, subject, kind, related_type, related_id, created_by, last_message_at, created_at) VALUES ($1,$2,'client','company',$3,$4, now() - interval '3 hours', now() - interval '2 days') RETURNING id`, [org.id, 'Holiday coverage in December', cl.id, cl.am])).rows[0];
        for (const u of new Set([cl.am, ...cl.users])) await c.query(`INSERT INTO thread_participants (thread_id, user_id, last_read_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t.id, u, u === cl.am ? new Date(Date.now() - 4 * 3600_000) : null]);
        const lines: [string, string, number][] = [
          [cl.am, `Hi! Planning ahead for December — which days will ${cl.name} be closed so we can schedule coverage?`, 48],
          [cl.users[0], 'We are closed Dec 24–26 and Dec 31. Could we get extra coverage on the 23rd?', 30],
          [cl.am, 'Absolutely. I will add a second VA on the 23rd and send the updated schedule this week.', 20],
          [cl.users[0], 'Perfect, thank you. Please also confirm the holiday rate.', 3],
        ];
        for (const [a, body, h] of lines) await c.query(`INSERT INTO messages (organization_id, thread_id, author_id, body, created_at) VALUES ($1,$2,$3,$4, now() - make_interval(hours => $5))`, [org.id, t.id, a, body, h]);
      }
    }

    // Worker conversation + portal tasks for workers who have portal access.
    const workers = (await c.query(`SELECT w.id, w.user_id, c.first_name, (SELECT COALESCE(p.account_manager_id, $2) FROM placements p WHERE p.worker_id=w.id ORDER BY (p.status='active') DESC, p.start_date DESC LIMIT 1) am FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.organization_id=$1 AND w.user_id IS NOT NULL LIMIT 3`, [org.id, owner.user_id])).rows;
    for (const w of workers) {
      const am = w.am ?? owner.user_id;
      const hasThread = (await c.query(`SELECT 1 FROM message_threads WHERE organization_id=$1 AND kind='worker' AND related_id=$2`, [org.id, w.id])).rowCount;
      if (!hasThread) {
        const t = (await c.query(`INSERT INTO message_threads (organization_id, subject, kind, related_type, related_id, created_by, last_message_at, created_at) VALUES ($1,'Schedule check-in','worker','worker',$2,$3, now() - interval '1 day', now() - interval '3 days') RETURNING id`, [org.id, w.id, am])).rows[0];
        await c.query(`INSERT INTO thread_participants (thread_id, user_id, last_read_at) VALUES ($1,$2,now()), ($1,$3,NULL) ON CONFLICT DO NOTHING`, [t.id, am, w.user_id]);
        await c.query(`INSERT INTO messages (organization_id, thread_id, author_id, body, created_at) VALUES ($1,$2,$3,$4, now() - interval '3 days'), ($1,$2,$5,$6, now() - interval '2 days'), ($1,$2,$3,$7, now() - interval '1 day')`,
          [org.id, t.id, am, `Hi ${w.first_name}, the client is very happy with your work this month. Any blockers on your side?`, w.user_id, 'Thanks! All good. My internet provider is doing maintenance Thursday night but I have a backup hotspot.', 'Great — please clock in as usual and flag it in your memo if anything drops.']);
      }
      const hasTasks = (await c.query(`SELECT 1 FROM task_assignees WHERE user_id=$1 LIMIT 1`, [w.user_id])).rowCount;
      if (!hasTasks) {
        const tasks: [string, string, string, number][] = [
          ['Upload your renewed tax form (W-8BEN)', 'Your current form expires soon. Upload the new one under Documents.', 'high', 5],
          ['Complete the client security training', 'Watch the 20-minute security video and confirm here when done.', 'medium', 10],
          ['Confirm your December availability', 'Reply in Messages with any days you will be unavailable in December.', 'low', 14],
        ];
        for (const [title, desc, prio, due] of tasks) {
          const t = (await c.query(`INSERT INTO tasks (organization_id, title, description, priority, due_date, related_type, related_id, created_by) VALUES ($1,$2,$3,$4, current_date + $5::int, 'worker', $6, $7) RETURNING id`, [org.id, title, desc, prio, due, w.id, am])).rows[0];
          await c.query(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, w.user_id]);
        }
      }
    }

    // Open signature requests for contracts that are still pending signature.
    const pending = (await c.query(`SELECT d.id, d.name, d.entity_id, concat_ws(' ', ca.first_name, ca.last_name) signer, ca.email, w.user_id, d.created_by FROM documents d JOIN workers w ON w.id=d.entity_id JOIN candidates ca ON ca.id=w.candidate_id
      WHERE d.organization_id=$1 AND d.entity_type='worker' AND d.category='contract' AND d.signature_status='pending' AND ca.email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM signature_requests s WHERE s.document_id=d.id)`, [org.id])).rows;
    for (const p of pending) {
      const body = `INDEPENDENT CONTRACTOR AGREEMENT\n\nThis agreement is between ${org.name} ("Agency") and ${p.signer} ("Contractor").\n\n1. Services. Contractor will provide remote support services to the assigned client.\n2. Compensation. As set out in the Contractor's current rate schedule.\n3. Confidentiality. Contractor will keep all client information confidential.\n4. Monitoring. Contractor acknowledges the time tracking and monitoring policy.`;
      await c.query(`INSERT INTO signature_requests (organization_id, document_id, entity_type, entity_id, title, rendered_body, signer_name, signer_email, signer_user_id, token, status, expires_at, created_by, created_at) VALUES ($1,$2,'worker',$3,$4,$5,$6,$7,$8,$9,'sent', now() + interval '10 days',$10, now() - interval '2 days')`,
        [org.id, p.id, p.entity_id, 'Independent Contractor Agreement', body, p.signer, p.email, p.user_id, crypto.randomBytes(24).toString('base64url'), p.created_by ?? owner.user_id]);
    }

    // Saved report filters + one weekly scheduled delivery.
    await c.query(`UPDATE report_definitions SET filters='[{"field":"issue_date","op":"last_days","value":182}]' WHERE organization_id=$1 AND entity='invoices' AND filters='[]'::jsonb`, [org.id]);
    await c.query(`UPDATE report_definitions SET filters='[{"field":"work_date","op":"last_days","value":31}]' WHERE organization_id=$1 AND entity='time_entries' AND filters='[]'::jsonb`, [org.id]);
    const rep = (await c.query(`SELECT id FROM report_definitions WHERE organization_id=$1 AND entity='invoices' ORDER BY created_at LIMIT 1`, [org.id])).rows[0];
    if (rep && !(await c.query(`SELECT 1 FROM scheduled_reports WHERE report_id=$1`, [rep.id])).rowCount) {
      await c.query(`INSERT INTO scheduled_reports (organization_id, report_id, cadence, recipients, next_run_at, active, created_by) VALUES ($1,$2,'weekly',$3, date_trunc('week', now()) + interval '7 days 13 hours', true, $4)`, [org.id, rep.id, [owner.email], owner.user_id]);
    }
  }
}
