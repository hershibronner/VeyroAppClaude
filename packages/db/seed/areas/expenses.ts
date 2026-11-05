// FINANCE — Expenses demo data: realistic worker expense claims (with receipts) across every status over the last ~2 months.
// Idempotent (skips orgs that already have expenses) and tenant-agnostic (loops over every organization).
import type { PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STORAGE_DIR } from '../../src/index';

type Tpl = { category: string; description: string; vendor: string; cents: number; billable?: boolean };
const TEMPLATES: Tpl[] = [
  { category: 'software', description: 'Grammarly Premium — monthly subscription', vendor: 'Grammarly Inc.', cents: 3000 },
  { category: 'software', description: 'Canva Pro for client social posts', vendor: 'Canva Pty Ltd', cents: 1499, billable: true },
  { category: 'software', description: 'Zoom Pro — client calls', vendor: 'Zoom Video Communications', cents: 1599 },
  { category: 'equipment', description: 'USB noise-cancelling headset', vendor: 'Logitech Store', cents: 6499 },
  { category: 'equipment', description: 'Second monitor (24") for scheduling dashboards', vendor: 'Best Buy', cents: 15999, billable: true },
  { category: 'equipment', description: 'Ergonomic keyboard and mouse', vendor: 'Amazon', cents: 7850 },
  { category: 'internet', description: 'Home fiber internet — monthly', vendor: 'PLDT Home Fiber', cents: 3500 },
  { category: 'internet', description: 'Backup mobile hotspot data plan', vendor: 'Globe Telecom', cents: 1200 },
  { category: 'travel', description: 'Rideshare to client onsite training', vendor: 'Uber', cents: 2875, billable: true },
  { category: 'travel', description: 'Train fare to quarterly client review', vendor: 'Amtrak', cents: 8400, billable: true },
  { category: 'training', description: 'Dental billing & coding course', vendor: 'Udemy', cents: 1999, billable: true },
  { category: 'training', description: 'HIPAA compliance certification', vendor: 'HIPAA Exams', cents: 2995 },
  { category: 'other', description: 'Printing and shipping signed patient forms', vendor: 'FedEx Office', cents: 1840, billable: true },
  { category: 'other', description: 'Notary fee for contractor agreement', vendor: 'Notary Public', cents: 1500 },
];
// 25-row status plan (draft, submitted, approved, rejected, reimbursed); invoiced comes from the app flow.
const PLAN = ['submitted', 'submitted', 'approved', 'reimbursed', 'submitted', 'approved', 'rejected', 'reimbursed', 'submitted', 'approved', 'reimbursed', 'submitted', 'approved',
  'rejected', 'reimbursed', 'draft', 'submitted', 'approved', 'reimbursed', 'submitted', 'approved', 'rejected', 'submitted', 'approved', 'draft'];
const DEMO_ROWS = new Set([0, 3, 5, 6, 9, 15]);
const REJECT_REASONS = ['Personal subscription — not required for the role', 'Receipt is unreadable; please resubmit with a clear photo', 'Duplicate of an expense already reimbursed last month'];

