// Import Center: upload CSV/XLSX → map columns (saved mappings) → preview → validate + duplicate detection (dry run)
// → run as a background job with live progress → row-level error report → idempotent retry → resume after interruption.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx, pool } from '../core/db';
import { staff, need, can, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged, toCsv } from '../core/list';
import { enqueue, registerJob, every } from '../jobs/queue';
import { publishOrg } from '../core/realtime';
import { emit } from '../core/events';
import { parseCsv, parseXlsx } from './_admin/tabular';
import { ENTITIES, suggestMapping, mapRow, findExisting, fileKeys, applyRow, findCompany } from './_admin/importers';
import { isUuid } from './_admin/common';
import { fieldError } from './_admin/common';
import type { Resource } from '@veyro/shared';

const RES: Record<string, Resource> = { leads: 'leads', clients: 'clients', contacts: 'contacts', candidates: 'candidates', positions: 'positions', workers: 'workers', placements: 'placements', rates: 'rates' };
const MAX_ROWS = 20000;
const BATCH = 20;

function importPerm(ctx: Ctx, action: 'view' | 'create') { need(ctx, 'imports', action); }
async function jobOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const j = await one<any>(`SELECT j.*, u.name created_by_name FROM import_jobs j LEFT JOIN users u ON u.id=j.created_by WHERE j.id=$1 AND j.organization_id=$2`, [id, ctx.orgId]);
  if (!j) throw notFound();
  return j;
}
async function counts(jobId: string) {
  const rows = await q<any>(`SELECT status, planned_action, count(*)::int n FROM import_rows WHERE job_id=$1 GROUP BY 1,2`, [jobId]);
  const by = (f: (r: any) => boolean) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  return {
    pending: by(r => r.status === 'pending'), created: by(r => r.status === 'created'), updated: by(r => r.status === 'updated'), duplicate: by(r => r.status === 'duplicate'), error: by(r => r.status === 'error'), skipped: by(r => r.status === 'skipped'),
    planned: { create: by(r => r.planned_action === 'create'), update: by(r => r.planned_action === 'update'), skip_duplicate: by(r => r.planned_action === 'skip_duplicate'), error: by(r => r.planned_action === 'error') },
  };
}

/** Validates every row (mapping, formats, references) and detects duplicates in the DB and within the file. */
async function dryRun(ctx: Ctx, job: any) {
  const entity = job.entity; const mapping = job.mapping ?? {}; const onDup = job.options?.on_duplicate ?? 'skip';
  const rows = await q<any>(`SELECT id, row_number, data FROM import_rows WHERE job_id=$1 AND status IN ('pending','error') ORDER BY row_number`, [job.id]);
  const seen = new Map<string, number>(); const userCache = new Map<string, string | null>();
  const summary = { create: 0, update: 0, skip_duplicate: 0, error: 0, warnings: 0 };
  const client = await pool.connect();
  try {
    for (const r of rows) {
      const m = await mapRow(ctx.orgId, entity, r.data, mapping, userCache, client);
      let action: string = 'create'; let dupOf: string | null = null; const warn = [...m.warnings]; let err = m.errors.join('; ');
      if (!err) {
        const inFile = fileKeys(entity, m.values).map(k => seen.get(k)).find(n => n !== undefined);
        if (inFile !== undefined) { action = 'skip_duplicate'; warn.push(`Duplicate of row ${inFile} in this file`); }
        else {
          const ex = await findExisting(ctx.orgId, entity, m.values, client);
          if (ex.refError) { err = ex.refError; }
          else if (ex.dup) {
            dupOf = ex.dup.id;
            if (onDup === 'update' && ENTITIES[entity].allowUpdate) { action = 'update'; warn.push(`Will update existing "${ex.dup.label}" (matched by ${ex.dup.by})`); }
            else { action = 'skip_duplicate'; warn.push(`Already exists: "${ex.dup.label}" (matched by ${ex.dup.by})`); }
          }
          if (entity === 'contacts' && (m.values.company_name || m.values.company_legacy_id) && !(await findCompany(ctx.orgId, { name: m.values.company_name, legacy: m.values.company_legacy_id }, client))) warn.push(`Company "${m.values.company_name ?? m.values.company_legacy_id}" not found — contact will be created without a company`);
          if (entity === 'positions' && m.values.company_name && !(await findCompany(ctx.orgId, { name: m.values.company_name }, client))) warn.push(`Client "${m.values.company_name}" not found — position will be created without a client`);
        }
        for (const k of fileKeys(entity, m.values)) if (!seen.has(k)) seen.set(k, r.row_number);
      }
      if (err) action = 'error';
      summary[action as keyof typeof summary]++;
      if (warn.length) summary.warnings++;
      await client.query(`UPDATE import_rows SET planned_action=$2, error=$3, warning=$4, duplicate_of=$5, status=CASE WHEN status='error' THEN 'pending' ELSE status END WHERE id=$1`, [r.id, action, err || null, warn.join('; ') || null, dupOf]);
    }
  } finally { client.release(); }
  return summary;
}

