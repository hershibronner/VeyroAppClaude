// ADMIN + PLATFORM area seed (idempotent, works for any organization):
// worker training modules, a little progress for active workers, plan descriptions, support ticket replies.
import type { PoolClient } from 'pg';

const MODULES = [
  { title: 'Welcome & how we work', kind: 'reading', required: true, duration: 10, description: 'How your agency, your client and you work together day to day.', content: 'Welcome aboard!\n\n• Your agency is your employer of record and first point of contact.\n• Your client directs your daily work.\n• Clock in when you start, take breaks with the Break button, and clock out at the end of your shift.\n• Problems with your schedule, pay or equipment? Message your account manager from the Messages tab.' },
  { title: 'Remote Work & Monitoring Policy', kind: 'policy', required: true, duration: 5, description: 'What is captured while you are clocked in, and your rights.', content: 'While you are clocked in, screenshots may be captured at random moments within each interval and activity levels (counts only — never what you type) are recorded.\n\nYou can delete a screenshot within the window shown in your tracker. Data is kept only as long as your placement policy allows.\n\nBy completing this module you confirm you have read and accept this policy.' },
  { title: 'Data privacy & client confidentiality', kind: 'reading', required: true, duration: 15, description: 'Handling client data, passwords and customer information safely.', content: 'Never share client passwords, customer records or screenshots outside approved tools.\nUse the password manager your client provides.\nReport any suspected data leak to your account manager immediately.\nLock your screen whenever you step away.' },
  { title: 'Using the Time Tracker', kind: 'video', required: false, duration: 6, url: 'https://example.com/veyro/time-tracker-tour', description: 'A short tour of clock-in, breaks, idle time and manual time requests.', content: 'Watch the tour, then try clocking in and taking a break on your next shift. Forgot to clock in? Submit a Manual Time Request with a short reason.' },
  { title: 'Customer service writing basics', kind: 'reading', required: false, duration: 20, description: 'Tone, structure and response templates for email and chat support.', content: '1. Acknowledge the problem.\n2. Explain what you will do and when.\n3. Do it — then confirm.\nKeep sentences short, avoid jargon, and always end with a clear next step.' },
];

export default async function (c: PoolClient) {
  await c.query(`UPDATE plans SET description=COALESCE(description, CASE key WHEN 'trial' THEN '14-day free trial with every feature. Seats are metered but not charged.' WHEN 'standard' THEN '$29 per active worker seat per month. Client users and candidates are free.' WHEN 'white_label' THEN 'Everything in Standard plus your own domain, branded portals and emails, and no "Powered by VeyroApp".' END),
    sort=CASE key WHEN 'trial' THEN 0 WHEN 'standard' THEN 1 WHEN 'white_label' THEN 2 ELSE sort END`);
  const orgs = (await c.query(`SELECT id FROM organizations`)).rows;
  for (const o of orgs) {
    const has = (await c.query(`SELECT count(*)::int n FROM training_modules WHERE organization_id=$1`, [o.id])).rows[0].n;
    if (!has) {
      const owner = (await c.query(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND r.key='owner' ORDER BY m.created_at LIMIT 1`, [o.id])).rows[0]?.user_id ?? null;
      for (const [i, m] of MODULES.entries()) {
        await c.query(`INSERT INTO training_modules (organization_id, title, description, content, kind, url, required, duration_min, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [o.id, m.title, m.description, m.content, m.kind, (m as any).url ?? null, m.required, m.duration, i, owner]);
      }
      // Active workers have completed the required onboarding modules; some have started optional ones.
      const workers = (await c.query(`SELECT id, created_at FROM workers WHERE organization_id=$1 AND status='active' ORDER BY created_at`, [o.id])).rows;
      const mods = (await c.query(`SELECT id, required, sort FROM training_modules WHERE organization_id=$1 ORDER BY sort`, [o.id])).rows;
      for (const [wi, w] of workers.entries()) {
        for (const m of mods) {
          if (m.required && wi % 7 !== 3) await c.query(`INSERT INTO training_progress (organization_id, module_id, worker_id, status, started_at, completed_at) VALUES ($1,$2,$3,'completed', now() - interval '40 days', now() - interval '39 days') ON CONFLICT DO NOTHING`, [o.id, m.id, w.id]);
          else if (!m.required && wi % 3 === 0) await c.query(`INSERT INTO training_progress (organization_id, module_id, worker_id, status, started_at) VALUES ($1,$2,$3,'in_progress', now() - interval '5 days') ON CONFLICT DO NOTHING`, [o.id, m.id, w.id]);
        }
      }
    }
  }
  // A staff reply on the resolved seeded ticket so the conversation view has history.
  const t = (await c.query(`SELECT id FROM support_tickets WHERE subject='Screenshot blur question' LIMIT 1`)).rows[0];
  const p = (await c.query(`SELECT user_id FROM platform_admins ORDER BY created_at LIMIT 1`)).rows[0];
  if (t && p && !(await c.query(`SELECT 1 FROM support_ticket_replies WHERE ticket_id=$1`, [t.id])).rows.length) {
    await c.query(`INSERT INTO support_ticket_replies (ticket_id, author_id, body, is_staff, created_at) VALUES ($1,$2,$3,true, now() - interval '2 days')`, [t.id, p.user_id, 'Yes — when a monitoring policy has blur turned on, screenshots are blurred everywhere, including the client portal. You can also turn off client screenshot access per client under the client record.']);
  }
}
