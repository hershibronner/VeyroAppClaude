// Per-organization defaults. Used by the demo seed AND by "Create a new agency" so any agency works with zero code changes.
import type { PoolClient } from 'pg';
import { AGENCY_ROLES, CLIENT_ROLES, ACTIONS } from '@veyro/shared';

export const INTEGRATIONS = [
  { key: 'payments', category: 'Payments', provider: 'Stripe (simulated)', scopes: ['charges', 'refunds', 'webhooks'] },
  { key: 'payouts', category: 'Payouts', provider: 'Wise (simulated)', scopes: ['transfers', 'balances'] },
  { key: 'accounting', category: 'Accounting', provider: 'QuickBooks Online (simulated)', scopes: ['invoices', 'payments', 'customers'] },
  { key: 'email', category: 'Messaging', provider: 'Email (Dev Outbox)', scopes: ['send'] },
  { key: 'sms', category: 'Messaging', provider: 'SMS (Dev Outbox)', scopes: ['send'] },
  { key: 'whatsapp', category: 'Messaging', provider: 'WhatsApp (Dev Outbox)', scopes: ['send'] },
  { key: 'calendar', category: 'Calendar & Video', provider: 'Veyro Meet (simulated)', scopes: ['events', 'meetings'] },
  { key: 'esign', category: 'E-signature', provider: 'Built-in e-signature', scopes: ['envelopes'] },
  { key: 'ai', category: 'AI', provider: 'Veyro Local AI (deterministic)', scopes: ['resume', 'matching', 'drafting'] },
  { key: 'job_boards', category: 'Job boards', provider: 'Job board syndication (simulated)', scopes: ['post', 'applicants'] },
  { key: 'background_checks', category: 'Background checks', provider: 'Background check (simulated)', scopes: ['orders'] },
  { key: 'storage', category: 'File storage', provider: 'Local disk (./storage)', scopes: ['read', 'write'] },
];

export const EMAIL_TEMPLATES: { key: string; name: string; channel: string; subject: string; body: string }[] = [
  { key: 'invite_staff', name: 'Team invitation', channel: 'email', subject: 'You are invited to join {{org.name}} on VeyroApp', body: 'Hi {{invitee.name}},\n\n{{inviter.name}} invited you to join {{org.name}} as {{role.name}}.\n\nAccept your invitation: {{link}}\n\nThis link expires in 7 days.' },
  { key: 'invite_client_portal', name: 'Client portal invitation', channel: 'email', subject: '{{org.name}} invited you to your client portal', body: 'Hi {{invitee.name}},\n\n{{org.name}} has set up a client portal for {{company.name}} where you can see your team, approve timesheets and pay invoices.\n\nSet up your access: {{link}}' },
  { key: 'invite_worker_portal', name: 'Worker portal invitation', channel: 'email', subject: 'Welcome to {{org.name}} — set up your worker portal', body: 'Hi {{invitee.name}},\n\nYour worker portal is ready. Use it to clock in, see your schedule, timesheets and payslips.\n\nGet started: {{link}}' },
  { key: 'password_reset', name: 'Password reset', channel: 'email', subject: 'Reset your VeyroApp password', body: 'Hi {{user.name}},\n\nReset your password here: {{link}}\n\nIf you did not request this, you can ignore this email.' },
  { key: 'mfa_code', name: 'Sign-in code', channel: 'email', subject: 'Your VeyroApp sign-in code: {{code}}', body: 'Your sign-in code is {{code}}. It expires in 10 minutes.' },
  { key: 'application_received', name: 'Application received', channel: 'email', subject: 'We received your application{{position.suffix}}', body: 'Hi {{candidate.firstName}},\n\nThanks for applying to {{org.name}}. A recruiter will review your profile shortly.\n\nTrack your application: {{link}}' },
  { key: 'interview_scheduled', name: 'Interview scheduled', channel: 'email', subject: 'Interview scheduled: {{position.title}}', body: 'Hi {{candidate.firstName}},\n\nYour interview is on {{interview.when}} ({{interview.timezone}}).\nJoin: {{interview.link}}' },
  { key: 'offer_sent', name: 'Offer sent', channel: 'offer', subject: 'Your offer from {{org.name}}', body: 'Hi {{candidate.firstName}},\n\nWe are excited to offer you the {{position.title}} role starting {{offer.startDate}}.\n\nReview and sign: {{link}}' },
  { key: 'invoice_sent', name: 'Invoice sent', channel: 'email', subject: 'Invoice {{invoice.number}} from {{org.name}}', body: 'Hello {{contact.firstName}},\n\nInvoice {{invoice.number}} for {{invoice.total}} is due on {{invoice.dueDate}}.\n\nPay online: {{link}}' },
  { key: 'invoice_reminder', name: 'Invoice reminder', channel: 'email', subject: 'Reminder: invoice {{invoice.number}} is overdue', body: 'Hello {{contact.firstName}},\n\nInvoice {{invoice.number}} ({{invoice.balance}} outstanding) was due on {{invoice.dueDate}}.\n\nPay online: {{link}}' },
  { key: 'payment_receipt', name: 'Payment receipt', channel: 'email', subject: 'Receipt {{payment.receipt}} — thank you', body: 'We received {{payment.amount}} for invoice {{invoice.number}}. Thank you!' },
  { key: 'signature_request', name: 'Signature request', channel: 'email', subject: 'Please sign: {{document.title}}', body: 'Hi {{signer.name}},\n\n{{org.name}} sent you "{{document.title}}" to sign.\n\nReview and sign: {{link}}' },
  { key: 'worker_late', name: 'Worker late alert', channel: 'email', subject: '{{worker.name}} has not clocked in', body: '{{worker.name}} ({{company.name}}) is {{minutes}} minutes late for their shift.' },
  { key: 'payslip_ready', name: 'Payslip ready', channel: 'email', subject: 'Your payslip for {{period}} is ready', body: 'Hi {{worker.firstName}},\n\nYour payslip for {{period}} is ready. Net pay: {{net}}.\n\nView it: {{link}}' },
  { key: 'document_expiring', name: 'Document expiring', channel: 'email', subject: 'Action needed: {{document.name}} expires {{document.expiresAt}}', body: 'Hi {{person.firstName}},\n\nYour document "{{document.name}}" expires on {{document.expiresAt}}. Please upload a renewed copy.' },
  { key: 'lead_outreach', name: 'Lead outreach', channel: 'email', subject: 'Remote staff for {{company.name}}', body: 'Hi {{contact.firstName}},\n\nWe help companies like {{company.name}} hire vetted remote staff in days, not months. Open to a 15-minute call this week?\n\n{{sender.name}}' },
  { key: 'task_reminder', name: 'Task reminder', channel: 'email', subject: 'Reminder: {{task.title}}', body: 'Your task "{{task.title}}" is due {{task.due}}.' },
  { key: 'scheduled_report', name: 'Scheduled report', channel: 'email', subject: 'Report: {{report.name}}', body: 'Your scheduled report "{{report.name}}" is attached below.\n\n{{report.table}}' },
  { key: 'sms_shift_reminder', name: 'Shift reminder (SMS)', channel: 'sms', subject: '', body: '{{org.name}}: your shift starts at {{shift.start}}. Reply STOP to opt out.' },
  { key: 'whatsapp_interview', name: 'Interview reminder (WhatsApp)', channel: 'whatsapp', subject: '', body: 'Hi {{candidate.firstName}}! Reminder: interview tomorrow at {{interview.when}}. Link: {{interview.link}}' },
];