registerJob('import.run', async ({ jobId }, qjob) => {
  const job = await one<any>(`SELECT * FROM import_jobs WHERE id=$1`, [jobId]);
  if (!job || job.status !== 'running') return;
  const actor = await one<any>(`SELECT id, name FROM users WHERE id=$1`, [job.created_by]);
  const ctxLike = { orgId: job.organization_id, userId: job.created_by, user: { name: actor?.name ?? 'Import' } as any, impersonatorId: null, ip: 'job' };
  const label = `${job.filename} (${ENTITIES[job.entity]?.label ?? job.entity} import)`;
  const userCache = new Map<string, string | null>();
  for (;;) {
    const cur = await one<any>(`SELECT status FROM import_jobs WHERE id=$1`, [jobId]);
    if (cur?.status !== 'running') return; // paused / interrupted by a user — resume picks up the remaining pending rows
    const batch = await q<any>(`SELECT * FROM import_rows WHERE job_id=$1 AND status='pending' ORDER BY row_number LIMIT ${BATCH}`, [jobId]);
    if (!batch.length) break;
    for (const r of batch) {
      let status = 'error'; let error: string | null = null; let entityId: string | null = null;
      try {
        if (r.planned_action === 'skip_duplicate') { status = 'duplicate'; entityId = r.duplicate_of; error = null; }
        else if (r.planned_action === 'error') { status = 'error'; error = r.error ?? 'Invalid row'; }
        else {
          const m = await mapRow(job.organization_id, job.entity, r.data, job.mapping, userCache, pool);
          if (m.errors.length) throw new Error(m.errors.join('; '));
          const res = await tx(c => applyRow(c, job.organization_id, job.created_by, job.entity, m.values, r.planned_action === 'update' ? r.duplicate_of : null, label));
          status = res.action; entityId = res.id;
        }
      } catch (e: any) { status = 'error'; error = String(e?.message ?? e).slice(0, 500); }
      await q(`UPDATE import_rows SET status=$2, error=$3, entity_id=$4, processed_at=now() WHERE id=$1 AND status='pending'`, [r.id, status, error, entityId]);
    }
    const c = await counts(jobId);
    const processed = job.total_rows - c.pending;
    await q(`UPDATE import_jobs SET processed_rows=$2, created_rows=$3, updated_rows=$4, duplicate_rows=$5, error_rows=$6, heartbeat_at=now() WHERE id=$1`, [jobId, processed, c.created, c.updated, c.duplicate, c.error]);
    const pct = Math.floor((processed / Math.max(1, job.total_rows)) * 100);
    await qjob.progress(Math.min(99, pct));
    publishOrg(job.organization_id, 'job', { kind: 'import', importId: jobId, processed, total: job.total_rows, progress: pct, created: c.created, updated: c.updated, errors: c.error, duplicates: c.duplicate });
    await new Promise(r => setTimeout(r, job.total_rows > 200 ? 50 : 350)); // paced so progress is observable in the demo
  }
  const c = await counts(jobId);
  const status = c.error && !c.created && !c.updated ? 'failed' : 'completed';
  await q(`UPDATE import_jobs SET status=$2, processed_rows=total_rows, created_rows=$3, updated_rows=$4, duplicate_rows=$5, error_rows=$6, finished_at=now(), heartbeat_at=now() WHERE id=$1`, [jobId, status, c.created, c.updated, c.duplicate, c.error]);
  publishOrg(job.organization_id, 'job', { kind: 'import', importId: jobId, processed: job.total_rows, total: job.total_rows, progress: 100, status, created: c.created, updated: c.updated, errors: c.error, duplicates: c.duplicate });
  await audit(ctxLike, 'import.completed', { type: 'import', id: jobId, label }, null, { created: c.created, updated: c.updated, duplicates: c.duplicate, errors: c.error });
  await notify(job.organization_id, [job.created_by], { event: 'import.completed', title: `Import finished: ${job.filename}`, body: `${c.created} created, ${c.updated} updated, ${c.duplicate} duplicates skipped, ${c.error} errors`, link: `/settings/import?job=${jobId}` });
  await emit(job.organization_id, 'import.completed', { import_id: jobId, entity: job.entity, filename: job.filename, created: c.created, updated: c.updated, duplicates: c.duplicate, errors: c.error });
});

