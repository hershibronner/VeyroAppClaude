# VeyroApp — Architecture & Conventions (read fully before writing code)

Product brief (source of truth for features): `VEYROAPP_FULL_BUILD_BRIEF.md` (kept outside this repo).
Repo root: the folder containing this `docs/` directory (path contains spaces — always quote it).

## Running system (already up — do NOT start, stop, or restart it)
- `pnpm dev` is running: API (Fastify via `tsx watch`) on :4100, web (Vite + React) on :3100 (proxies `/api` and `/files` to :4100).
- `tsx watch` restarts the API whenever any API file changes; Vite hot-reloads the web.
- Postgres 16 in Docker on :5433 (`postgres://veyro:veyro@127.0.0.1:5433/veyro`). Query with `docker exec veyroapp-db psql -U veyro -c "..."`.
- Dev server log: wherever you redirect `pnpm dev` output — check it after edits; the API prints `✖ module X failed to load` if your module throws on import, and lists loaded modules on boot.
- **Never run `pnpm db:reset` or `pnpm setup`** (other builders work against the same DB concurrently). Schema changes go in a new migration and are applied with `pnpm db:migrate`.
- Do not use the in-app browser pane (it is shared). Verify with curl + typecheck. The integrator does visual QA.

### Calling the API with curl
```bash
J=/tmp/veyro-<yourarea>.jar
curl -s -c $J -H 'content-type: application/json' -d '{"email":"owner@veyro.demo","password":"demo1234"}' localhost:4100/api/v1/auth/login
CSRF=$(curl -s -b $J localhost:4100/api/v1/auth/me | node -pe 'JSON.parse(require("fs").readFileSync(0)).csrf')
curl -s -b $J localhost:4100/api/v1/<path>
curl -s -b $J -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{...}' localhost:4100/api/v1/<path>
```
Demo users (password `demo1234`): owner@ (Ava, Owner of MAGA Hire + Harbor Assist), recruiter@ (Noah, recruiter, scope=assigned), sales@ (Lena), finance@ (Mark), am@ (Priya, account manager), client@ (Dana Fox, client_owner at Brightline Dental), worker@ (Jose Ramirez, worker at Brightline), candidate@ (Maria Santos, candidate in `assessment`), platform@ (platform admin, no tenant). All `@veyro.demo`. More staff: sam.rivera@, elena.petrova@, omar.haddad@, grace.liu@ (hr), tom.becker@, jade.morgan@, ben.carter@; Harbor: rosa.delgado@, kwame.mensah@, iris.novak@.

## Layout
```
apps/api/src/core/        shared API infrastructure (DO NOT EDIT — see "Core changes")
apps/api/src/adapters/    messaging.ts (Dev Outbox). Add your adapter files here (new files only).
apps/api/src/jobs/queue.ts job queue: registerJob / enqueue / every
apps/api/src/modules/     ONE OR MORE FILES PER AREA, auto-loaded (files starting with "_" are not loaded; use apps/api/src/modules/_<area>/ for helpers)
apps/web/src/components/  ui.tsx, DataTable.tsx, charts.tsx, Timeline.tsx, FormDrawer.tsx, Shell.tsx, QuickCreate.tsx (DO NOT EDIT)
apps/web/src/lib/         api.ts, auth.tsx, hooks.ts, format.ts, toast.tsx, nav.ts, realtime.ts (DO NOT EDIT)
apps/web/src/modules/<area>/  your pages + route manifests
apps/web/src/quick/<area>.tsx Quick Create (+) entries for your entities
packages/shared/src/      money/rates/finance/statemachines/permissions/time/mockscreen (import from '@veyro/shared')
packages/db/migrations/   SQL migrations. 0001_core.sql has the full schema — READ IT, most tables you need already exist.
packages/db/seed/         demo seed (index.ts). Area seeds: packages/db/seed/areas/<area>.ts
```

