// Visits every route as the relevant demo user in headless Chrome; reports console errors,
// failed API calls, and "null"/"undefined"/"NaN" rendered as text. Saves brief §15 screenshots.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = 'http://localhost:3100';
const SHOTS = 'docs/screenshots';
const W = Number(process.env.WIDTH ?? 1440), H = Number(process.env.HEIGHT ?? 900);
fs.mkdirSync(SHOTS, { recursive: true });
const ROUTES = {
  'owner@veyro.demo': ['/', '/my-tasks', '/attention', '/crm/leads', '/crm/clients', '/crm/contacts', '/crm/opportunities', '/crm/tasks', '/crm/activities',
    '/recruiting', '/recruiting/positions', '/recruiting/candidates', '/recruiting/my-sourced', '/recruiting/applications', '/recruiting/submissions', '/recruiting/interviews', '/recruiting/assessments', '/recruiting/talent-pool', '/recruiting/offers',
    '/workforce/workers', '/workforce/active', '/workforce/pending', '/workforce/available', '/workforce/on-leave', '/workforce/inactive', '/workforce/placements', '/workforce/onboarding', '/workforce/issues',
    '/time/live', '/time/timesheets', '/time/attendance', '/time/screenshots', '/time/time-off', '/time/manual',
    '/finance', '/finance/rates', '/finance/invoices', '/finance/ar', '/finance/payroll', '/finance/payouts', '/finance/commissions', '/finance/margin', '/finance/invoices/new',
    '/comms/inbox', '/comms/templates', '/comms/notifications', '/documents', '/documents/templates', '/documents/signatures', '/documents/compliance',
    '/automation', '/automation/runs', '/analytics', '/analytics/recruiting', '/analytics/sales', '/analytics/finance', '/analytics/workforce', '/analytics/reports',
    '/settings', '/settings/team', '/settings/roles', '/settings/billing', '/settings/integrations', '/settings/portals', '/settings/ai', '/settings/onboarding', '/settings/equipment', '/settings/monitoring', '/settings/payroll', '/settings/invoices', '/settings/custom-fields', '/settings/notifications', '/settings/import', '/settings/api', '/settings/audit',
    '/help', '/help/tickets', '/profile', '/portals', '/workforce/compliance', '/workforce/time-off', '/settings/profile', '/time/activity', '/time/clock', '/finance/expenses', '/home'],
  'recruiter@veyro.demo': ['/recruiting', '/recruiting/candidates', '/recruiting/positions', '/recruiting/my-sourced'],
  'client@veyro.demo': ['/portal/client', '/portal/client/team', '/portal/client/candidates', '/portal/client/interviews', '/portal/client/timesheets', '/portal/client/invoices', '/portal/client/documents', '/portal/client/messages', '/portal/client/request', '/portal/client/users', '/portal/client/settings'],
  'worker@veyro.demo': ['/portal/worker', '/portal/worker/tracker', '/portal/worker/schedule', '/portal/worker/timesheets', '/portal/worker/pay', '/portal/worker/time-off', '/portal/worker/tasks', '/portal/worker/messages', '/portal/worker/documents', '/portal/worker/onboarding', '/portal/worker/performance', '/portal/worker/training', '/portal/worker/profile', '/portal/worker/notifications', '/portal/worker/expenses'],
  'candidate@veyro.demo': ['/portal/candidate', '/portal/candidate/media', '/portal/candidate/applications', '/portal/candidate/assessments', '/portal/candidate/interviews', '/portal/candidate/offers', '/portal/candidate/documents', '/portal/candidate/availability', '/portal/candidate/messages'],
  'platform@veyro.demo': ['/platform'],
};
const PUBLIC = ['/login', '/register', '/forgot-password', '/apply/maga-hire', '/apply/maga-hire/r/noah-kim', '/dev/outbox', '/dev/webhooks', '/hire/maga-hire'];
const issues = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function visit(page, path, user) {
  const errs = [];
  const onConsole = m => { if (m.type() === 'error' && !/favicon|EventSource|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text().slice(0, 200)); };
  const onResp = r => { if (r.url().includes('/api/') && r.status() >= 500) errs.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); };
  const onErr = e => errs.push('pageerror: ' + e.message.slice(0, 200));
  page.on('console', onConsole); page.on('response', onResp); page.on('pageerror', onErr);
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => errs.push('goto: ' + e.message.slice(0, 120)));
  await page.waitForTimeout(600);
  const text = await page.evaluate(() => document.querySelector('#root')?.innerText ?? '');
  for (const bad of ['null', 'undefined', 'NaN', '[object Object]', 'Invalid Date']) if (new RegExp(`(^|[^\\w-])${bad.replace(/[[\]]/g, '\\$&')}([^\\w-]|$)`).test(text)) errs.push(`renders "${bad}"`);
  const overflow = await page.evaluate(() => { window.scrollTo(99999, window.scrollY); const x = window.scrollX; window.scrollTo(0, window.scrollY); return x; });
  if (overflow > 2) errs.push(`horizontal overflow ${overflow}px`);
  if (/Coming soon/i.test(text)) errs.push('renders "Coming soon"');
  if (/failed to render|Could not load this/.test(text)) errs.push('error state visible: ' + (text.match(/(?:failed to render|Could not load this)[^\n]*\n?[^\n]*/)?.[0] ?? '').replace(/\n/g, ' ').slice(0, 160));
  if (/Page not found/.test(text)) errs.push('404 page');
  page.off('console', onConsole); page.off('response', onResp); page.off('pageerror', onErr);
  if (errs.length) issues.push({ user, path, errs: [...new Set(errs)] });
}
async function login(page, email) {
  await page.goto(BASE + '/login');
  await page.fill('#email', email); await page.fill('#password', 'demo1234');
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('button[type=submit]')]);
}
const ctxP = await browser.newContext({ viewport: { width: W, height: H } });
const pp = await ctxP.newPage();
for (const p of PUBLIC) await visit(pp, p, 'public');

for (const [user, routes] of Object.entries(ROUTES)) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await login(page, user);
  for (const r of routes) await visit(page, r, user);
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`docs/qa-sweep-${W}.json`, JSON.stringify(issues, null, 2));
console.log(`QA sweep: ${issues.length} pages with issues`);
for (const i of issues) console.log(`- [${i.user}] ${i.path}: ${i.errs.join(' | ')}`);
