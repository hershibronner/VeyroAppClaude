/**
 * Every notification event the platform emits, with the default delivery for people who never changed their preferences.
 * In-app is on by default for everything; `email` marks events important enough to also email by default.
 * `portal` events are the only ones shown to worker / client portal users.
 */
export interface NotificationEventDef { event: string; label: string; group: string; description?: string; email?: boolean; portal?: boolean }

export const NOTIFICATION_GROUPS = ['CRM', 'Recruiting', 'Offers', 'Workforce', 'Time & attendance', 'Finance', 'Documents', 'Tasks', 'Account & billing', 'General'] as const;

export const NOTIFICATION_CATALOG: NotificationEventDef[] = [
  // CRM
  { event: 'lead.new', label: 'New lead', group: 'CRM', description: 'A lead came in from a form, import or integration', email: true },
  { event: 'lead.assigned', label: 'Lead assigned to me', group: 'CRM', email: true },
  { event: 'lead.converted', label: 'Lead converted', group: 'CRM' },
  { event: 'opportunity.assigned', label: 'Opportunity assigned to me', group: 'CRM', email: true },
  { event: 'opportunity.won', label: 'Opportunity won', group: 'CRM' },
  { event: 'client.assigned', label: 'Client assigned to me', group: 'CRM', email: true },
  { event: 'client.feedback', label: 'Client feedback on a submission', group: 'CRM', email: true },
  { event: 'position.requested', label: 'Client requested a new position', group: 'CRM', email: true },
  // Recruiting
  { event: 'application.new', label: 'New public application', group: 'Recruiting', description: 'Someone applied through your careers page', email: true },
  { event: 'application.created', label: 'New application on my positions', group: 'Recruiting' },
  { event: 'candidate.assigned', label: 'Candidate assigned to me', group: 'Recruiting', email: true },
  { event: 'candidate.updated', label: 'Candidate updated their profile', group: 'Recruiting' },
  { event: 'position.new', label: 'New position assigned to me', group: 'Recruiting', email: true },
  { event: 'submission.new', label: 'New submission to a client', group: 'Recruiting' },
  { event: 'screen.declined', label: 'Candidate declined a screen', group: 'Recruiting' },
  { event: 'interview.upcoming', label: 'Interview coming up', group: 'Recruiting', email: true, portal: true },
  { event: 'interview.changed', label: 'Interview rescheduled or cancelled', group: 'Recruiting', email: true, portal: true },
  { event: 'interview.feedback', label: 'Interview feedback added', group: 'Recruiting' },
  { event: 'assessment.assigned', label: 'Assessment assigned', group: 'Recruiting', portal: true },
  { event: 'assessment.completed', label: 'Assessment completed', group: 'Recruiting' },
  // Offers
  { event: 'offer.approval_needed', label: 'Offer needs my approval', group: 'Offers', email: true },
  { event: 'offer.approved', label: 'Offer approved', group: 'Offers' },
  { event: 'offer.sent', label: 'Offer sent', group: 'Offers', portal: true },
  { event: 'offer.accepted', label: 'Offer accepted', group: 'Offers', email: true },
  { event: 'offer.declined', label: 'Offer declined', group: 'Offers', email: true },
  { event: 'offer.expired', label: 'Offer expired', group: 'Offers' },
  // Workforce
  { event: 'placement.created', label: 'New placement', group: 'Workforce' },
  { event: 'placement.started', label: 'Placement started', group: 'Workforce' },
  { event: 'placement.ended', label: 'Placement ended', group: 'Workforce' },
  { event: 'activation.blocker', label: 'Worker activation blocked', group: 'Workforce', email: true },
  { event: 'activation.override', label: 'Activation check overridden', group: 'Workforce' },
  { event: 'onboarding.missing', label: 'Missing onboarding items', group: 'Workforce' },
  { event: 'training.completed', label: 'Training completed', group: 'Workforce' },
  { event: 'worker.payout_changed', label: 'Worker changed payout details', group: 'Workforce', email: true },
  { event: 'rate.changed', label: 'Pay or bill rate changed', group: 'Workforce' },
  { event: 'issue.created', label: 'Issue reported', group: 'Workforce', email: true },
  // Time & attendance
  { event: 'timesheet.submitted', label: 'Timesheet submitted', group: 'Time & attendance' },
  { event: 'timesheet.approved', label: 'Timesheet approved', group: 'Time & attendance', portal: true },
  { event: 'timesheet.rejected', label: 'Timesheet rejected', group: 'Time & attendance', email: true, portal: true },
  { event: 'timesheet.adjusted', label: 'Timesheet adjusted', group: 'Time & attendance', portal: true },
  { event: 'time.clocked_on_behalf', label: 'Clocked in or out on my behalf', group: 'Time & attendance', portal: true },
  { event: 'manual_time.requested', label: 'Manual time requested', group: 'Time & attendance' },
  { event: 'manual_time.decided', label: 'Manual time request decided', group: 'Time & attendance', portal: true },
  { event: 'time_off.requested', label: 'Time off requested', group: 'Time & attendance', email: true },
  { event: 'time_off.decided', label: 'Time off approved or declined', group: 'Time & attendance', email: true, portal: true },
  { event: 'attendance.late', label: 'Worker late', group: 'Time & attendance' },
  { event: 'attendance.absent', label: 'Worker absent', group: 'Time & attendance', email: true },
  { event: 'attendance.pattern', label: 'Attendance pattern flagged', group: 'Time & attendance' },
  // Finance
  { event: 'invoice.sent', label: 'Invoice sent', group: 'Finance', portal: true },
  { event: 'invoice.paid', label: 'Invoice paid', group: 'Finance', email: true },
  { event: 'invoice.overdue', label: 'Invoice overdue', group: 'Finance', email: true, portal: true },
  { event: 'payroll.approved', label: 'Payroll approved', group: 'Finance' },
  { event: 'payroll.paid', label: 'Payroll paid', group: 'Finance', portal: true },
  { event: 'payout.failed', label: 'Payout failed', group: 'Finance', email: true },
  { event: 'commission.approved', label: 'Commission approved', group: 'Finance' },
  { event: 'commission.paid', label: 'Commission paid', group: 'Finance', email: true },
  { event: 'expense.submitted', label: 'Expense submitted', group: 'Finance' },
  { event: 'expense.approved', label: 'Expense approved', group: 'Finance', portal: true },
  { event: 'expense.rejected', label: 'Expense rejected', group: 'Finance', portal: true },
  { event: 'expense.reimbursed', label: 'Expense reimbursed', group: 'Finance', portal: true },
  // Documents
  { event: 'signature.requested', label: 'Signature requested from me', group: 'Documents', email: true, portal: true },
  { event: 'document.signed', label: 'Document signed', group: 'Documents', portal: true },
  { event: 'document.declined', label: 'Document declined', group: 'Documents', email: true },
  { event: 'document.uploaded', label: 'Document uploaded', group: 'Documents' },
  { event: 'document.rejected', label: 'Document rejected', group: 'Documents', portal: true },
  { event: 'document.expiring', label: 'Document expiring', group: 'Documents', email: true, portal: true },
  // Tasks
  { event: 'task.assigned', label: 'Task assigned to me', group: 'Tasks', email: true, portal: true },
  { event: 'task.due', label: 'Task due today', group: 'Tasks' },
  { event: 'task.reminder', label: 'Task reminder', group: 'Tasks' },
  { event: 'task.overdue', label: 'Task overdue', group: 'Tasks' },
  { event: 'task.completed', label: 'Task I created was completed', group: 'Tasks' },
  // Account & billing
  { event: 'billing.payment_failed', label: 'Subscription payment failed', group: 'Account & billing', email: true },
  { event: 'billing.plan_changed', label: 'Plan changed', group: 'Account & billing', email: true },
  { event: 'billing.suspended', label: 'Workspace suspended', group: 'Account & billing', email: true },
  { event: 'billing.reactivated', label: 'Workspace reactivated', group: 'Account & billing', email: true },
  { event: 'role.changed', label: 'My role changed', group: 'Account & billing', email: true },
  { event: 'support.reply', label: 'Support replied to my ticket', group: 'Account & billing', email: true },
  { event: 'support.resolved', label: 'Support ticket resolved', group: 'Account & billing' },
  // General
  { event: 'mention', label: '@mentioned in a note', group: 'General', email: true },
  { event: 'message', label: 'New message', group: 'General', portal: true },
  { event: 'message.new', label: 'New inbound message', group: 'General' },
  { event: 'automation.approval', label: 'Automation waiting for approval', group: 'General', email: true },
  { event: 'integration.error', label: 'Integration error', group: 'General', email: true },
  { event: 'import.completed', label: 'Import finished', group: 'General' },
  { event: 'import.interrupted', label: 'Import interrupted', group: 'General', email: true },
  { event: 'export.created', label: 'Export ready', group: 'General' },
  { event: 'record.deleted', label: 'Record deleted', group: 'General' },
];

const BY_EVENT = new Map(NOTIFICATION_CATALOG.map(e => [e.event, e]));
export function eventDef(event: string) { return BY_EVENT.get(event); }
/** Delivery for a user who has no saved preference for this event. */
export function defaultDelivery(event: string) { return { in_app: true, email: !!BY_EVENT.get(event)?.email, sms: false }; }
