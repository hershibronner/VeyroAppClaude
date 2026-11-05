// Help Center content: practical guides to using VeyroApp. Body uses a tiny markup: "## " headings, "- " bullets, "1. " steps, `code`.
export interface Article { slug: string; title: string; category: string; summary: string; body: string; links?: { label: string; to: string }[]; keywords?: string }

export const CATEGORIES = ['Getting started', 'CRM & sales', 'Recruiting', 'Placements & workforce', 'Time & monitoring', 'Finance', 'Portals', 'Admin & security', 'Billing & plans', 'Integrations & API'];

export const ARTICLES: Article[] = [
  { slug: 'lifecycle', category: 'Getting started', title: 'How work flows through VeyroApp', summary: 'The end-to-end lifecycle from first lead to paid invoice and payroll.', keywords: 'overview lifecycle flow',
    body: `VeyroApp keeps one connected record for every company and every person, so nothing is retyped between teams.
## The lifecycle
1. A **lead** (a company) is worked in CRM, qualified and converted — it becomes a **client** without changing its ID.
2. Sales or the account manager opens a **position** for the client and assigns recruiters.
3. Candidates apply through position links, are screened, assessed and **submitted** to the client.
4. The client reviews profiles in the Client Portal, interviews, and an **offer** is accepted and signed.
5. A **placement** is created from the offer. The candidate becomes a worker — still the same person.
6. Onboarding items are completed and the placement is **activated**, which starts a billable seat.
7. The worker clocks in from the Worker Portal; time becomes a weekly **timesheet** that the client approves.
8. Only approved time feeds **invoices**, **payroll**, margin and commissions.
## Where to look
- Home shows what needs attention today across all of these steps.
- Every record has a timeline with calls, emails, status changes and notes.`, links: [{ label: 'Open Home', to: '/' }] },
  { slug: 'switch-workspace', category: 'Getting started', title: 'Switching between agencies', summary: 'Use the workspace card to move between agencies without signing out.', keywords: 'tenant workspace switch multiple agencies',
    body: `If you belong to more than one agency, click the workspace card at the top of the sidebar and choose another agency.
- Your session stays signed in; branding, role, permissions and data switch together.
- Data from one agency is never shown in another. Links to a record in another agency return "Not found".
- Owners and Admins can create another agency from the same menu.`, links: [{ label: 'My profile', to: '/profile' }] },
  { slug: 'quick-create-search', category: 'Getting started', title: 'Quick Create and global search', summary: 'Create records from anywhere with + and find anything with ⌘K.', keywords: 'search shortcut create cmd k',
    body: `- Press **⌘K** (Ctrl+K on Windows) or the search icon to search clients, contacts, leads, candidates, positions, workers, invoices, documents and messages. Results only include records your role can see.
- The **+** button opens the real create form for leads, clients, contacts, opportunities, candidates, positions, tasks and invoices.` },
  { slug: 'leads', category: 'CRM & sales', title: 'Working and converting leads', summary: 'Log activity, qualify, and convert a lead into a client with the same record.', keywords: 'lead qualify convert client opportunity',
    body: `## Working a lead
1. Open the lead and log calls, emails and meetings from its timeline — engagement raises the lead score.
2. Set the next follow-up date so the lead shows up in your tasks.
3. Move the status from New → Contacted → Qualified.
## Converting
Use **Convert to client** on a qualified lead. The company keeps its ID, history and contacts, and you can create an opportunity or a draft position at the same time.`, links: [{ label: 'Leads', to: '/crm/leads' }] },
  { slug: 'positions-recruiters', category: 'Recruiting', title: 'Assigning recruiters and sharing position links', summary: 'Recruiter scope, assignments and attributed application links.', keywords: 'recruiter assigned scope link sourcing attribution',
    body: `- Assign recruiters from the position page. Recruiters with **Assigned** scope only work on positions assigned to them.
- Each recruiter has a personal link and a link per position. Applications through a link are attributed to that recruiter, even if the same person applies again later.
- Duplicate applicants are detected by email and phone — a second application is attached to the existing candidate.`, links: [{ label: 'Positions', to: '/recruiting/positions' }] },
  { slug: 'ai', category: 'Recruiting', title: 'How AI resume analysis and matching work', summary: 'AI suggestions are grounded in the resume text and always show evidence.', keywords: 'ai resume match analyze',
    body: `The AI assistant runs locally and deterministically.
- **Analyze resume** extracts skills, experience and education that literally appear in the resume and shows the source snippet for each field. It never invents employers or credentials.
- **Find best matches** ranks candidates for a position and explains each score.
- Nothing is saved to a record until a recruiter accepts it.
Admins can turn AI off or simulate a provider outage in **Settings → AI**.`, links: [{ label: 'AI settings', to: '/settings/ai' }] },
  { slug: 'activation', category: 'Placements & workforce', title: 'Activating a placement', summary: 'Required onboarding items block activation; overrides need a reason.', keywords: 'placement activate onboarding blocked override seat',
    body: `When you click **Activate**, VeyroApp checks the placement's onboarding checklist.
- If any **required** item is open, activation is blocked and the missing items are listed.
- Optional items can stay open.
- An Owner or Admin can override with a written reason; the override is audited and other admins are notified.
Activation starts a billable **seat** (see Billing). Inviting the worker to the Worker Portal is a separate action on the placement.
## Templates
The checklist is built from the default agency template, the client's template and the position requirements. Edit them in **Settings → Onboarding**.`, links: [{ label: 'Onboarding templates', to: '/settings/onboarding' }] },
  { slug: 'rates', category: 'Placements & workforce', title: 'Changing pay and bill rates', summary: 'Rates are effective-dated — past economics are never overwritten.', keywords: 'rate change pay bill effective date',
    body: `Add a new rate with an **effective from** date instead of editing the old one. The previous rate is closed the day before.
- Invoices and payroll use the rate that applied on each work date, so a mid-week change produces two invoice lines.
- Rate changes notify Finance and the account manager and are recorded in the audit log.
- Only roles with "Pay & bill rates" permission can see compensation.` },
  { slug: 'monitoring', category: 'Time & monitoring', title: 'Screenshots, activity and privacy', summary: 'What is captured while a worker is clocked in, and how to configure it.', keywords: 'screenshot monitoring activity idle privacy blur policy',
    body: `Each placement has a **monitoring policy** that the worker accepts before their first clock-in.
- Screenshots are taken at a random moment inside each interval, only while clocked in.
- Activity is recorded as counts (keyboard and mouse events) — never what was typed.
- Policies can blur screenshots, hide them from the client, set idle detection and retention.
Manage policies in **Settings → Time Tracking**.`, links: [{ label: 'Monitoring policies', to: '/settings/monitoring' }] },
  { slug: 'timesheets', category: 'Time & monitoring', title: 'Timesheet approval', summary: 'Weekly timesheets, client approval and corrections after approval.', keywords: 'timesheet approve reject client adjustment',
    body: `Timesheets are built weekly (Monday to Sunday) from time entries.
1. The worker submits the week.
2. It is approved by the agency, the client, or both — set per client.
3. Rejections require a reason; the worker fixes and resubmits.
Approved days are locked. Corrections after approval are added as adjustments so invoices and payroll stay consistent.` },
  { slug: 'invoices', category: 'Finance', title: 'Invoicing clients from approved time', summary: 'Generate, send and collect invoices — only approved time is billed.', keywords: 'invoice generate send pay overdue',
    body: `- Generate invoices per client and period; only approved timesheet days that have not been billed are included.
- Each placement gets one line per rate period.
- Sending emails the client a pay link (see the Dev Outbox in this demo). Card payments update the invoice and AR instantly.
- Overdue invoices are flagged daily and can trigger reminder automations.
Numbering, terms and tax defaults are in **Settings → Invoices**.`, links: [{ label: 'Invoice settings', to: '/settings/invoices' }] },
  { slug: 'payroll', category: 'Finance', title: 'Running payroll and payouts', summary: 'Calculate, review, approve and pay workers; retry failed payouts.', keywords: 'payroll payout payslip overtime',
    body: `1. Create a payroll run for a period — it uses approved, unpaid timesheet days and applies overtime rules.
2. Review and approve it (approval is audited).
3. Initiate payouts. Each payout moves through Processing to Paid or Failed; failed items can be retried.
Workers see payslips in the Worker Portal. Pay frequency and overtime rules live in **Settings → Payroll**.`, links: [{ label: 'Payroll settings', to: '/settings/payroll' }] },
  { slug: 'client-portal', category: 'Portals', title: 'What clients can do in the Client Portal', summary: 'Team status, timesheet approval, invoices, candidates and worker requests.', keywords: 'client portal request worker users',
    body: `Client users see only their own company:
- Live team status, hours this week and invoices due.
- Approve timesheets and pay invoices online.
- Review submitted candidates (no contact details) and request interviews.
- **Request a Worker** creates a draft position and notifies the account manager.
- The client owner can invite colleagues with client roles (Manager, Supervisor, Finance, Viewer) and revoke access.
Client users are free — they never count as seats.` },
  { slug: 'worker-portal', category: 'Portals', title: 'The Worker Portal', summary: 'Clock in, timesheets, payslips, training and profile.', keywords: 'worker portal tracker training profile payout',
    body: `Workers use the portal (and its web time tracker) to clock in and out, take breaks, see their schedule and timesheets, download payslips and complete **training**.
In **Profile** they update personal details and a payout account *label* (never full account numbers) — changes are audited and Finance is notified.` },
  { slug: 'roles', category: 'Admin & security', title: 'Roles, permissions and recruiting scope', summary: 'The resource × action × scope matrix and custom roles.', keywords: 'roles permissions scope matrix custom owner',
    body: `Every request is checked on the server against the role's matrix: **resource × action → scope** (All, Team, Assigned, Own).
- Edit system roles or clone them into custom roles in **Settings → Roles & Permissions**. Changes apply on the member's next click — no sign-out needed.
- "Pay & bill rates" controls who can see compensation fields.
- The **last Owner** of an agency can't be removed or demoted, and nobody can edit their own role's permissions.
- Every change is audited and affected members are notified.`, links: [{ label: 'Roles matrix', to: '/settings/roles' }, { label: 'Team', to: '/settings/team' }] },
  { slug: 'invite-team', category: 'Admin & security', title: 'Inviting and managing your team', summary: 'Invitations expire after 7 days and can be resent or revoked.', keywords: 'invite team member resend revoke suspend',
    body: `1. Go to **Settings → Team** and click **Invite member**.
2. Choose a role, recruiting scope and team. The invitee receives a tenant-branded email (Dev Outbox in this demo).
3. Pending invitations can be **resent** (new 7-day link) or **revoked**.
Suspending a member blocks access immediately and revokes their API keys; their history is kept.` },
  { slug: 'audit', category: 'Admin & security', title: 'Reading the audit log', summary: 'Filter by person, action, record and date; compare before and after.', keywords: 'audit log export diff impersonation',
    body: `The audit log is append-only. Open any entry to see a field-by-field **before/after** comparison, the IP address and the reason given.
- Actions performed by VeyroApp support in support mode are marked with the support agent's name.
- Exporting the audit log is itself audited and notifies Owners and Admins.`, links: [{ label: 'Audit log', to: '/settings/audit' }] },
  { slug: 'import', category: 'Admin & security', title: 'Importing data from spreadsheets', summary: 'Map, dry-run, de-duplicate and import with a row-level report.', keywords: 'import csv xlsx migrate duplicate legacy',
    body: `1. Go to **Settings → Import Center**, choose what you're importing and upload a CSV or .xlsx file.
2. Check the column mapping (save it to reuse next time).
3. Run the **dry run**: every row is validated and checked for duplicates by email, phone, domain, name or legacy ID.
4. Start the import. It runs in the background with live progress; you can pause and resume.
5. Download the row report, fix failed rows and **retry** — rows already imported are never duplicated.
Import clients and workers before placements and rates so references resolve. Legacy IDs are preserved on every record.`, links: [{ label: 'Import Center', to: '/settings/import' }] },
  { slug: 'seats', category: 'Billing & plans', title: 'How seat billing works', summary: '$29 per active worker seat per month, metered by seat-day.', keywords: 'billing seat price invoice comped trial',
    body: `- A seat starts when a placement is **activated** and stops when it **ends**.
- Each month is billed by seat-days: (seat-days ÷ days in month) × $29, plus any add-ons, minus discounts, plus tax.
- Client users and candidates are always free.
- Comped accounts still meter seats so you can see usage, but invoices total $0.
If a payment fails you get a 7-day grace period; after that the workspace becomes read-only until paid.`, links: [{ label: 'Billing', to: '/settings/billing' }] },
  { slug: 'white-label', category: 'Billing & plans', title: 'White label: your domain and brand', summary: 'Custom domain, branded emails and removing “Powered by VeyroApp”.', keywords: 'white label domain dns branding powered by',
    body: `On the White Label plan, **Settings → General & Branding** unlocks:
1. A custom portal domain — add the TXT record we show you, then click **Check DNS**.
2. Hiding "Powered by VeyroApp" from portals and emails.
3. Support email/phone and a sign-in headline for your portal.
Your logo, colors and email sender name apply on every plan.`, links: [{ label: 'Branding', to: '/settings' }] },
  { slug: 'integrations', category: 'Integrations & API', title: 'Integrations in this build', summary: 'Every provider is a simulated adapter with status, logs and reconnect.', keywords: 'integration stripe wise quickbooks reconnect error',
    body: `Payments, payouts, accounting, email/SMS/WhatsApp, calendar, e-signature, AI, job boards, background checks and storage are adapters. In this local build they are simulated but behave realistically and log every action.
In **Settings → Integrations** you can test, sync, reconnect, disconnect or simulate an error to see how VeyroApp reacts.`, links: [{ label: 'Integrations', to: '/settings/integrations' }] },
  { slug: 'api-webhooks', category: 'Integrations & API', title: 'API keys and webhooks', summary: 'Call the REST API with a key and receive signed webhooks.', keywords: 'api key webhook hmac signature openapi',
    body: `- Create an API key in **Settings → API & Webhooks** (read-only by default). Send it as \`Authorization: Bearer vk_…\`.
- The full reference is generated from the live server (OpenAPI 3.1).
- Webhook deliveries are signed: compute HMAC-SHA256 of the raw body with your endpoint secret and compare it to the \`x-veyro-signature\` header.
- Failed deliveries retry with backoff; you can replay any delivery from the log.`, links: [{ label: 'API & Webhooks', to: '/settings/api' }, { label: 'API reference', to: '/settings/api/docs' }] },
];