export const DOCUMENT_TEMPLATES = [
  { name: 'Independent Contractor Agreement', category: 'contract', body: 'INDEPENDENT CONTRACTOR AGREEMENT\n\nThis agreement is between {{org.name}} ("Agency") and {{worker.name}} ("Contractor"), effective {{placement.startDate}}.\n\n1. Services. Contractor will provide {{placement.title}} services to {{company.name}}.\n2. Compensation. As set out in the Contractor\'s current rate schedule.\n3. Confidentiality. Contractor will keep all client information confidential.\n4. Monitoring. Contractor acknowledges the time tracking and monitoring policy.\n\nSigned electronically.' },
  { name: 'Mutual NDA', category: 'nda', body: 'MUTUAL NON-DISCLOSURE AGREEMENT\n\nBetween {{org.name}} and {{party.name}}, dated {{today}}. Each party agrees to protect the other party\'s confidential information.' },
  { name: 'Offer Letter', category: 'offer_letter', body: 'OFFER LETTER\n\nDear {{candidate.name}},\n\nWe are pleased to offer you the role of {{position.title}} with a start date of {{offer.startDate}} at {{offer.payRate}}.\n\nSincerely,\n{{org.name}}' },
  { name: 'Client Master Services Agreement', category: 'contract', body: 'MASTER SERVICES AGREEMENT\n\nBetween {{org.name}} and {{company.name}}, effective {{today}}. Agency will provide remote staffing services billed per approved timesheet hours at agreed bill rates. Payment terms: net {{company.terms}} days.' },
  { name: 'Remote Work & Monitoring Policy', category: 'policy', body: 'REMOTE WORK & MONITORING POLICY\n\nWhile clocked in, screenshots may be captured at random moments within each interval and activity levels (counts only, never keystroke content) are recorded. Data is retained per the placement policy.' },
];