## API conventions (Fastify + zod + pg, raw SQL)
Module file shape:
```ts
// apps/api/src/modules/crm-leads.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx, insertRow, updateRow } from '../core/db';
import { staff, auth, need, can, scopeOf, redact, assertTransition, getOr404 } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles, subscribers } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit, onEvent } from '../core/events';
import { enqueue, registerJob, every } from '../jobs/queue';
import { sendMessage, sendTemplate } from '../adapters/messaging';
import { saveFile, signedUrl, readFile } from '../core/storage';
import { getSetting, setSetting, WEB_URL } from '../core/settings';
import { publishOrg, publishUser } from '../core/realtime';
import { rateLimit } from '../core/ratelimit';

export default async function (app: FastifyInstance) {
  app.get('/api/v1/leads', async (req) => {
    const ctx = staff(req);               // internal agency users only (client/worker/candidate → 404)
    need(ctx, 'leads', 'view');           // throws 404 for view, 403 for others
    const lp = listParams(req);           // page, pageSize, search, sort, dir, filters (all other query params)
    const where = ['c.organization_id = $1', "c.stage IN ('lead','qualified')"]; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`c.lead_status = $${params.length}`); }
    return paged({ select: 'c.*, u.name owner_name', from: 'companies c LEFT JOIN users u ON u.id=c.owner_id', where, params, lp,
      searchCols: ['c.name', 'c.domain'], sortMap: { name: 'c.name', score: 'c.lead_score', created_at: 'c.created_at' }, defaultSort: 'c.created_at DESC' });
  });
  app.post('/api/v1/leads/:id/qualify', async (req) => { /* need(...,'edit'); assertTransition('lead_status', from, to); updateRow; activity(...); audit(...) if sensitive */ });
}
```
Rules:
- **Tenant isolation**: every query filters `organization_id = ctx.orgId`. Never accept organizationId/role/recruiterId-as-authority from the body. Load records with `getOr404(table, ctx, id)` → cross-tenant ids return 404.
- Lists return `{ rows, total, page, pageSize }` via `paged()` — the web `DataTable` expects exactly this and sends `search, sort, dir, page, pageSize` + filter keys as query params. Support `pageSize` up to 5000 (export).
- Validate bodies with zod (`.parse` → 400 with field errors automatically).
- State changes: `assertTransition(machine, from, to)` (409 on invalid), then write an `activity(...)` on the record; sensitive actions also `audit(ctx, action, {type,id,label}, before, after, reason)`.
- Compensation fields (pay/bill rates, salaries, rate expectations): only return when `canViewComp(ctx)`/`can(ctx,'rates','view_comp')`; otherwise strip (`redact(ctx,row)`).
- Recruiter scope: `ctx.recruitingScope` ('all'|'team'|'assigned') + `scopeOf(ctx,'positions','edit')`. 'assigned' = user has an active row in `position_recruiter_assignments` (unassigned_at IS NULL).
- Portal endpoints live under `/api/v1/portal/client/...`, `/api/v1/portal/worker/...`, `/api/v1/portal/candidate/...`. Use `auth(req)` and require `ctx.role.kind === 'client'|'worker'|'candidate'` (else 404); scope by `ctx.companyId` / `ctx.workerId` / `ctx.candidateId`. External users must never reach internal endpoints (`staff()` already blocks them).
- Public (no-login) endpoints: `app.get(path, { config: { public: true } }, handler)`. Rate-limit public writes with `rateLimit(key, max, windowSec)`.
- Money is integer cents + currency everywhere. Use `@veyro/shared` (linesByRate, computePayroll, invoiceTotals, computeCommission, rateForDate, planRateInsert, amountForMinutes, divRoundHalfUp, formatMoney). Never floats for money.
- Dates: DATE columns come back as 'YYYY-MM-DD' strings; timestamptz as Date objects (JSON → ISO).
- Notifications: `notify(orgId, userIds, { event, title, body, link })` (link = web path). It pushes live via SSE. Recipients per brief §11/§8.13.
- Messaging: `sendTemplate(orgId, templateKey, toEmail, vars, { related: { type, id } })` → lands in Dev Outbox + timeline. Template keys seeded: see `packages/db/src/orgDefaults.ts` (EMAIL_TEMPLATES).
- Events: `emit(orgId, 'placement.started', payload)`. Payload conventions: include ids AND display names: `{ worker_id, worker_name, placement_id, company_id, company_name, account_manager_id, recruiter_id, ... }`. Listeners: `onEvent('name', async (orgId, event, payload) => {...})`.
- Background work: `registerJob(kind, handler)` + `enqueue(kind, payload, { orgId, runAt, dedupeKey })`; recurring: `every(name, ms, fn)` (runs in-process ~1s tick).
- Realtime: `publishOrg(orgId, 'presence'|'screenshot'|'timesheet'|'payout'|'invoice'|'job', data)`; web subscribes via `realtime.on(event, fn)`.
- Files: `saveFile(subdir, filename, buffer)` → relative path; return `signedUrl(path)` only after a permission check. Multipart: `const f = await req.file(); const buf = await f.toBuffer();` (or `req.parts()`).
- Settings: `getSetting(orgId, 'payroll'|'invoice'|'ai'|'time_tracking'|'portals'|'security')`.
- Errors: throw `badRequest/forbidden/notFound/conflict` from core/errors.
- Every timeline-capable entity can use the generic endpoints `GET/POST /api/v1/timeline/:type/:id` (types: company, contact, opportunity, position, candidate, placement, worker, invoice, task, payroll_run, offer, interview, submission, timesheet, document).
- `GET /api/v1/members` = org staff for pickers. `GET /api/v1/qr?text=...` = PNG QR code.

