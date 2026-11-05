# VeyroApp — Build Report

Local build of the full brief (`VEYROAPP_FULL_BUILD_BRIEF.md`) in demo mode. Everything runs on localhost with simulated adapters; no external APIs, no real data.

- **Run it:** `pnpm install && pnpm run setup && pnpm dev` → http://localhost:3100 (API on :4100, Postgres 16 in Docker on :5433). `pnpm setup` is a built-in pnpm command, so the script is `pnpm run setup` (alias `pnpm bootstrap`).
- **Size:** ~16k lines API, ~16k lines web, ~3.7k lines shared/db, 629 REST endpoints under `/api/v1`, 7 SQL migrations.
- **Stack deviations (deliberate, documented in README):** Fastify instead of NestJS, Vite + React Router SPA instead of Next.js, raw SQL migrations + `pg` instead of Drizzle. Same architecture otherwise: versioned REST, domain modules, zod DTO validation, Postgres-backed job queue, SSE realtime, integer-cent money.

## Design handoff applied (`VeyroApp-design-handoff.zip`)
The handoff is written for Next.js + Tailwind; VeyroApp is Vite + React with plain CSS, so the look was ported onto the existing components instead of swapping stacks. Behaviour and data are unchanged.

- **Tokens and type:** canvas `#f4f5f8`, ink `#0f1422`, brand `#4f6bf6` scale, success/warning/danger from `globals.css`; 16px card radius with the lighter card shadow and popover shadow; 22px page titles; 32px KPI numbers; 36px buttons and inputs (8px radius, `ring-4 brand-100` focus); 13–13.5px body type.
- **Staff shell:** canvas gutter with a rounded white app frame (≥1024px), white sidebar with the four-point spark logo, workspace card, "MAIN MENU" / "OTHER" groups, soft active pill with ring, and live count badges (new leads, timesheets awaiting approval, unread inbox). 60px blurred top bar with underlined tabs, a "Search… ⌘K" box, filled Quick Create, bell (filled when unread) and avatar menu. The staff app stays platform blue; only portals re-tint to the tenant color.
- **Navigation:** the handoff's labels and order (Dashboard, Leads & CRM, Recruiting, Workforce, Remote Team, Payroll & Finance, Communications, Documents, Reports & Analytics, Automation; Other: Portals, Settings, Help Center). The top bar shows exactly the handoff's tabs; screens its nav omits (Assessments, Issues, Payouts, Sales and Workforce analytics, and ten extra settings pages) sit under a "More ▾" menu at the end of the tab strip. Old deep links still work. On narrow screens the strip scrolls to the active tab and fades at the edge; below 1536px the search box collapses to its icon and ⌘K hint so tabs have room.
- **Status pills:** 24px tinted pills with ring and dot, using the handoff's tone map (violet review stages, teal hired/converted).
- **Login / register:** the scoped auth design (Manrope, Deep Ink panel, warm page, purple button), with the one-click demo accounts inside the card as "Local demo".
- **Portal chrome:** sticky blurred header with tenant tile, agency name and portal label, underlined links on wide screens and an icon-pill row below 1280px, user menu with role, footer with "Powered by ✦ VeyroApp".
- **New screens the handoff's nav called for:** Portals overview, Workforce → Compliance and Time Off (moved from other modules), Remote Team → Apps & Activity and Clock In (supervisor clock in/out on behalf, reason required, audited), Payroll & Finance → Expenses (worker and team expenses with receipts, approval, payroll reimbursement and client re-billing), and a worker-portal Expenses page.

## §8 status