// Interrupted runs (API restart mid-import) are detected by a stale heartbeat and marked resumable.
every('imports.detect-interrupted', 30_000, async () => {
  const stale = await q<any>(`UPDATE import_jobs SET status='interrupted', last_error='The import stopped unexpectedly (server restart). Resume to continue from row ' || (processed_rows + 1) || '.' WHERE status='running' AND COALESCE(heartbeat_at, started_at) < now() - interval '90 seconds' RETURNING id, organization_id, created_by, filename`);
  for (const j of stale) await notify(j.organization_id, [j.created_by], { event: 'import.interrupted', title: `Import interrupted: ${j.filename}`, body: 'Open the Import Center to resume — completed rows will not be imported twice.', link: `/settings/import?job=${j.id}` });
});

export default async function (app: FastifyInstance) {
  app.get('/api/v1/imports/entities', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    return Object.values(ENTITIES).map(e => ({ ...e, allowed: can(ctx, RES[e.key], 'create') }));
  });
  app.get('/api/v1/imports', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const lp = listParams(req);
    const where = ['j.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`j.status=$${params.length}`); }
    if (lp.filters.entity) { params.push(lp.filters.entity); where.push(`j.entity=$${params.length}`); }
    return paged({ select: 'j.id, j.entity, j.filename, j.status, j.total_rows, j.processed_rows, j.created_rows, j.updated_rows, j.error_rows, j.duplicate_rows, j.created_at, j.finished_at, u.name created_by_name', from: 'import_jobs j LEFT JOIN users u ON u.id=j.created_by', where, params, lp,
      searchCols: ['j.filename', 'j.entity'], sortMap: { created_at: 'j.created_at', filename: 'j.filename', status: 'j.status', total_rows: 'j.total_rows' }, defaultSort: 'j.created_at DESC' });
  });
  app.get('/api/v1/imports/mappings', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const { entity } = req.query as any;
    return q(`SELECT * FROM import_mappings WHERE organization_id=$1 ${entity ? 'AND entity=$2' : ''} ORDER BY created_at DESC`, entity ? [ctx.orgId, entity] : [ctx.orgId]);
  });
  app.delete('/api/v1/imports/mappings/:id', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const r = await one<any>(`DELETE FROM import_mappings WHERE id=$1 AND organization_id=$2 RETURNING name`, [id, ctx.orgId]); if (!r) throw notFound();
    return { ok: true };
  });

  // Upload: parses the file into import_rows (raw values preserved) and suggests a mapping.
  app.post('/api/v1/imports', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    let entity = ''; let filename = ''; let buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') { filename = part.filename; buf = await part.toBuffer(); }
      else if (part.fieldname === 'entity') entity = String(part.value);
    }
    if (!ENTITIES[entity]) throw fieldError({ entity: 'Choose what you are importing' });
    need(ctx, RES[entity], 'create');
    if (!buf || !filename) throw badRequest('Choose a CSV or XLSX file to upload');
    const ext = filename.split('.').pop()?.toLowerCase();
    let table: string[][];
    try {
      if (ext === 'xlsx') table = parseXlsx(buf);
      else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') table = parseCsv(buf.toString('utf8'));
      else throw new Error('Upload a .csv or .xlsx file (older .xls files must be saved as .xlsx or CSV first)');
    } catch (e: any) { throw badRequest(e?.message ?? 'Could not read this file'); }
    if (table.length < 2) throw badRequest('The file needs a header row and at least one data row');
    const headers = table[0].map((h, i) => (h ?? '').trim() || `Column ${i + 1}`);
    const uniq = headers.map((h, i) => (headers.indexOf(h) === i ? h : `${h} (${i + 1})`));
    const data = table.slice(1);
    if (data.length > MAX_ROWS) throw badRequest(`This file has ${data.length.toLocaleString()} rows — the limit is ${MAX_ROWS.toLocaleString()} per import. Split it into smaller files.`);
    const saved = await one<any>(`SELECT * FROM import_mappings WHERE organization_id=$1 AND entity=$2 ORDER BY created_at DESC LIMIT 1`, [ctx.orgId, entity]);
    const suggested = suggestMapping(entity, uniq);
    const savedFits = saved && Object.values(saved.mapping as Record<string, string>).every(h => uniq.includes(h));
    const job = await tx(async (c) => {
      const j = (await c.query(`INSERT INTO import_jobs (organization_id, entity, filename, mapping, status, total_rows, headers, created_by, options) VALUES ($1,$2,$3,$4,'uploaded',$5,$6,$7,$8) RETURNING *`,
        [ctx.orgId, entity, filename.slice(0, 200), JSON.stringify(savedFits ? saved.mapping : suggested), data.length, uniq, ctx.userId, JSON.stringify({ on_duplicate: 'skip', mapping_source: savedFits ? saved.name : 'auto' })])).rows[0];
      for (let i = 0; i < data.length; i += 500) {
        const chunk = data.slice(i, i + 500);
        const vals: unknown[] = []; const ph: string[] = [];
        chunk.forEach((row, k) => { const obj = Object.fromEntries(uniq.map((h, ci) => [h, (row[ci] ?? '').trim()])); vals.push(ctx.orgId, j.id, i + k + 1, JSON.stringify(obj)); const b = (k * 4); ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`); });
        await c.query(`INSERT INTO import_rows (organization_id, job_id, row_number, data) VALUES ${ph.join(',')}`, vals);
      }
      return j;
    });
    await audit(ctx, 'import.uploaded', { type: 'import', id: job.id, label: filename }, null, { entity, rows: data.length });
    return { id: job.id };
  });

  app.get('/api/v1/imports/:id', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const j = await jobOr404(ctx, (req.params as any).id);
    const sample = await q<any>(`SELECT row_number, data FROM import_rows WHERE job_id=$1 ORDER BY row_number LIMIT 5`, [j.id]);
    const mappings = await q<any>(`SELECT id, name, mapping, created_at FROM import_mappings WHERE organization_id=$1 AND entity=$2 ORDER BY created_at DESC`, [ctx.orgId, j.entity]);
    const qjob = await one<any>(`SELECT status, progress, attempts, last_error FROM jobs WHERE kind='import.run' AND payload->>'jobId'=$1 ORDER BY created_at DESC LIMIT 1`, [j.id]);
    return { ...j, definition: ENTITIES[j.entity], sample, mappings, counts: await counts(j.id), queue: qjob, can_run: can(ctx, RES[j.entity], 'create') && can(ctx, 'imports', 'create') };
  });
  app.get('/api/v1/imports/:id/rows', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const j = await jobOr404(ctx, (req.params as any).id);
    const lp = listParams(req);
    const where = ['r.job_id=$1']; const params: unknown[] = [j.id];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`r.status=$${params.length}`); }
    if (lp.filters.planned) { params.push(lp.filters.planned); where.push(`r.planned_action=$${params.length}`); }
    if (lp.filters.warnings === 'true') where.push(`r.warning IS NOT NULL`);
    const res = await paged<any>({ select: 'r.id, r.row_number, r.data, r.status, r.planned_action, r.error, r.warning, r.entity_id, r.duplicate_of', from: 'import_rows r', where, params, lp, searchCols: ['r.data::text', 'r.error', 'r.warning'], sortMap: { row_number: 'r.row_number', status: 'r.status' }, defaultSort: 'r.row_number ASC' });
    return res;
  });

  app.put('/api/v1/imports/:id/mapping', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    if (['running', 'completed'].includes(j.status)) throw conflict(`This import is ${j.status}; mapping can no longer change`);
    const b = z.object({ mapping: z.record(z.string(), z.string()), on_duplicate: z.enum(['skip', 'update']).default('skip'), save_as: z.string().min(2).max(60).optional() }).parse(req.body);
    const def = ENTITIES[j.entity];
    const fields: Record<string, string> = {};
    for (const [k, h] of Object.entries(b.mapping)) { if (!def.fields.find(f => f.key === k)) fields[k] = 'Unknown target field'; else if (h && !j.headers.includes(h)) fields[k] = `Column "${h}" is not in the file`; }
    for (const f of def.fields.filter(f => f.required)) if (!b.mapping[f.key]) fields[f.key] = `${f.label} must be mapped`;
    if (Object.keys(fields).length) throw fieldError(fields);
    const clean = Object.fromEntries(Object.entries(b.mapping).filter(([, h]) => h));
    await q(`UPDATE import_jobs SET mapping=$2, options=options || $3::jsonb, status='mapped', dry_run_result=NULL WHERE id=$1`, [j.id, JSON.stringify(clean), JSON.stringify({ on_duplicate: def.allowUpdate ? b.on_duplicate : 'skip' })]);
    await q(`UPDATE import_rows SET planned_action=NULL, warning=NULL, duplicate_of=NULL, error=NULL WHERE job_id=$1 AND status='pending'`, [j.id]);
    if (b.save_as) await q(`INSERT INTO import_mappings (organization_id, entity, name, mapping) VALUES ($1,$2,$3,$4)`, [ctx.orgId, j.entity, b.save_as, JSON.stringify(clean)]);
    return { ok: true };
  });

  app.post('/api/v1/imports/:id/validate', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    if (!['mapped', 'dry_run', 'validated', 'failed', 'completed', 'interrupted'].includes(j.status)) throw conflict(j.status === 'uploaded' ? 'Confirm the column mapping first' : `This import is ${j.status}`);
    if (j.status === 'completed' && !(await one(`SELECT 1 FROM import_rows WHERE job_id=$1 AND status IN ('pending','error')`, [j.id]))) throw conflict('Every row has already been processed');
    const summary = await dryRun(ctx, j);
    await q(`UPDATE import_jobs SET dry_run_result=$2, status=CASE WHEN status IN ('completed','failed','interrupted') THEN status ELSE 'dry_run' END WHERE id=$1`, [j.id, JSON.stringify(summary)]);
    await audit(ctx, 'import.dry_run', { type: 'import', id: j.id, label: j.filename }, null, summary);
    return summary;
  });

  async function startRun(ctx: Ctx, j: any, actionLabel: string) {
    const r = await one<any>(`UPDATE import_jobs SET status='running', started_at=COALESCE(started_at, now()), heartbeat_at=now(), runs=runs+1, last_error=NULL WHERE id=$1 AND status <> 'running' RETURNING runs`, [j.id]);
    if (!r) return { ok: true, already: true };
    await enqueue('import.run', { jobId: j.id }, { orgId: ctx.orgId, dedupeKey: `import:${j.id}:${r.runs}`, maxAttempts: 1 });
    await audit(ctx, actionLabel, { type: 'import', id: j.id, label: j.filename }, null, { run: r.runs });
    return { ok: true };
  }
  app.post('/api/v1/imports/:id/run', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    need(ctx, RES[j.entity], 'create');
    if (j.status === 'running') return { ok: true, already: true }; // idempotent
    if (j.status === 'completed') throw conflict('This import already completed. Use "Retry failed rows" for rows with errors.');
    if (j.status !== 'dry_run') throw conflict('Run the dry run first so you can review what will happen');
    return startRun(ctx, j, 'import.started');
  });
  app.post('/api/v1/imports/:id/pause', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    if (j.status !== 'running') throw conflict('Only a running import can be paused');
    await q(`UPDATE import_jobs SET status='interrupted', last_error=$2 WHERE id=$1 AND status='running'`, [j.id, `Paused by ${ctx.user.name}`]);
    await audit(ctx, 'import.paused', { type: 'import', id: j.id, label: j.filename }, null, { processed: j.processed_rows });
    return { ok: true };
  });
  app.post('/api/v1/imports/:id/resume', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    need(ctx, RES[j.entity], 'create');
    if (j.status !== 'interrupted') throw conflict('Only an interrupted or paused import can be resumed');
    return startRun(ctx, j, 'import.resumed');
  });
  // Retry: error rows go back to pending, are re-validated (references may now exist) and only they are processed.
  app.post('/api/v1/imports/:id/retry', async (req) => {
    const ctx = staff(req); importPerm(ctx, 'create');
    const j = await jobOr404(ctx, (req.params as any).id);
    need(ctx, RES[j.entity], 'create');
    if (!['completed', 'failed'].includes(j.status)) throw conflict('Retry is available after the import finishes');
    const n = await q(`UPDATE import_rows SET status='pending', processed_at=NULL WHERE job_id=$1 AND status='error' RETURNING id`, [j.id]);
    if (!n.length) throw conflict('There are no failed rows to retry');
    await dryRun(ctx, { ...j, status: 'retry' });
    return { ...(await startRun(ctx, j, 'import.retried')), rows: n.length };
  });
  app.get('/api/v1/imports/:id/errors.csv', async (req, reply) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const j = await jobOr404(ctx, (req.params as any).id);
    const rows = await q<any>(`SELECT row_number, status, planned_action, error, warning, data FROM import_rows WHERE job_id=$1 AND (status='error' OR planned_action='error' OR (status='duplicate') OR warning IS NOT NULL) ORDER BY row_number`, [j.id]);
    const out = rows.map(r => ({ row: r.row_number, result: r.status === 'pending' ? r.planned_action : r.status, error: r.error ?? '', warning: r.warning ?? '', ...r.data }));
    await audit(ctx, 'import.error_report_downloaded', { type: 'import', id: j.id, label: j.filename }, null, { rows: out.length });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${j.filename.replace(/\.\w+$/, '')}-row-report.csv"`);
    return toCsv(out.length ? out : [{ row: '', result: 'No errors, duplicates or warnings', error: '', warning: '' }], [{ key: 'row', label: 'Row' }, { key: 'result', label: 'Result' }, { key: 'error', label: 'Error' }, { key: 'warning', label: 'Warning' }, ...j.headers.map((h: string) => ({ key: h, label: h }))]);
  });
  app.get('/api/v1/imports/templates/:entity', async (req, reply) => {
    const ctx = staff(req); importPerm(ctx, 'view');
    const def = ENTITIES[(req.params as any).entity]; if (!def) throw notFound();
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="veyro-${def.key}-template.csv"`);
    return def.fields.map(f => f.label).join(',') + '\n';
  });
}