export const ASSESSMENT_TEMPLATES = [
  { name: 'Customer Service Writing Sample', category: 'Communication', instructions: 'Answer each question as you would reply to a real customer.', questions: [{ q: 'A patient is upset their appointment was rescheduled. Write your reply.' }, { q: 'How do you prioritize 20 unread messages at 9am?' }] },
  { name: 'Bookkeeping Practical', category: 'Finance', instructions: 'Complete the reconciliation tasks. Upload your spreadsheet if needed.', questions: [{ q: 'Explain how you would reconcile a bank statement with 3 unmatched transactions.' }, { q: 'What is the difference between accrual and cash basis?' }] },
  { name: 'Real Estate Admin Scenario', category: 'Operations', instructions: 'Describe your process.', questions: [{ q: 'Walk through how you coordinate a transaction from contract to close.' }] },
  { name: 'Typing & Data Entry', category: 'General', instructions: 'Paste your typing test result (WPM/accuracy) and answer the question.', questions: [{ q: 'Typing test WPM and accuracy:' }, { q: 'Describe your process for checking your data entry accuracy.' }] },
];

export const DEFAULT_ONBOARDING = [
  { title: 'Signed contractor agreement', required: true, owner: 'worker' },
  { title: 'Government ID verified', required: true, owner: 'agency' },
  { title: 'Tax form (W-8BEN) on file', required: true, owner: 'worker' },
  { title: 'Payout details confirmed', required: true, owner: 'worker' },
  { title: 'Equipment & internet speed check', required: true, owner: 'agency' },
  { title: 'Watch orientation video', required: false, owner: 'worker' },
  { title: 'Join team chat channel', required: false, owner: 'worker' },
];

export const DEFAULT_AUTOMATIONS = [
  { name: 'Worker 15 minutes late', description: 'Notify the account manager and create a follow-up task when a worker is 15+ minutes late.', trigger_kind: 'event', trigger_event: 'attendance.late', schedule: null, conditions: [{ field: 'minutes', op: '>=', value: 15 }], actions: [{ type: 'notify', to: 'account_manager', title: '{{worker.name}} is {{minutes}} min late' }, { type: 'create_task', assignee: 'account_manager', title: 'Follow up: {{worker.name}} late for {{company.name}}', priority: 'high', due_in_days: 0 }] },
  { name: 'Stale application reminder', description: 'Remind the attributed recruiter when a new application has had no recruiter action for 48 hours.', trigger_kind: 'schedule', trigger_event: 'application.stale', schedule: 'hourly', conditions: [{ field: 'hours_since', op: '>=', value: 48 }], actions: [{ type: 'notify', to: 'attributed_recruiter', title: 'Application waiting 48h: {{candidate.name}}' }] },
  { name: 'Document expiring in 30 days', description: 'Email the worker and create an HR task when a compliance document expires within 30 days.', trigger_kind: 'schedule', trigger_event: 'document.expiring', schedule: 'daily', conditions: [{ field: 'days_until_expiry', op: '<=', value: 30 }], actions: [{ type: 'send_template', template: 'document_expiring', to: 'worker' }, { type: 'create_task', assignee: 'role:hr', title: 'Renew {{document.name}} for {{person.name}}', priority: 'medium', due_in_days: 7 }] },
  { name: 'Invoice overdue 7 days', description: 'Send the reminder template to the client contact when an invoice is 7+ days overdue.', trigger_kind: 'schedule', trigger_event: 'invoice.overdue', schedule: 'daily', conditions: [{ field: 'days_overdue', op: '>=', value: 7 }], actions: [{ type: 'send_template', template: 'invoice_reminder', to: 'client_contact' }] },
  { name: 'Placement end date reached', description: 'Start the offboarding checklist when a placement reaches its end date.', trigger_kind: 'schedule', trigger_event: 'placement.end_reached', schedule: 'daily', conditions: [], actions: [{ type: 'start_offboarding' }, { type: 'notify', to: 'account_manager', title: 'Offboarding started: {{worker.name}}' }] },
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  payroll: { frequency: 'semi_monthly', pay_day_offset: 5, default_ot_multiplier_bp: 15000, ot_threshold_minutes: 2400, currencies: ['USD', 'PHP', 'MXN', 'ZAR'] },
  invoice: { prefix: 'INV', terms_days: 15, tax_bp: 0, footer: 'Thank you for your business.', late_fee_bp: 150 },
  ai: { enabled: true, simulate_failure: false, model: 'veyro-local-v1' },
  time_tracking: { late_grace_minutes: 5, absent_after_minutes: 120, retention_days: 90 },
  portals: { client_enabled: true, worker_enabled: true, candidate_enabled: true },
  security: { mfa_required: false },
};