## Web conventions (React 18 + react-router 6 + Recharts + lucide-react)
Route manifests (eagerly imported, pages lazy-loaded inside):
```tsx
// apps/web/src/modules/crm/index.tsx
import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
const Leads = lazy(() => import('./Leads'));
export const routes: RouteObject[] = [{ path: '/crm/leads', element: <Leads /> }, { path: '/crm/leads/:id', element: <LeadDetail /> }];
// optional: apps/web/src/modules/<area>/portal.tsx
export const portalRoutes = { client: [{ path: 'team', element: <ClientTeam /> }], worker: [...], candidate: [...] }; // index route: { index: true, element }
// optional: apps/web/src/modules/<area>/public.tsx  (no auth, no shell)
export const publicRoutes: RouteObject[] = [{ path: '/apply/:slug', element: <Apply /> }];
// Quick Create: apps/web/src/quick/<area>.tsx
export const quickCreate: QuickCreateDef[] = [{ key: 'lead', label: 'Lead', icon: <Target size={16}/>, perm: ['leads'], order: 10, render: close => <LeadForm open onClose={close} onSaved={...} /> }];
```
The agency sub-tab paths are fixed in `apps/web/src/lib/nav.ts` — implement exactly those paths. Portal nav paths are fixed in `apps/web/src/portals/PortalShell.tsx` (PORTAL_NAV).

Components (import from `../../components/...`):
- `ui.tsx`: Button(variant primary|outline|ghost|danger|dark|success, size sm|xs, icon, loading), Card, CardHeader, PageHeader(title, sub, actions, back=fallbackPath), BackButton, Banner(tone info|warn|danger|success), KpiRow(items: {label, value, icon, delta, deltaText, suffix, to}), Delta, StatusPill(status) (auto colors: green Paid/Active…, amber Pending…, red Overdue…, gray Draft, blue Open/New), Avatar, Person(name, sub), Tabs, Segmented, Drawer, Dialog, useConfirm() (`const confirm = useConfirm(); const r = await confirm({ title, body, danger, reason: {label, required}, typeToConfirm: 'DELETE' }); if (!r.ok) return; r.reason`), Menu(items: {label, icon, onClick, danger, disabled, sep, hidden}), Field, SearchInput, TagInput, MoneyInput (cents), MemberSelect, EntitySelect(endpoint, labelOf), PhoneInput (searchable country picker), DateRangePicker/presetRange, RangeSelect ("Last 6 months"), EmptyState, ErrorState, PermissionDenied, Skeleton, LoadingBlock, Async, Boundary (wrap each widget so one failure never blanks a page), KV, Meter.
- `DataTable.tsx`: `<DataTable title endpoint columns filters rowLink rowActions bulkActions toolbar exportName params />` — server-side search/sort/filter/paging, URL state, checkbox column (desktop) + long-press select (mobile), mobile stacked cards (column `mobile: 'title'|'subtitle'|'meta'|'hidden'`), CSV export (audited), empty/loading/error states. `opts(['a','b'])` builds filter options.
- `charts.tsx`: TrendLine (line + dots + dark tooltip), TrackBars (rounded bars with light track), Funnel, SimpleBars, SoftArea, ChartCard(title, big, delta, control), fmtMoney/fmtMoneyCompact/fmtNum/fmtHours.
- `Timeline.tsx`: `<Timeline type="company" id={id} />` (activity feed + composer with @mentions).
- `FormDrawer.tsx`: `<FormDrawer open onClose title fields={FieldDef[]} initial onSubmit={async v => api.post(...)} />` (field types: text,email,url,number,money,date,time,datetime,select,textarea,member,entity,tags,checkbox,phone,custom); shows server field errors.
- `lib/api.ts`: `api.get/post/patch/put/del/upload`, `qs()`. `lib/hooks.ts`: `useApi(url, deps)` → {data, error, loading, reload, setData}, useDebounced, useInterval. `lib/format.ts`: money(cents), hours(min), pct, date, shortDate, dateTime, relTime, duration, fullName, humanize, dash, todayISO, addDaysISO, downloadText, toCsv. `lib/toast.ts`: `toast.success(msg) / toast.error(err)`. `lib/auth.tsx`: `useAuth()` → { me, can(resource, action), scope(), switchOrg }, `useWorkspace()`.
- CSS: use existing classes in `apps/web/src/styles.css` (card, card-h, card-b, grid-2/3/4, grid-main-side, kpis, kpi-tiles, kanban/kcol/kcard, table, pill-*, detail-head, kv, checklist-item, shot-grid/shot/lightbox, big-timer, clock-btn, stack, row, muted, small, money…). If you need more CSS, create `apps/web/src/modules/<area>/<area>.css` with area-prefixed class names and import it from your pages.