function receiptSvg(vendor: string, description: string, cents: number, dateStr: string, n: number) {
  const amt = `$${(cents / 100).toFixed(2)}`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="#fff"/><rect x="0.5" y="0.5" width="359" height="479" fill="none" stroke="#ddd"/>
<text x="180" y="50" font-family="monospace" font-size="18" font-weight="bold" text-anchor="middle">${esc(vendor)}</text>
<text x="180" y="74" font-family="monospace" font-size="12" text-anchor="middle" fill="#666">RECEIPT #${100000 + n}</text>
<text x="24" y="120" font-family="monospace" font-size="12">Date: ${dateStr}</text>
<line x1="24" y1="136" x2="336" y2="136" stroke="#999" stroke-dasharray="4 3"/>
<text x="24" y="166" font-family="monospace" font-size="12">${esc(description.slice(0, 40))}</text>
<text x="24" y="184" font-family="monospace" font-size="12">${esc(description.slice(40, 80))}</text>
<text x="336" y="220" font-family="monospace" font-size="12" text-anchor="end">${amt}</text>
<line x1="24" y1="240" x2="336" y2="240" stroke="#999" stroke-dasharray="4 3"/>
<text x="24" y="270" font-family="monospace" font-size="14" font-weight="bold">TOTAL</text><text x="336" y="270" font-family="monospace" font-size="14" font-weight="bold" text-anchor="end">${amt}</text>
<text x="24" y="300" font-family="monospace" font-size="12" fill="#666">Paid by card •••• ${String(1000 + ((n * 37) % 9000)).slice(0, 4)}</text>
<text x="180" y="440" font-family="monospace" font-size="12" text-anchor="middle" fill="#666">Thank you!</text></svg>`;
}

export default async function (c: PoolClient) {
  const orgs = (await c.query(`SELECT id, default_currency, COALESCE(timezone,'UTC') tz FROM organizations WHERE status <> 'deleted'`)).rows;
  for (const org of orgs) {
    if ((await c.query(`SELECT 1 FROM expenses WHERE organization_id=$1 LIMIT 1`, [org.id])).rowCount) continue;
    const approver = (await c.query(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.key IN ('finance','owner','admin') ORDER BY (r.key='finance') DESC, m.created_at LIMIT 1`, [org.id])).rows[0]?.user_id ?? null;
    // Active workers with their active placement; the demo worker (worker@) first so the portal has data.
    const workers = (await c.query(`SELECT DISTINCT ON (w.id) w.id, w.user_id, p.id placement_id, p.company_id, cd.email,
        COALESCE((SELECT r.currency FROM placement_rates r WHERE r.placement_id=p.id ORDER BY r.effective_from DESC LIMIT 1), $2) currency
      FROM workers w JOIN candidates cd ON cd.id=w.candidate_id JOIN placements p ON p.worker_id=w.id AND p.status='active'
      WHERE w.organization_id=$1 AND COALESCE(cd.email,'') NOT LIKE '%.test' ORDER BY w.id, p.start_date DESC`, [org.id, org.default_currency ?? 'USD'])).rows
      .sort((a, b) => (a.email === 'worker@veyro.demo' ? -1 : b.email === 'worker@veyro.demo' ? 1 : String(a.id).localeCompare(String(b.id))));
    if (!workers.length) continue;
    const today = (await c.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [org.tz])).rows[0].d as string;
    const total = Math.min(PLAN.length, Math.max(6, workers.length * 3));
    for (let i = 0; i < total; i++) {
      // Demo worker gets a spread of statuses (submitted, reimbursed, approved, rejected, draft); others round-robin.
      const w = DEMO_ROWS.has(i) || workers.length === 1 ? workers[0] : workers[1 + (i % (workers.length - 1))];
      const t = TEMPLATES[(i * 5) % TEMPLATES.length];
      const status = PLAN[i];
      // Older statuses further in the past: reimbursed 30–60 days, approved/rejected 5–30, submitted/draft 0–10.
      const ago = status === 'reimbursed' ? 30 + ((i * 7) % 28) : status === 'approved' || status === 'rejected' ? 5 + ((i * 3) % 24) : (i * 2) % 10;
      const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ago);
      const expDate = d.toISOString().slice(0, 10);
      const cents = t.cents + ((i * 113) % 400);
      const rel = path.posix.join('uploads', 'receipts', org.id, `seed-${crypto.randomUUID()}.svg`);
      const withReceipt = status !== 'draft' || i % 2 === 0;
      if (withReceipt) {
        const abs = path.join(STORAGE_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, receiptSvg(t.vendor, t.description, cents, expDate, i + 1));
      }
      const submitted = status !== 'draft';
      const decided = ['approved', 'rejected', 'reimbursed'].includes(status);
      await c.query(`INSERT INTO expenses (organization_id, worker_id, placement_id, submitted_by, company_id, category, description, expense_date, amount_cents, currency, receipt_file, receipt_name,
          billable_to_client, reimbursable_to_worker, status, submitted_at, decided_by, decided_at, decision_note, reimbursed_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,
          CASE WHEN $15 THEN LEAST(now(), $8::date + interval '1 day 3 hours') END,
          CASE WHEN $16 THEN $17::uuid END, CASE WHEN $16 THEN LEAST(now(), $8::date + interval '3 days 5 hours') END, $18,
          CASE WHEN $14='reimbursed' THEN LEAST(now(), $8::date + interval '14 days') END, LEAST(now(), $8::date + interval '1 day'), now())`,
        [org.id, w.id, w.placement_id, w.user_id ?? approver, w.company_id, t.category, t.description, expDate, cents, w.currency, withReceipt ? rel : null, withReceipt ? `${t.vendor.replace(/[^\w]+/g, '-').toLowerCase()}-receipt.svg` : null,
          !!t.billable, status, submitted, decided, approver, status === 'rejected' ? REJECT_REASONS[i % REJECT_REASONS.length] : null]);
    }
  }
}