export async function ensureOrgDefaults(c: PoolClient, orgId: string, opts: { ownerId?: string } = {}): Promise<Record<string, string>> {
  const roleIds: Record<string, string> = {};
  const allRoles = [
    ...AGENCY_ROLES.map(r => ({ ...r, kind: 'agency' })),
    ...CLIENT_ROLES.map(r => ({ ...r, kind: 'client', matrix: {} })),
    { key: 'worker', name: 'Worker', kind: 'worker', matrix: {} },
    { key: 'candidate', name: 'Candidate', kind: 'candidate', matrix: {} },
  ];
  for (const r of allRoles) {
    const res = await c.query(`INSERT INTO roles (organization_id, key, name, kind) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id, key) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [orgId, r.key, r.name, r.kind]);
    roleIds[r.key] = res.rows[0].id;
    for (const [resource, acts] of Object.entries(r.matrix ?? {})) {
      for (const a of ACTIONS) {
        const scope = (acts as Record<string, string>)[a];
        if (scope && scope !== 'none') await c.query(`INSERT INTO role_permissions (role_id, resource, action, scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [roleIds[r.key], resource, a, scope]);
      }
    }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await c.query(`INSERT INTO org_settings (organization_id, key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [orgId, k, JSON.stringify(v)]);
  for (const i of INTEGRATIONS) await c.query(`INSERT INTO integrations (organization_id, key, category, provider, scopes, status, last_sync_at) VALUES ($1,$2,$3,$4,$5,'connected', now()) ON CONFLICT DO NOTHING`, [orgId, i.key, i.category, i.provider, i.scopes]);
  await c.query(`INSERT INTO monitoring_policies (organization_id, name, screenshots_enabled, screenshot_interval_min, blur, activity_tracking, idle_minutes, retention_days, client_can_view, is_default) VALUES ($1,'Standard monitoring',true,10,false,true,5,90,true,true), ($1,'Privacy-first (blurred)',true,20,true,true,10,30,false,false), ($1,'Time only (no screenshots)',false,10,false,false,10,30,false,false)`, [orgId]);
  const tpl = await c.query(`INSERT INTO onboarding_templates (organization_id, name, scope, is_default) VALUES ($1,'Agency standard onboarding','agency',true) RETURNING id`, [orgId]);
  for (const [i, it] of DEFAULT_ONBOARDING.entries()) await c.query(`INSERT INTO onboarding_template_items (organization_id, template_id, title, required, owner, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, tpl.rows[0].id, it.title, it.required, it.owner, i]);
  await c.query(`INSERT INTO equipment_templates (organization_id, name, items) VALUES ($1,'Standard remote kit',$2), ($1,'Phone support kit',$3)`, [orgId, JSON.stringify(['Laptop/desktop (8GB+ RAM)', '25 Mbps internet + backup', 'Noise-cancelling headset', 'Webcam']), JSON.stringify(['Laptop/desktop (8GB+ RAM)', '25 Mbps internet + backup', 'USB headset with mic', 'Softphone app', 'Quiet workspace'])]);
  for (const t of EMAIL_TEMPLATES) {
    const r = await c.query(`INSERT INTO templates (organization_id, key, name, channel) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, t.key, t.name, t.channel]);
    await c.query(`INSERT INTO template_versions (organization_id, template_id, version, subject, body, created_by) VALUES ($1,$2,1,$3,$4,$5)`, [orgId, r.rows[0].id, t.subject, t.body, opts.ownerId ?? null]);
  }
  for (const d of DOCUMENT_TEMPLATES) await c.query(`INSERT INTO document_templates (organization_id, name, category, body) VALUES ($1,$2,$3,$4)`, [orgId, d.name, d.category, d.body]);
  for (const a of ASSESSMENT_TEMPLATES) await c.query(`INSERT INTO assessment_templates (organization_id, name, category, instructions, questions) VALUES ($1,$2,$3,$4,$5)`, [orgId, a.name, a.category, a.instructions, JSON.stringify(a.questions)]);
  for (const a of DEFAULT_AUTOMATIONS) await c.query(`INSERT INTO automations (organization_id, name, description, trigger_kind, trigger_event, schedule, conditions, actions, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`, [orgId, a.name, a.description, a.trigger_kind, a.trigger_event, a.schedule, JSON.stringify(a.conditions), JSON.stringify(a.actions), opts.ownerId ?? null]);
  await c.query(`INSERT INTO commission_rules (organization_id, name, applies_to, kind, pct_bp, months_limit) VALUES ($1,'Recruiter — 10% of gross profit (first 6 months)','recruiter','pct_gp',1000,6), ($1,'Sales — 5% of gross profit','sales','pct_gp',500,NULL)`, [orgId]);
  await c.query(`INSERT INTO commission_rules (organization_id, name, applies_to, kind, fixed_cents) VALUES ($1,'Account manager — $150 per new placement','account_manager','fixed',15000)`, [orgId]);
  await c.query(`INSERT INTO organization_branding (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
  return roleIds;
}