### UX rules (from brief §5 — graded)
- Page pattern like the Humaine reference: PageHeader (big title, right: date-range, outline secondary button, ONE primary button) → data-driven Banner → KpiRow (every KPI clickable → exact filtered list via URL query, e.g. `/crm/leads?status=qualified`) → chart cards → table card.
- List toolbar: Title | Search | Filter | Add | More. Detail pages: compact header (name, status pill, owner, key contact) + 1–2 primary actions; everything else under a `Menu` ("More"). Never duplicate an action in header and tab.
- Every number is computed from the DB. No hardcoded numbers, no "Coming soon", no dead buttons/links, never render `null`/`undefined`/raw UUIDs — show human names, "—" for missing.
- Loading (Skeleton), empty (EmptyState), error (ErrorState + retry), permission-denied, validation (field errors), partial failure (wrap widgets in `<Boundary>`).
- Responsive at 367/390/768/1024/1280/1440. Use the grid classes (they collapse) and DataTable (mobile cards).
- Accessibility: labels on inputs (`Field htmlFor`), aria-labels on icon buttons.

## Database
- Read `packages/db/migrations/0001_core.sql` first. Key facts:
  - `companies` is both lead and client (stage lead|qualified|client|inactive; lead_status new|contacted|qualified|unqualified|converted). Same record throughout.
  - `candidates` (person) ⟷ `workers` (1:1 via candidate_id; same person). Name/email/phone live on candidates.
  - `placements` + effective-dated `placement_rates` (never UPDATE amounts; closing a prior row's effective_to is allowed when inserting a new one — use `planRateInsert`).
  - `time_entries` → weekly `timesheets` → on approval an immutable snapshot `timesheet_days(minutes per work_date)`. `timesheet_days.invoice_id` / `payroll_item_id` mark billed/paid days (prevents double invoicing/pay). Only approved/locked timesheet days feed invoices, payroll, margin, commissions.
  - `worker_presence` = live clock-in state. `screenshots.file` is a storage-relative path (seeded mock files at `mock/mock-N.svg`).
  - `audit_events` is append-only (trigger blocks UPDATE/DELETE).
- New migration file names by area range: crm `0100_*`–`0199_*`, recruiting `0200_*`, workforce/time `0300_*`, finance `0400_*`, insights/ops `0500_*`, admin/platform `0600_*`. Apply: `pnpm db:migrate` (from repo root). Additive only (ADD COLUMN / CREATE TABLE / CREATE INDEX); never drop or rename existing columns.
- Area seed data (if your features need demo data the core seed lacks): `packages/db/seed/areas/<area>.ts` exporting `export default async function (c: PoolClient) {}` — MUST be idempotent (check before insert) and work for any org (loop over organizations). Apply now with `pnpm --filter @veyro/db exec tsx seed/run-area.ts <area>`; it also runs automatically on future full reseeds.

## Core changes
Do not edit files in `apps/api/src/core`, `apps/api/src/server.ts`, `apps/api/src/jobs`, `apps/api/src/adapters/messaging.ts`, `apps/web/src/{components,lib,portals,pages}`, `App.tsx`, `main.tsx`, `styles.css`, `packages/shared/src/*` (existing files), or `packages/db/seed/index.ts`. If you truly need a core change, keep it minimal and additive, and list it explicitly in your final report. You may add NEW files to `packages/shared/src/<area>/...` (import via `@veyro/shared/src/<area>/file`).

## Verifying your work
- API types: `cd apps/api && npx tsc -p . 2>&1 | grep -E 'modules/(<yourfiles>)|adapters/<yours>'` (others' in-progress files may show errors — only fix yours).
- Web types: `cd apps/web && npx tsc -p . 2>&1 | grep 'src/modules/<area>\|src/quick/<area>'`.
- Exercise every endpoint you write with curl as the right demo user, including negative cases (wrong role → 403/404, cross-tenant id → 404, invalid transition → 409).
- Check the dev log for module load errors after each change.

## Final report (your last message)
Concise: files created, endpoints, pages/routes, what is fully working, what is partial/missing (honest), any core changes made or needed, any cross-area contract you depend on or provide.
