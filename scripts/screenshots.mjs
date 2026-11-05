// Captures the brief §15 screenshots into docs/screenshots (needs `pnpm dev` running).
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const BASE = 'http://localhost:3100', OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });
const psql = (sql) => execSync(`docker exec veyroapp-db psql -U veyro -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const org = psql("SELECT id FROM organizations WHERE slug='maga-hire'");
const cand = psql(`SELECT c.id FROM candidates c WHERE c.organization_id='${org}' AND c.status='qualified' AND c.resume_text IS NOT NULL ORDER BY c.created_at LIMIT 1`);
const pos = psql(`SELECT p.id FROM positions p WHERE p.organization_id='${org}' AND p.status='open' ORDER BY (SELECT count(*) FROM candidates c WHERE c.organization_id=p.organization_id) DESC, p.created_at LIMIT 1`);
const pl = psql(`SELECT id FROM placements WHERE organization_id='${org}' AND status='onboarding' ORDER BY start_date LIMIT 1`);
const ts = psql(`SELECT id FROM timesheets WHERE organization_id='${org}' AND status='submitted' ORDER BY week_start DESC LIMIT 1`);
const inv = psql(`SELECT id FROM invoices WHERE organization_id='${org}' AND status IN ('sent','overdue','paid') ORDER BY issue_date DESC LIMIT 1`);
const browser = await chromium.launch({ channel: 'chrome' });
async function as(email, shots) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  if (email) { await p.goto(BASE + '/login'); await p.fill('#email', email); await p.fill('#password', 'demo1234'); await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/login')), p.click('button[type=submit]')]); }
  for (const [name, path, act] of shots) {
    await p.goto(BASE + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
    if (act) { await act(p); await p.waitForTimeout(1500); }
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  }
  return ctx;
}
await (await as(null, [['01-login', '/login']])).close();
const owner = await as('owner@veyro.demo', [
  ['02-home', '/'], ['03-leads-board', '/crm/leads?view=kanban'], ['04-candidate-detail', `/recruiting/candidates/${cand}`],
  ['05-position-matches', `/recruiting/positions/${pos}?tab=matches`, async p => { await p.getByRole('button', { name: 'Run matching' }).first().click(); await p.waitForTimeout(2500); }],
  ['06-placement-onboarding', `/workforce/placements/${pl}?tab=onboarding`], ['07-live-now', '/time/live'], ['08-screenshots-timeline', '/time/screenshots'],
  ['09-timesheet-approval', `/time/timesheets/${ts}`], ['11-payroll-overview', '/finance/payroll'],
]);
// Invoice PDF: download via the authenticated API and convert page 1 to PNG with macOS sips.
const pdf = await owner.request.get(`${BASE}/api/v1/invoices/${inv}/pdf`);
fs.writeFileSync(`${OUT}/10-invoice.pdf`, await pdf.body());
try { execSync(`sips -s format png "${OUT}/10-invoice.pdf" --out "${OUT}/10-invoice-pdf.png"`, { stdio: 'ignore' }); } catch { /* sips unavailable */ }
await owner.close();
await (await as('worker@veyro.demo', [['12-worker-tracker', '/portal/worker/tracker']])).close();
await (await as('client@veyro.demo', [['13-client-portal', '/portal/client']])).close();
await (await as('platform@veyro.demo', [['14-platform-control-center', '/platform']])).close();
await browser.close();
console.log('screenshots:', fs.readdirSync(OUT).join(', '));
