// Loads right after admin-00-core so its pending-approval gate (a global preHandler) covers every module's routes.
// Agency onboarding: self-serve applications → platform approval → first-login checklist → AI smart import.
//  • New agencies (POST /auth/register) start with organizations.approval_status = 'pending'. Until a VeyroApp platform
//    admin approves them, their members can only reach /auth/* and /onboarding/* (the web app shows a pending screen).
//  • Smart import reads a whole spreadsheet (every tab), asks Claude what each tab holds and how its columns map,
//    optionally has Claude clean messy rows, then hands each tab to the regular Import Center pipeline (dry run → run).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, can } from '../core/context';
import { HttpError, badRequest, conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { saveFile, signedUrl } from '../core/storage';
import { WEB_URL } from '../core/settings';
import { sendTemplate } from '../adapters/messaging';
import { claudeConfigured, claudeErrorMessage, claudePlanImport, claudeCleanRows, CLAUDE_MODEL } from '../adapters/claude';
import { platform, auditAs } from './_admin/common';
import { parseCsv, parseXlsxSheets } from './_admin/tabular';
import { ENTITIES, suggestMapping } from './_admin/importers';
import { stripePlatform, stripeConnection } from '../adapters/stripe';

/* ───────────── Pending-approval gate ───────────── */
const approvalCache = new Map<string, { at: number; status: string }>();
async function approvalOf(orgId: string) {
  const c = approvalCache.get(orgId);
  if (c && Date.now() - c.at < 10_000) return c.status;
  const r = await one<any>(`SELECT approval_status FROM organizations WHERE id=$1`, [orgId]);
  const status = r?.approval_status ?? 'approved';
  approvalCache.set(orgId, { at: Date.now(), status });
  return status;
}
const PENDING_ALLOWED = ['/api/v1/auth/', '/api/v1/onboarding/application', '/api/v1/platform/', '/api/v1/qr'];
async function gate(req: FastifyRequest) {
  if (!req.url.startsWith('/api/') || !req.ctx?.orgId || req.ctx.impersonatorId) return;
  if (PENDING_ALLOWED.some(p => req.url.startsWith(p))) return;
  const status = await approvalOf(req.ctx.orgId);
  if (status === 'pending') throw new HttpError(403, 'Your agency is waiting for approval. We will email you as soon as it is active.', { pending_approval: true });
  if (status === 'rejected') throw new HttpError(403, 'This agency application was not approved.', { pending_approval: true });
}

/* ───────────── Smart import helpers ───────────── */
const SMART_ENTITIES = ['clients', 'leads', 'contacts', 'positions', 'candidates'] as const;
const ORDER: Record<string, number> = { clients: 1, leads: 2, contacts: 3, positions: 4, candidates: 5 };
const NAME_HINTS: [RegExp, string][] = [[/cand|applicant|talent|\bvas?\b|assistant|resume|pool/i, 'candidates'], [/position|job|opening|role|vacanc|requisition/i, 'positions'], [/client|customer|account/i, 'clients'], [/lead|prospect|pipeline/i, 'leads'], [/contact|people/i, 'contacts']];
const MAX_AI_CLEAN_ROWS = 400;

/** Rule-based plan when Claude is not configured (or fails): best entity by header overlap + sheet name. */
function heuristicPlan(name: string, headers: string[]) {
  let best = { entity: 'skip', score: 0, mapping: {} as Record<string, string> };
  for (const e of SMART_ENTITIES) {
    const mapping = suggestMapping(e, headers);
    const def = ENTITIES[e];
    const requiredOk = def.fields.filter(f => f.required).every(f => mapping[f.key]);
    let score = Object.keys(mapping).length + (requiredOk ? 2 : -10);
    if (NAME_HINTS.some(([re, ent]) => ent === e && re.test(name))) score += 4;
    if (score > best.score) best = { entity: e, score, mapping };
  }
  return { sheet: name, entity: best.score >= 3 ? best.entity : 'skip', confidence: Math.min(0.85, best.score / 10), mapping: best.score >= 3 ? best.mapping : {}, notes: [] as string[], needs_cleanup: false };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function createJob(orgId: string, userId: string, entity: string, filename: string, headers: string[], rows: string[][], mapping: Record<string, string>, options: Record<string, unknown>) {
  return tx(async (c) => {
    const j = (await c.query(`INSERT INTO import_jobs (organization_id, entity, filename, mapping, status, total_rows, headers, created_by, options) VALUES ($1,$2,$3,$4,'mapped',$5,$6,$7,$8) RETURNING id`,
      [orgId, entity, filename.slice(0, 200), JSON.stringify(mapping), rows.length, headers, userId, JSON.stringify({ on_duplicate: 'skip', ...options })])).rows[0];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500); const vals: unknown[] = []; const ph: string[] = [];
      chunk.forEach((row, k) => { vals.push(orgId, j.id, i + k + 1, JSON.stringify(Object.fromEntries(headers.map((h, ci) => [h, String(row[ci] ?? '').trim()])))); const b = k * 4; ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`); });
      await c.query(`INSERT INTO import_rows (organization_id, job_id, row_number, data) VALUES ${ph.join(',')}`, vals);
    }
    return j.id as string;
  });
}

async function readFile(req: FastifyRequest) {
  let filename = ''; let buf: Buffer | null = null; let mime = '';
  for await (const part of req.parts()) if (part.type === 'file') { filename = part.filename; mime = part.mimetype; buf = await part.toBuffer(); }
  if (!buf || !filename) throw badRequest('Choose a file to upload');
  return { filename, buf, mime };
}

async function plugin(app: FastifyInstance) {
  app.addHook('preHandler', gate);

  /* ── Applicant: application status + files ── */
  app.get('/api/v1/onboarding/application', async (req) => {
    const ctx = staff(req);
    const a = await one<any>(`SELECT a.*, o.name org_name, o.approval_status FROM agency_applications a JOIN organizations o ON o.id=a.organization_id WHERE a.organization_id=$1`, [ctx.orgId]);
    if (!a) return { status: 'approved', self_serve: false };
    return { status: a.approval_status, self_serve: true, org_name: a.org_name, submitted_at: a.submitted_at, rejection_reason: a.rejection_reason, logo_url: signedUrl(a.logo_file, 3600), registration_file_name: a.registration_file_name };
  });
  app.put('/api/v1/onboarding/application/brand', async (req) => {
    const ctx = staff(req);
    if (!['owner', 'admin'].includes(ctx.role.key)) throw new HttpError(403, 'Only the account owner can change the brand');
    const b = z.object({ primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a valid color') }).parse(req.body);
    await q(`UPDATE organization_branding SET primary_color=$2, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, b.primary_color]);
    return { ok: true };
  });
  app.post('/api/v1/onboarding/application/files', async (req) => {
    const ctx = staff(req);
    if (!['owner', 'admin'].includes(ctx.role.key)) throw new HttpError(403, 'Only the account owner can upload these files');
    const a = await one<any>(`SELECT organization_id FROM agency_applications WHERE organization_id=$1`, [ctx.orgId]);
    if (!a) throw notFound();
    const out: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer(); const name = String(part.filename || 'file').slice(0, 120); const lower = name.toLowerCase();
      if (!buf.length) continue;
      if (part.fieldname === 'logo') {
        if (!/^image\/(png|jpe?g|svg\+xml|webp|gif)$/.test(part.mimetype) && !/\.(png|jpe?g|svg|webp|gif)$/.test(lower)) throw badRequest('Upload your logo as PNG, JPG, SVG or WebP');
        if (buf.length > 5 * 1024 * 1024) throw badRequest('Logo must be under 5 MB');
        const rel = saveFile(`branding/${ctx.orgId}`, name, buf);
        await q(`UPDATE agency_applications SET logo_file=$2 WHERE organization_id=$1`, [ctx.orgId, rel]);
        await q(`UPDATE organization_branding SET logo_file=$2, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, rel]);
        out.logo_url = signedUrl(rel, 3600);
      } else if (part.fieldname === 'registration') {
        if (!/\.(pdf|png|jpe?g|webp|docx?)$/.test(lower)) throw badRequest('Upload the business registration as PDF, image or Word file');
        if (buf.length > 15 * 1024 * 1024) throw badRequest('Document must be under 15 MB');
        const rel = saveFile(`applications/${ctx.orgId}`, name, buf);
        await q(`UPDATE agency_applications SET registration_file=$2, registration_file_name=$3 WHERE organization_id=$1`, [ctx.orgId, rel, name]);
        out.registration_file_name = name;
      }
    }
    return out;
  });

  /* ── Platform admins: review applications ── */
  app.get('/api/v1/platform/applications', async (req) => {
    platform(req);
    const status = String((req.query as any).status ?? 'pending');
    const rows = await q<any>(`SELECT a.*, o.name, o.slug, o.approval_status, u.name applicant_name, u.email applicant_email, r.name reviewed_by_name
      FROM agency_applications a JOIN organizations o ON o.id=a.organization_id LEFT JOIN users u ON u.id=a.applicant_user_id LEFT JOIN users r ON r.id=a.reviewed_by
      WHERE ($1='all' OR o.approval_status=$1) ORDER BY (o.approval_status='pending') DESC, a.submitted_at DESC LIMIT 200`, [status]);
    const counts = await one<any>(`SELECT count(*) FILTER (WHERE approval_status='pending')::int pending, count(*) FILTER (WHERE approval_status='approved')::int approved, count(*) FILTER (WHERE approval_status='rejected')::int rejected FROM organizations o JOIN agency_applications a ON a.organization_id=o.id`);
    return { counts, rows: rows.map(r => ({ ...r, logo_url: signedUrl(r.logo_file, 3600), registration_url: signedUrl(r.registration_file, 3600, { download: r.registration_file_name ?? undefined }), logo_file: undefined, registration_file: undefined })) };
  });
  async function decide(req: FastifyRequest, approve: boolean) {
    const ctx = platform(req);
    const { id } = req.params as any;
    const b = z.object({ reason: z.string().trim().max(500).optional().default('') }).parse(req.body ?? {});
    if (!approve && b.reason.length < 3) throw badRequest('Add a short reason — it is included in the email to the applicant');
    const a = await one<any>(`SELECT a.*, o.name org_name, o.approval_status, u.name applicant_name, u.email applicant_email FROM agency_applications a JOIN organizations o ON o.id=a.organization_id LEFT JOIN users u ON u.id=a.applicant_user_id WHERE a.organization_id=$1`, [id]);
    if (!a) throw notFound();
    if (a.approval_status === (approve ? 'approved' : 'rejected')) throw conflict(`This agency is already ${a.approval_status}`);
    await tx(async (c) => {
      await c.query(`UPDATE organizations SET approval_status=$2, updated_at=now() WHERE id=$1`, [id, approve ? 'approved' : 'rejected']);
      await c.query(`UPDATE agency_applications SET reviewed_at=now(), reviewed_by=$2, rejection_reason=$3 WHERE organization_id=$1`, [id, ctx.userId, approve ? null : b.reason]);
      await audit(auditAs(ctx, id), approve ? 'platform.agency_approved' : 'platform.agency_rejected', { type: 'organization', id, label: a.org_name }, { approval_status: a.approval_status }, { approval_status: approve ? 'approved' : 'rejected' }, b.reason || undefined, c);
    });
    approvalCache.delete(id);
    if (a.applicant_email) await sendTemplate(null, approve ? 'agency_approved' : 'agency_rejected', a.applicant_email, { user: { name: a.applicant_name }, agency: { name: a.org_name }, link: `${WEB_URL}/login`, reason: b.reason ? `Reason: ${b.reason}` : '' });
    return { ok: true, status: approve ? 'approved' : 'rejected' };
  }
  app.post('/api/v1/platform/applications/:id/approve', (req) => decide(req, true));
  app.post('/api/v1/platform/applications/:id/reject', (req) => decide(req, false));
  /** Bring back the first-login welcome checklist for an approved agency (after someone marked setup complete). */
  app.post('/api/v1/platform/applications/:id/reset-welcome', async (req) => {
    const ctx = platform(req);
    const { id } = req.params as any;
    const a = await one<any>(`SELECT a.checklist_dismissed_at, o.name FROM agency_applications a JOIN organizations o ON o.id=a.organization_id WHERE a.organization_id=$1`, [id]);
    if (!a) throw notFound();
    await q(`UPDATE agency_applications SET checklist_dismissed_at=NULL WHERE organization_id=$1`, [id]);
    await audit(auditAs(ctx, id), 'platform.welcome_reset', { type: 'organization', id, label: a.name }, { checklist_dismissed_at: a.checklist_dismissed_at }, { checklist_dismissed_at: null });
    return { ok: true };
  });

  /* ── First-login checklist ── */
  app.get('/api/v1/onboarding/checklist', async (req) => {
    const ctx = staff(req);
    const a = await one<any>(`SELECT checklist_dismissed_at FROM agency_applications WHERE organization_id=$1`, [ctx.orgId]);
    const s = await one<any>(`SELECT
      (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency') members,
      (SELECT count(*)::int FROM invitations i JOIN roles r ON r.id=i.role_id WHERE i.organization_id=$1 AND r.kind='agency') invites,
      (SELECT count(*)::int FROM import_jobs WHERE organization_id=$1 AND status='completed' AND created_rows + updated_rows > 0) imports,
      (SELECT count(*)::int FROM positions WHERE organization_id=$1) positions, (SELECT count(*)::int FROM candidates WHERE organization_id=$1) candidates,
      (SELECT count(*)::int FROM companies WHERE organization_id=$1 AND stage='client') clients`, [ctx.orgId]);
    const tasks = [
      { key: 'team', title: 'Invite your team', text: 'Add your recruiters, sales reps and account managers so everyone works in one place.', done: s.members > 1 || s.invites > 0, link: '/settings/team?invite=1', stat: s.invites ? `${s.invites} invited` : null },
      { key: 'import', title: 'Import your data with AI', text: 'Upload the Excel or CSV from your current software — positions, candidates and clients. AI sorts it out.', done: s.imports > 0, link: '/onboarding/import', stat: s.imports ? `${s.positions} positions · ${s.candidates} candidates · ${s.clients} clients` : null },
    ];
    // Card payments: only offered once the server has Stripe Connect set up, so the step always works.
    if (stripePlatform()) {
      const conn = await stripeConnection(ctx.orgId);
      tasks.push({ key: 'stripe', title: 'Connect Stripe to get paid', text: 'Link your Stripe account so clients can pay invoices by card. The money goes straight to your Stripe.', done: !!conn, link: '/settings/integrations', stat: conn ? `Connected: ${conn.account_name ?? conn.external_account_id}` : null });
    }
    const canManage = ['owner', 'admin'].includes(ctx.role.key);
    return { show: !!a && !a.checklist_dismissed_at && canManage && tasks.some(t => !t.done), dismissed: !!a?.checklist_dismissed_at, tasks };
  });
  app.post('/api/v1/onboarding/checklist/dismiss', async (req) => {
    const ctx = staff(req);
    await q(`UPDATE agency_applications SET checklist_dismissed_at=now() WHERE organization_id=$1`, [ctx.orgId]);
    return { ok: true };
  });

  /* ── Smart import: analyze a workbook → one mapped import job per useful tab ── */
  app.post('/api/v1/onboarding/smart-import', async (req) => {
    const ctx = staff(req); need(ctx, 'imports', 'create');
    const { filename, buf } = await readFile(req);
    const ext = filename.split('.').pop()?.toLowerCase();
    let sheets: { name: string; rows: string[][] }[];
    try {
      if (ext === 'xlsx') sheets = parseXlsxSheets(buf);
      else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') sheets = [{ name: filename.replace(/\.\w+$/, ''), rows: parseCsv(buf.toString('utf8')) }];
      else throw new Error('Upload an .xlsx or .csv file (older .xls files: open them and "Save as" .xlsx first)');
    } catch (e: any) { throw badRequest(e?.message ?? 'Could not read this file'); }
    // Header row = first row with 2+ filled cells (exports often start with a title line).
    const tables = sheets.map(s => {
      const hi = Math.max(0, s.rows.findIndex(r => r.filter(x => String(x).trim()).length >= 2));
      const raw = s.rows[hi] ?? [];
      const headers = raw.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`).map((h, i, a) => (a.indexOf(h) === i ? h : `${h} (${i + 1})`));
      const data = s.rows.slice(hi + 1).filter(r => r.some(x => String(x).trim()));
      return { name: s.name, headers, data };
    }).filter(t => t.data.length && t.headers.length >= 2);
    if (!tables.length) throw badRequest('We could not find any rows with data in this file');
    if (tables.reduce((a, t) => a + t.data.length, 0) > 20000) throw badRequest('This file has more than 20,000 rows — split it into smaller files');

    const allowed = SMART_ENTITIES.filter(e => can(ctx, e, 'create'));
    const defs = Object.fromEntries(allowed.map(e => [e, { label: ENTITIES[e].label, fields: ENTITIES[e].fields.map(f => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options })) }]));
    let engine = 'local'; let aiNote: string | null = null;
    let plans = tables.map(t => heuristicPlan(t.name, t.headers));
    if (claudeConfigured()) {
      try {
        const ai = await claudePlanImport(tables.map(t => ({ name: t.name, headers: t.headers, sample: t.data.slice(0, 8), rows: t.data.length })), defs);
        plans = tables.map(t => ai.find(p => p.sheet === t.name) ?? heuristicPlan(t.name, t.headers)).map(p => (p.entity !== 'skip' && !allowed.includes(p.entity as any) ? { ...p, entity: 'skip', notes: [...p.notes, 'You do not have permission to import this type'] } : p));
        engine = CLAUDE_MODEL;
      } catch (e) { aiNote = `AI was unavailable (${claudeErrorMessage(e)}) — columns were matched by name instead.`; }
    } else aiNote = 'AI is not connected, so columns were matched by name. Add an Anthropic API key to let AI read and clean your data.';

    const results = await pool(tables.map((t, i) => ({ t, p: plans[i] })), 3, async ({ t, p }) => {
      if (p.entity === 'skip') return { sheet: t.name, entity: 'skip', rows: t.data.length, notes: p.notes, confidence: p.confidence, job_id: null as string | null, cleaned: false, headers: t.headers, mapping: {}, sample: t.data.slice(0, 3) };
      const def = ENTITIES[p.entity];
      let headers = t.headers; let rows = t.data; let mapping = p.mapping; let cleaned = false; const notes = [...p.notes];
      if (engine !== 'local' && p.needs_cleanup && t.data.length <= MAX_AI_CLEAN_ROWS) {
        try {
          const fields = def.fields.map(f => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options }));
          const batches: string[][][] = []; for (let i = 0; i < t.data.length; i += 25) batches.push(t.data.slice(i, i + 25));
          const out = (await pool(batches, 4, b => claudeCleanRows(def.label, fields, t.headers, b))).flat();
          const used = def.fields.filter(f => out.some(r => r[f.key]));
          headers = used.map(f => f.label); rows = out.map(r => used.map(f => r[f.key] ?? ''));
          mapping = Object.fromEntries(used.map(f => [f.key, f.label]));
          cleaned = true; notes.push(`AI cleaned all ${t.data.length} rows (names split, rates and lists normalised).`);
        } catch (e) { notes.push(`AI clean-up skipped (${claudeErrorMessage(e)}) — raw values will be imported.`); }
      } else if (p.needs_cleanup && t.data.length > MAX_AI_CLEAN_ROWS) notes.push(`This tab has ${t.data.length} rows — AI mapped the columns; values are imported as they are.`);
      const jobId = await createJob(ctx.orgId, ctx.userId, p.entity, `${filename} · ${t.name}`, headers, rows, mapping, { mapping_source: engine === 'local' ? 'auto' : 'ai', smart_import: true, ai_cleaned: cleaned, sheet: t.name });
      return { sheet: t.name, entity: p.entity, rows: t.data.length, notes, confidence: p.confidence, job_id: jobId, cleaned, headers, mapping, sample: rows.slice(0, 3) };
    });
    await audit(ctx, 'import.smart_analyzed', { type: 'import', id: results.find(r => r.job_id)?.job_id ?? ctx.orgId, label: filename }, null, { engine, sheets: results.map(r => ({ sheet: r.sheet, entity: r.entity, rows: r.rows })) });
    return { filename, engine, note: aiNote, sheets: results.sort((a, b) => (ORDER[a.entity] ?? 9) - (ORDER[b.entity] ?? 9)), entities: allowed.map(e => ({ key: e, label: ENTITIES[e].label, fields: ENTITIES[e].fields.map(f => ({ key: f.key, label: f.label, required: !!f.required })) })) };
  });

  /** Change what a tab is imported as; the mapping is re-suggested from its headers. */
  app.put('/api/v1/onboarding/smart-import/:id/entity', async (req) => {
    const ctx = staff(req); need(ctx, 'imports', 'create');
    const { id } = req.params as any;
    const b = z.object({ entity: z.enum(SMART_ENTITIES) }).parse(req.body);
    const j = await one<any>(`SELECT * FROM import_jobs WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
    if (!j) throw notFound();
    if (!['uploaded', 'mapped', 'dry_run'].includes(j.status)) throw conflict(`This import is already ${j.status}`);
    const mapping = suggestMapping(b.entity, j.headers);
    await q(`UPDATE import_jobs SET entity=$2, mapping=$3, status='mapped', dry_run_result=NULL WHERE id=$1`, [id, b.entity, JSON.stringify(mapping)]);
    return { entity: b.entity, mapping };
  });
}
(plugin as any)[Symbol.for('skip-override')] = true;
export default plugin;