| § | Area | Status | Notes |
|---|---|---|---|
| 8.1 | Home dashboard | **Done** | Role-aware; data-generated banners (payroll due, overdue invoices, onboarding blockers, late workers); 8 KPIs with deltas, each drilling into the filtered list; Needs Attention; revenue vs payroll, margin by client, funnel, hours by day; My Tasks; activity feed. |
| 8.2 | CRM — Leads | **Done** | Table + Kanban (drag persists + writes Activity); log call/email/meeting; tasks; template email → Dev Outbox; qualify; disqualify (reason required); convert keeps the same Company id, keeps/creates contacts, optional Opportunity + Position, history preserved; duplicate warnings (warn, not block); source analytics (leads → qualified → converted → placements → revenue). CSV import lives in the Import Center. |
| 8.3 | Clients, Contacts, Opportunities, Tasks, Activities | **Done** | Client detail tabs (overview, contacts, hiring, workforce, finance, documents, onboarding requirements, activity); explicit Invite to Portal; two-step audited permanent delete with dependency analysis; contacts with multiple methods; opportunity board (Won activates client + optional Position); tasks with multiple assignees and reminder/overdue jobs; @mentions notify. |
| 8.4 | Positions | **Done** | Full fields, state machine, multiple recruiters with lead flag + history, pipeline kanban, AI matches, sourcing link + QR, onboarding requirements, AI JD draft (never auto-published). |
| 8.5 | Candidates, Applications, Submissions, Talent Pool | **Done** | Persistent candidate, full lifecycle with reasons (blacklist permissioned + audited), filters incl. natural-language search, resume/video/portfolio at top of detail, Analyze Resume with source snippets, Submission pipeline per candidate × position, client-safe profile, clickable funnel. |
| 8.6 | Public application & sourcing | **Done** | Tenant-branded multi-step form with resume prefill + Skip, searchable phone country picker, MediaRecorder video (upload fallback), honest rate-range copy, optional account; personal and position links resolved server-side; duplicates attach a new Application and keep original attribution; notifications; My Sourced metrics; rate-limited. |
| 8.7 | AI recruiting (simulated) | **Done** | Deterministic local adapter: extraction only from source text with snippets + uncertainty flags; Find Best Matches with score breakdown, why/missing, compare, shortlist, submit; runs persisted and marked stale on position change; drafts never sent; failure toggle shows a friendly 503. *Limit:* scanned/CID-font PDFs and DOCX are attached but flagged uncertain rather than parsed. |
| 8.8 | Interviews, assessments, offers, hire | **Done** | meet.veyro.local links, `.ics`, reminders, scorecards; assessments completed in the Candidate Portal (text + file); offers Draft → Approved → Sent → Viewed → Accepted with typed + drawn e-signature, timestamp, IP; accepted offer → prefilled Create Placement (same person). |
| 8.9 | Placements, workforce, onboarding, compliance | **Done** | Effective-dated rates, monitoring policy, Worker 360, onboarding merge (agency + client + position + manual) with source and Required/Optional; activation blocked with the exact missing items, audited override; seat starts on activation; separate explicit portal invite; issues, replacement, offboarding with history preserved. |
| 8.10 | Time tracking & monitoring | **Done** | Web tracker: clock in/out, break, memo, monitoring disclosure, `getDisplayMedia` capture at a random moment per interval (blur per policy), declined → logged + mock desktops, "simulate a workday", activity counts only, idle prompt keep/discard, offline queue with sync indicator, manual time + time-off requests, worker self-delete within window. Manager: Live Now (~8 simulated live workers), Screenshots & Activity timeline + lightbox + flag, Attendance with late/absent detection, weekly timesheets with agency/client approval, reject with reason, post-approval adjustments, retention job. |
| 8.11 | Finance | **Done** | Rates by work date (new row per change, audited); invoices from approved time with one line per rate period, tax/discount/credits/fees, recomputation history, branded PDF, send → pay link → simulated Stripe checkout; credit notes, refunds, write-offs; AR aging; payroll runs with OT, earnings/deductions, idempotency key, audited approval; payslip PDFs; simulated Wise payouts with retry; margin; commission rules (% GP, fixed, time-limited, tiered) with calculated/approved/settled; accounting sync log + reconciliation. Payroll Overview matches the Humaine reference. |
| 8.12 | Portals | **Done** | Client, worker and candidate portals with every nav item from the brief; server-side role gates (external users get 404 on internal APIs). |
| 8.13 | Communications & notifications | **Done** | Inbox threads (internal + client/worker/candidate), versioned templates with merge-variable preview, live bell via SSE, per-user preferences, admin subscriptions, zero-recipient events logged. Browser push is simulated through the Dev Outbox (no real Web Push). |
| 8.14 | Documents & e-signature | **Done** | Attach to any record with visibility, versioned templates → generate → built-in signing page → signed PDF with certificate page; compliance expiry view; signed, permission-checked download URLs. |
| 8.15 | Search, imports, exports | **Done** / *partial* | ⌘K search (permission-filtered, recent items, quick actions); Import Center (mapping, saved mappings, preview, validation, duplicates, dry run, background job with progress, error CSV, idempotent retry, resume) for leads, clients, contacts, candidates, workers, placements, rates; every list exports CSV (audited). *Partial:* XLSX import reads only the first sheet. |
| 8.16 | Analytics, report builder, automation | **Done** | Executive/Recruiting/Sales/Finance/Workforce with date ranges and drill-downs; Report Builder with save/export/schedule (→ Dev Outbox); automation WHEN/IF/DO builder with approval step, test run, enable/disable, run log; all five seeded automations run for real. |
| 8.17 | Settings, platform, SaaS billing, white label | **Done** / *partial* | All 17 settings tabs incl. editable role matrix, last-Owner protection, branding, white label; $29/seat billing from seat-days, trial/standard/white-label, comped, failed payment → grace → suspension; Platform Control Center with agencies, admins, plans, subscriptions, seats, feature flags, provider health, tickets, audited impersonation with banner, system health. *Partial:* custom-domain verification is simulated; white-label support info is stored but only shown in settings. |
| 8.18 | Integrations, API, webhooks | **Done** | Integrations page for every adapter (connect/disconnect/reconnect/test, logs); API keys (create once-shown / revoke), rate-limited; auto-generated OpenAPI JSON + docs page; outbound webhooks with HMAC signatures, retries/backoff, delivery log, replay; local receiver page. |
| 8.19 | Security, reliability, audit | **Done** / *partial* | bcrypt, httpOnly cookies, CSRF token, optional email-code MFA, session list + sign out others, server-side tenant + permission checks everywhere (cross-tenant ids → 404), append-only `audit_events` (DB trigger), rate limits, idempotency keys, retention jobs, health endpoint. *Partial:* MFA uses one-time email codes (via Dev Outbox), not TOTP authenticator apps. |

