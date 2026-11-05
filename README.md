# VeyroApp — *Run your staffing company.*

A multi-tenant staffing operating system: CRM & leads, recruiting (ATS + public applications + simulated AI),
placements & onboarding, web time tracker with desk screenshots, timesheets, invoicing, payroll, payouts,
margin & commissions, documents & e-signature, messaging, automations, analytics, client / worker / candidate
portals and a platform control center — running entirely on localhost in **demo mode** (every external
service is a simulated adapter; no real APIs, no real data).

**MAGA Hire** is only the first demo tenant. **Harbor Assist** is a second agency with different branding.

## Quick start (macOS)
Requirements: Node 20+ (tested on 24), pnpm 9+ (tested on 12), Docker Desktop running.
```bash
pnpm install
pnpm run setup   # starts Postgres 16 (Docker, :5433), runs migrations, seeds demo data
pnpm dev         # web on http://localhost:3100, API on http://localhost:4100
```
> Note: on pnpm, `pnpm setup` is a built-in pnpm command, so use `pnpm run setup` (or `pnpm bootstrap`).

Other scripts: `pnpm test` (unit + API tests, Vitest), `pnpm e2e` (Playwright lifecycle test; needs `pnpm dev` running),
`pnpm typecheck`, `pnpm db:migrate`, `pnpm db:reset` (drop + migrate + reseed).

## Demo accounts (password `demo1234`, one-click buttons on the login page)
| Email | Who | Lands on |
|---|---|---|
| owner@veyro.demo | Ava Stern — Owner of MAGA Hire **and** Harbor Assist | Home |
| recruiter@veyro.demo | Noah Kim — Recruiter (scope: Assigned) | Recruiting |
| sales@veyro.demo | Lena Ortiz — Sales | CRM → Leads |
| finance@veyro.demo | Mark Chen — Finance / Payroll | Finance |
| am@veyro.demo | Priya Shah — Account Manager | Workforce |
| client@veyro.demo | Dana Fox — Client Owner, Brightline Dental | Client Portal |
| worker@veyro.demo | Jose Ramirez — active remote VA | Worker Portal → Time Tracker |
| candidate@veyro.demo | Maria Santos — applicant | Candidate Portal |
| platform@veyro.demo | VeyroApp Platform Admin | Platform Control Center |

Simulated services: emails/SMS/WhatsApp land in the **Dev Outbox** at http://localhost:3100/dev/outbox (invitation,
password-reset and MFA links work from there). Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` declines.

## Architecture
```
apps/web          Vite + React 18 SPA (agency app, portals, public apply/pay/sign pages, platform console, dev outbox)
apps/api          Fastify REST API under /api/v1, domain modules, Postgres job queue, simulated adapters, SSE realtime
packages/db       SQL migrations, demo seed, per-org defaults (roles, templates, automations, integrations)
packages/shared   money (integer cents), effective-dated rates, invoice/payroll/commission math, state machines, permission matrix
storage/          local file storage (served via signed, expiring URLs)
```
- **Tenancy & security**: every request resolves session → user → active membership → role → permission matrix on the server;
  every tenant query is scoped by `organization_id`; cross-tenant ids return 404. httpOnly session cookie + CSRF token,
  bcrypt passwords, optional email-code MFA, rate limits (login, public apply, API keys), append-only `audit_events` (DB trigger).
- **Money** is integer minor units with explicit currency; rounding is half-up per line. Rates are effective-dated and never overwritten.
- **Approved time is the financial bridge**: timesheet approval snapshots minutes per day (`timesheet_days`), which feed invoices and payroll exactly once.
- **Adapters** (`apps/api/src/adapters`): payments (Stripe sim), payouts (Wise sim), accounting (QuickBooks sim), messaging (Dev Outbox), AI (deterministic local), storage (local disk).
- See `docs/ARCHITECTURE.md` (conventions) and `docs/CONTRACTS.md` (how the areas hand off along the lifecycle).

### Deviations from the suggested stack (documented)
- **API: Fastify instead of NestJS** — same versioned REST API (`/api/v1`), domain modules, zod DTO validation; far less boilerplate.
- **Web: Vite + React Router SPA instead of Next.js App Router** — instant dev startup on :3100; all screens are client-rendered.
- **DB access: raw SQL migrations + `pg` instead of Drizzle** — real ordered migrations in `packages/db/migrations`.
