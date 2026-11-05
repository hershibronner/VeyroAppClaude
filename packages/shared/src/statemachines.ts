// Explicit lifecycle state machines. Invalid transitions must be rejected with HTTP 409.
export const MACHINES = {
  company: { lead: ['qualified', 'client', 'inactive'], qualified: ['client', 'lead', 'inactive'], client: ['inactive'], inactive: ['client', 'lead'] },
  lead_status: { new: ['contacted', 'qualified', 'unqualified'], contacted: ['qualified', 'unqualified', 'new'], qualified: ['converted', 'unqualified', 'contacted'], unqualified: ['new', 'contacted'], converted: [] },
  candidate: {
    new_applicant: ['screening', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    screening: ['assessment', 'recruiter_review', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    assessment: ['recruiter_review', 'screening', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    recruiter_review: ['interview', 'qualified', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    interview: ['qualified', 'recruiter_review', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    qualified: ['talent_pool', 'submitted', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'],
    talent_pool: ['submitted', 'qualified', 'on_hold', 'future', 'withdrawn', 'blacklisted'],
    submitted: ['hired', 'talent_pool', 'qualified', 'rejected', 'withdrawn', 'blacklisted'],
    hired: ['talent_pool'],
    on_hold: ['screening', 'recruiter_review', 'qualified', 'talent_pool', 'rejected', 'withdrawn'],
    future: ['screening', 'talent_pool', 'rejected'],
    rejected: ['screening', 'future'],
    withdrawn: ['screening', 'future'],
    blacklisted: [],
  },
  submission: { submitted: ['client_review', 'rejected', 'withdrawn'], client_review: ['client_interview', 'offer', 'rejected', 'withdrawn'], client_interview: ['offer', 'rejected', 'withdrawn', 'client_review'], offer: ['hired', 'rejected', 'withdrawn'], hired: [], rejected: [], withdrawn: [] },
  position: { draft: ['open', 'closed'], open: ['on_hold', 'filled', 'closed'], on_hold: ['open', 'closed'], filled: ['open', 'closed'], closed: ['open'] },
  offer: { draft: ['approved', 'expired'], approved: ['sent', 'draft', 'expired'], sent: ['viewed', 'accepted', 'declined', 'expired'], viewed: ['accepted', 'declined', 'expired'], accepted: [], declined: [], expired: [] },
  placement: { onboarding: ['active', 'ended'], active: ['on_leave', 'notice', 'ended'], on_leave: ['active', 'notice', 'ended'], notice: ['ended', 'active'], ended: [] },
  timesheet: { open: ['submitted'], submitted: ['approved', 'rejected'], rejected: ['open', 'submitted'], approved: ['locked'], locked: [] },
  invoice: { draft: ['approved', 'void'], approved: ['sent', 'draft'], sent: ['viewed', 'partially_paid', 'paid', 'overdue', 'written_off'], viewed: ['partially_paid', 'paid', 'overdue', 'written_off'], partially_paid: ['paid', 'overdue', 'written_off'], overdue: ['partially_paid', 'paid', 'written_off'], paid: [], written_off: [], void: [] },
  payroll_run: { calculated: ['review'], review: ['approved', 'calculated'], approved: ['payment_initiated'], payment_initiated: ['paid', 'failed'], failed: ['payment_initiated'], paid: [] },
  payout_item: { pending: ['processing'], processing: ['paid', 'failed'], failed: ['retried'], retried: ['processing'], paid: [] },
  opportunity: { new: ['discovery', 'proposal', 'lost'], discovery: ['proposal', 'negotiation', 'lost'], proposal: ['negotiation', 'won', 'lost', 'discovery'], negotiation: ['won', 'lost', 'proposal'], won: [], lost: ['new'] },
  assessment: { sent: ['started', 'completed'], started: ['completed'], completed: ['scored'], scored: [] },
  interview: { scheduled: ['completed', 'cancelled', 'no_show', 'scheduled'], completed: [], cancelled: ['scheduled'], no_show: ['scheduled'] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type MachineName = keyof typeof MACHINES;

export function canTransition(machine: MachineName, from: string, to: string): boolean {
  const m = MACHINES[machine] as Record<string, readonly string[]>;
  return !!m[from] && m[from].includes(to);
}

export function allowedNext(machine: MachineName, from: string): string[] {
  const m = MACHINES[machine] as Record<string, readonly string[]>;
  return [...(m[from] ?? [])];
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