## Tests

| Suite | Command | Result |
|---|---|---|
| Unit + API (Vitest) | `pnpm test` | **22 / 22 passed** (2 files) |
| End-to-end §13 lifecycle (Playwright, system Chrome) | `pnpm e2e` (needs `pnpm dev`) | **1 / 1 passed** — all 18 steps, ~45 s; green 4 consecutive runs |
| Typecheck (API + web, strict) | `pnpm typecheck` | **0 errors** (shared, db, api, web) |
| Page sweep (every route × role, headless Chrome) | `node scripts/qa-sweep.mjs` | **0 issues** on ~140 routes at 367, 390, 768, 1024, 1280 and 1440 px |

- **Unit/API coverage:** rate selection by date, invoice math (tax, discounts, credits, fees, previous balance), payroll with overtime, commissions (% GP, tiered, time-limited, fixed), half-up rounding, state machines, permission matrix and comp stripping, duplicate normalisation, plus the brief's worked example run through the real invoice/payroll/margin services ($496.00 invoice in two rate-period lines, $208.00 payroll, $288.00 / 58.06% margin, $28.80 and $14.40 commissions), rate change after invoicing, payroll idempotency, payment ≤ balance, and role scoping over HTTP.
- **E2E:** one serial test with a `test.step` per §13 step (1–18). Owner signs in through the real login page; steps are driven through the real HTTP API per user, with browser checks for login landing, public apply page, client-safe candidate view, Live Now, worker payslip, and workspace switching to Harbor Assist and back (no MAGA data visible). Negative tests and the audit-log check (step 17–18) are included. Re-runnable without a DB reset (unique per-run data).
- **Page sweep:** visits every agency, portal and public route as the right role and fails on console errors, 5xx responses, rendered `null`/`undefined`/`NaN`/`Invalid Date`/`[object Object]`, "Coming soon", error states, 404 pages, and horizontal page scroll.

## Screenshots (`docs/screenshots`)
Login · Home · Leads board · Candidate detail · Position matches · Placement onboarding · Live Now · Screenshots timeline · Timesheet approval · Invoice PDF · Payroll Overview · Worker Tracker · Client Portal · Platform Control Center (`01-…` to `14-…`), plus the new Expenses, Clock In, Apps & Activity and Portals screens (`15-…` to `18-…`). Regenerate with `node scripts/screenshots.mjs`.

## Bugs found and fixed during integration
- Chart Y-axis used unsupported expression strings, so the payroll trend line nearly vanished; numeric API strings were concatenated when sizing bars. Charts now coerce to numbers and compute a real domain.
- A hidden "Actions" header label (absolutely positioned) escaped table scroll containers and made many list pages scroll sideways; tables are now the positioned container.
- Long text and fixed-width snippets overflowed phone screens; mobile cards now wrap and cap widths.
- Portal users triggered 404s because every table filter fetched the staff list; only member filters fetch it now.
- The logged-out session probe returned 401 (console error on every public page); it now returns an anonymous result.
- Raw ISO dates in banners, notifications, timelines and the tracker are now human-formatted.
- The seed pointed 40% of candidates at a non-existent intro video; removed.
- (E2E) Inviting a hired candidate who already had a candidate-portal login to the Worker Portal was wrongly refused; fixed in `workforce-placements.ts`.

## Known issues and next steps
- **E2E is API-driven with UI spot checks**, not full click-through for every step. Screen capture and video recording can't be driven headlessly, so the test uploads a PNG and a webm in their place.
- **Login rate limit** (10 per email per 5 min) means running the E2E or sweeps many times back to back returns 429; wait or clear `rate_limits` in the dev DB.
- **Dates use the server's UTC day** for "today" and month boundaries on dashboards; per-org timezones are used for attendance only.
- **Custom-field filters** exist (`/api/v1/custom-fields/match`) but list pages don't expose `cf_*` filters yet.
- **Resume parsing** doesn't OCR scanned PDFs or read DOCX (flagged as uncertain).
- **Previous balance** on invoices is a manual field; **late fees** are a manual action.
- **Interview reminders** fire once and aren't re-armed after a reschedule.
- **SaaS invoices** are generated on demand from the Platform Control Center (the grace → suspension sweep runs automatically).
- **Lighthouse accessibility** scores were not measured. Inputs have labels and icon buttons have aria-labels, but there's no audit run.
- **Next:** OCR for resumes, TOTP MFA, custom-field list filters, org-timezone dashboards, a scheduled monthly SaaS invoice job, and a full click-through E2E.
