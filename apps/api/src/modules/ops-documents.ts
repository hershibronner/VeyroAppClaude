// OPS: Documents library (upload/attach, visibility, signed downloads, verification, expiry, renewals), document templates
// (merge vars + versions → generate PDF), e-signature requests, public signing page API, portal documents & worker tasks.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { q, one, tx, insertRow } from '../core/db';
import { auth, staff, need, can, canViewComp, getOr404, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { saveFile, signedUrl } from '../core/storage';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import { rateLimit } from '../core/ratelimit';
import { render } from '../core/templates';
import { enrich } from './_insights/automationEngine';
import { renderDocumentPdf, renderSignedPdf } from './_insights/pdf';
import { entityLabelSql, linkFor, ENTITY_RESOURCE } from './_insights/common';

const CATEGORIES = ['contract', 'nda', 'offer_letter', 'policy', 'id', 'compliance', 'resume', 'invoice', 'payslip', 'general'] as const;
const VISIBILITY = ['internal', 'client', 'worker', 'candidate'] as const;
const ENTITY_TABLES: Record<string, string> = { company: 'companies', contact: 'contacts', candidate: 'candidates', worker: 'workers', placement: 'placements', position: 'positions', invoice: 'invoices', opportunity: 'opportunities' };
const ALLOWED_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'doc', 'docx', 'csv', 'svg']);
const MAX_BYTES = 20 * 1024 * 1024;

const expirySql = `CASE WHEN d.expires_at IS NULL THEN NULL WHEN d.expires_at < current_date THEN 'expired' WHEN d.expires_at <= current_date + 30 THEN 'expiring' ELSE 'valid' END`;
const SELECT_DOC = `d.*, ${expirySql} expiry_status, ${entityLabelSql('d.entity_type', 'd.entity_id')} entity_label, u.name created_by_name, vu.name verified_by_name,
  (SELECT stage FROM companies WHERE id=d.entity_id) entity_stage,
  EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL) superseded`;

/** Reads a multipart upload: one file + text fields. */
async function readUpload(req: FastifyRequest): Promise<{ file: { filename: string; mime: string; buf: Buffer } | null; fields: Record<string, string> }> {
  const fields: Record<string, string> = {};
  let file: { filename: string; mime: string; buf: Buffer } | null = null;
  if (!req.isMultipart()) throw badRequest('Upload a file (multipart/form-data)');
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      if (buf.length > MAX_BYTES) throw badRequest('File is larger than 20 MB');
      file = { filename: part.filename, mime: part.mimetype, buf };
    } else fields[part.fieldname] = String((part as any).value ?? '');
  }
  if (file) {
    const ext = path.extname(file.filename).slice(1).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw badRequest(`Files of type .${ext || '?'} are not allowed. Use PDF, image, Word, CSV or text.`);
    if (!file.buf.length) throw badRequest('The file is empty');
  }
  return { file, fields };
}
const isoOrNull = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const dlName = (d: { name: string; file: string | null }) => `${d.name.replace(/[^\w .\-—]+/g, '').slice(0, 80)}${path.extname(d.file ?? '') || ''}`;

async function assertEntity(ctx: Ctx, type: string, id: string) {
  const t = ENTITY_TABLES[type];
  if (!t) throw badRequest('Unsupported record type');
  await getOr404(t, ctx, id);
  const res = ENTITY_RESOURCE[type];
  if (res && !(type === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, res as any, 'view'))) throw notFound();
}

/** People who should hear about a worker/company document (AM of active placements, HR). */
async function docWatchers(orgId: string, d: { entity_type: string | null; entity_id: string | null }) {
  const ids: string[] = [];
  if (d.entity_type === 'worker') ids.push(...(await q<any>(`SELECT DISTINCT account_manager_id u FROM placements WHERE worker_id=$1 AND organization_id=$2 AND account_manager_id IS NOT NULL`, [d.entity_id, orgId])).map(r => r.u));
  if (d.entity_type === 'company') ids.push(...(await q<any>(`SELECT account_manager_id u FROM companies WHERE id=$1 AND account_manager_id IS NOT NULL`, [d.entity_id])).map(r => r.u));
  ids.push(...(await usersWithRoles(orgId, ['hr'])));
  return ids.length ? ids : usersWithRoles(orgId, ['owner', 'admin']);
}

/** Merge variables for a document template rendered against a record. */
async function docVars(ctx: Ctx, type?: string | null, id?: string | null) {
  const base: Record<string, any> = { org: { name: ctx.org.name }, today: new Date().toISOString().slice(0, 10), sender: { name: ctx.user.name } };
  if (!type || !id) return base;
  const key = ({ worker: 'worker_id', candidate: 'candidate_id', company: 'company_id', placement: 'placement_id' } as Record<string, string>)[type];
  if (!key) return base;
  const v = await enrich(ctx.orgId, { [key]: id });
  const out: Record<string, any> = { ...v, ...base };
  out.party = { name: v.company?.name ?? v.worker?.name ?? v.candidate?.name ?? '' };
  if (v.candidate_id) {
    const o = await one<any>(`SELECT o.start_date, o.pay_rate_cents, o.currency, o.rate_unit, p.title FROM offers o LEFT JOIN positions p ON p.id=o.position_id WHERE o.candidate_id=$1 AND o.organization_id=$2 ORDER BY o.created_at DESC LIMIT 1`, [v.candidate_id, ctx.orgId]);
    if (o) {
      out.offer = { startDate: o.start_date, payRate: canViewComp(ctx) ? `${(Number(o.pay_rate_cents) / 100).toLocaleString('en-US', { style: 'currency', currency: o.currency })}/${o.rate_unit}` : '' };
      out.position = { ...(out.position ?? {}), title: out.position?.title ?? o.title };
    }
  }
  return out;
}

async function createSignatureRequest(ctx: Ctx, opts: { documentId: string | null; templateId: string | null; templateVersion?: number | null; entityType: string | null; entityId: string | null; title: string; body: string; signerName: string; signerEmail: string; message?: string | null; expiresInDays?: number }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const signer = await one<any>(`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$1 AND m.status='active' WHERE lower(u.email)=lower($2)`, [ctx.orgId, opts.signerEmail]);
  const sr = await insertRow('signature_requests', {
    organization_id: ctx.orgId, document_id: opts.documentId, template_id: opts.templateId, template_version: opts.templateVersion ?? null, entity_type: opts.entityType, entity_id: opts.entityId,
    title: opts.title, rendered_body: opts.body, signer_name: opts.signerName, signer_email: opts.signerEmail, signer_user_id: signer?.id ?? null, token, status: 'sent',
    message: opts.message ?? null, expires_at: new Date(Date.now() + (opts.expiresInDays ?? 14) * 86400_000).toISOString(), created_by: ctx.userId,
  });
  if (opts.documentId) await q(`UPDATE documents SET signature_status='pending' WHERE id=$1 AND organization_id=$2`, [opts.documentId, ctx.orgId]);
  await sendTemplate(ctx.orgId, 'signature_request', opts.signerEmail, { signer: { name: opts.signerName }, document: { title: opts.title }, org: { name: ctx.org.name }, link: `${WEB_URL}/sign/${token}`, message: opts.message ?? '' }, { related: opts.entityType && opts.entityId ? { type: opts.entityType, id: opts.entityId } : undefined });
  if (signer?.id) {
    const kind = (await one<any>(`SELECT r.kind FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.organization_id=$2`, [signer.id, ctx.orgId]))?.kind;
    await notify(ctx.orgId, [signer.id], { event: 'signature.requested', title: `Please sign: ${opts.title}`, body: `${ctx.user.name} sent you a document to sign.`, link: kind && kind !== 'agency' ? `/portal/${kind}/documents` : `/sign/${token}` });
  }
  if (opts.entityType && opts.entityId) await activity(ctx, opts.entityType, opts.entityId, 'system', `Sent "${opts.title}" for signature`, `To ${opts.signerName} <${opts.signerEmail}>`, { signature_request_id: sr.id });
  if (opts.documentId) await activity(ctx, 'document', opts.documentId, 'system', 'Sent for signature', `To ${opts.signerName} <${opts.signerEmail}>`, { signature_request_id: sr.id });
  await audit(ctx, 'signature.requested', { type: 'signature_request', id: sr.id, label: opts.title }, null, { signer: opts.signerEmail });
  return sr;
}

// ── Portal helpers ──
function portalCtx(req: FastifyRequest, kind: 'client' | 'worker') {
  const ctx = auth(req);
  if (ctx.role.kind !== kind) throw notFound();
  if (kind === 'client' && !ctx.companyId) throw notFound();
  if (kind === 'worker' && !ctx.workerId) throw notFound();
  return ctx;
}
/** Visibility predicate for portal users. */
function portalDocWhere(ctx: Ctx, kind: 'client' | 'worker', params: unknown[]): string {
  if (kind === 'client') {
    params.push(ctx.companyId);
    const p = `$${params.length}`;
    return `d.visibility='client' AND ((d.entity_type='company' AND d.entity_id=${p}) OR (d.entity_type='placement' AND d.entity_id IN (SELECT id FROM placements WHERE company_id=${p})))`;
  }
  params.push(ctx.workerId);
  const p = `$${params.length}`;
  return `d.visibility='worker' AND ((d.entity_type='worker' AND d.entity_id=${p}) OR (d.entity_type='placement' AND d.entity_id IN (SELECT id FROM placements WHERE worker_id=${p})))`;
}

export default async function (app: FastifyInstance) {
  // ── Library ──
  app.get('/api/v1/documents', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const lp = listParams(req);
    const f = lp.filters;
    const where = ['d.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    where.push(f.archived === 'true' ? 'd.archived_at IS NOT NULL' : 'd.archived_at IS NULL');
    for (const k of ['category', 'visibility', 'verification', 'entity_type', 'signature_status'] as const) if (f[k]) { params.push(f[k]); where.push(`d.${k}=$${params.length}`); }
    if (f.entity_id) { params.push(f.entity_id); where.push(`d.entity_id::text=$${params.length}`); }
    if (f.expiry === 'expired') where.push(`d.expires_at < current_date`);
    else if (f.expiry === 'expiring') where.push(`d.expires_at BETWEEN current_date AND current_date + 30`);
    else if (f.expiry === 'valid') where.push(`d.expires_at > current_date + 30`);
    else if (f.expiry === 'none') where.push(`d.expires_at IS NULL`);
    if (f.current === 'true') where.push(`NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL)`);
    // Only show documents attached to records the viewer can see.
    const hidden = Object.entries(ENTITY_RESOURCE).filter(([t, r]) => !(t === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, r as any, 'view'))).map(([t]) => t);
    if (hidden.length) { params.push(hidden); where.push(`(d.entity_type IS NULL OR NOT (d.entity_type = ANY($${params.length})))`); }
    const r = await paged<any>({ select: SELECT_DOC, from: 'documents d LEFT JOIN users u ON u.id=d.created_by LEFT JOIN users vu ON vu.id=d.verified_by', where, params, lp, searchCols: ['d.name', 'd.category'],
      sortMap: { name: 'd.name', created_at: 'd.created_at', expires_at: 'd.expires_at', category: 'd.category' }, defaultSort: 'd.created_at DESC' });
    r.rows = r.rows.map(d => ({ ...d, file: undefined, has_file: !!d.file, entity_link: linkFor(d.entity_type, d.entity_id, { stage: d.entity_stage }) }));
    return r;
  });

  app.get('/api/v1/documents/compliance', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const cur = `d.organization_id=$1 AND d.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL)`;
    const c = await one<any>(`SELECT count(*) FILTER (WHERE d.expires_at < current_date)::int expired, count(*) FILTER (WHERE d.expires_at BETWEEN current_date AND current_date + 30)::int expiring,
      count(*) FILTER (WHERE d.expires_at BETWEEN current_date + 31 AND current_date + 90)::int expiring_90, count(*) FILTER (WHERE d.verification='unverified')::int unverified,
      count(*) FILTER (WHERE d.verification='rejected')::int rejected, count(*) FILTER (WHERE d.signature_status='pending')::int pending_signature, count(*)::int total FROM documents d WHERE ${cur}`, [ctx.orgId]);
    // Active / onboarding workers missing a verified ID or a signed contract.
    const missing = can(ctx, 'workers', 'view') ? await q<any>(`SELECT w.id, concat_ws(' ', c.first_name, c.last_name) name, co.name company, p.status placement_status,
        NOT EXISTS (SELECT 1 FROM documents d WHERE d.entity_type='worker' AND d.entity_id=w.id AND d.category='id' AND d.verification='verified' AND d.archived_at IS NULL AND (d.expires_at IS NULL OR d.expires_at >= current_date)) missing_id,
        NOT EXISTS (SELECT 1 FROM documents d WHERE d.entity_type IN ('worker','placement') AND d.entity_id IN (w.id, p.id) AND d.category='contract' AND d.signature_status='signed' AND d.archived_at IS NULL) missing_contract
      FROM workers w JOIN candidates c ON c.id=w.candidate_id JOIN LATERAL (SELECT * FROM placements p WHERE p.worker_id=w.id AND p.status IN ('active','onboarding','on_leave','notice') ORDER BY p.start_date DESC LIMIT 1) p ON true JOIN companies co ON co.id=p.company_id
      WHERE w.organization_id=$1`, [ctx.orgId]) : [];
    return { counts: c, missing: missing.filter(m => m.missing_id || m.missing_contract).map(m => ({ ...m, link: `/workforce/workers/${m.id}` })) };
  });

  app.post('/api/v1/documents', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'create');
    const { file, fields } = await readUpload(req);
    if (!file) throw badRequest('Choose a file to upload');
    const b = z.object({ name: z.string().max(200).optional(), category: z.enum(CATEGORIES).default('general'), visibility: z.enum(VISIBILITY).default('internal'), entity_type: z.string().optional(), entity_id: z.string().uuid().optional(), issue_date: z.string().optional(), expires_at: z.string().optional(), replaces_id: z.string().uuid().optional() }).parse(fields);
    let src: any = null;
    if (b.replaces_id) src = await getOr404<any>('documents', ctx, b.replaces_id);
    const et = b.entity_type || src?.entity_type || null, eid = b.entity_id || src?.entity_id || null;
    if (et || eid) { if (!et || !eid) throw badRequest('Choose the record to attach this document to'); await assertEntity(ctx, et, eid); }
    if (b.visibility === 'client' && et && !['company', 'placement', 'worker'].includes(et)) throw badRequest('Client-visible documents must be attached to a client, placement or worker');
    const rel = saveFile(`documents/${ctx.orgId}`, file.filename, file.buf);
    const d = await insertRow<any>('documents', { organization_id: ctx.orgId, entity_type: et, entity_id: eid, name: (b.name || file.filename.replace(/\.[^.]+$/, '')).slice(0, 200), category: src?.category && !fields.category ? src.category : b.category, file: rel, mime: file.mime, size_bytes: file.buf.length, visibility: src && !fields.visibility ? src.visibility : b.visibility, issue_date: isoOrNull(b.issue_date), expires_at: isoOrNull(b.expires_at), verification: 'unverified', source_document_id: src?.id ?? null, created_by: ctx.userId });
    await activity(ctx, 'document', d.id, 'system', src ? `Renewal uploaded (replaces "${src.name}")` : 'Document uploaded', d.name);
    if (et && eid && ENTITY_TABLES[et]) await activity(ctx, et, eid, 'system', `Document uploaded: ${d.name}`, null, { document_id: d.id });
    if (src) await activity(ctx, 'document', src.id, 'system', 'Superseded by a renewed copy', d.name, { document_id: d.id });
    await emit(ctx.orgId, 'document.uploaded', { document_id: d.id, uploaded_by: ctx.user.name, entity_type: et, entity_id: eid, category: d.category });
    return { ...d, file: undefined };
  });

  app.get('/api/v1/documents/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const id = (req.params as any).id;
    await getOr404('documents', ctx, id);
    const d = await one<any>(`SELECT ${SELECT_DOC} FROM documents d LEFT JOIN users u ON u.id=d.created_by LEFT JOIN users vu ON vu.id=d.verified_by WHERE d.id=$1 AND d.organization_id=$2`, [id, ctx.orgId]);
    if (d.entity_type && ENTITY_RESOURCE[d.entity_type] && !(d.entity_type === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, ENTITY_RESOURCE[d.entity_type] as any, 'view'))) throw notFound();
    const sigs = await q(`SELECT id, title, signer_name, signer_email, status, created_at, viewed_at, signed_at, signed_ip, signed_document_id, expires_at FROM signature_requests WHERE organization_id=$1 AND (document_id=$2 OR signed_document_id=$2) ORDER BY created_at DESC`, [ctx.orgId, id]);
    const chain = await q(`WITH RECURSIVE up AS (SELECT id, source_document_id, name, created_at, expires_at, 0 lvl FROM documents WHERE id=$1 UNION ALL SELECT d.id, d.source_document_id, d.name, d.created_at, d.expires_at, up.lvl+1 FROM documents d JOIN up ON d.id=up.source_document_id WHERE up.lvl < 20)
      SELECT id, name, created_at, expires_at FROM up WHERE id<>$1 UNION ALL SELECT id, name, created_at, expires_at FROM documents WHERE source_document_id=$1 AND organization_id=$2 ORDER BY created_at`, [id, ctx.orgId]);
    return { ...d, file: undefined, has_file: !!d.file, url: signedUrl(d.file, 600), download_url: d.file ? signedUrl(d.file, 600, { download: dlName(d) }) : null, entity_link: linkFor(d.entity_type, d.entity_id, { stage: d.entity_stage }), signatures: sigs, versions: chain };
  });
  app.get('/api/v1/documents/:id/download', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    if (d.entity_type && ENTITY_RESOURCE[d.entity_type] && !(d.entity_type === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, ENTITY_RESOURCE[d.entity_type] as any, 'view'))) throw notFound();
    if (!d.file) throw notFound('This document has no file');
    if (['id', 'compliance', 'payslip'].includes(d.category)) await audit(ctx, 'document.downloaded', { type: 'document', id: d.id, label: d.name });
    return { url: signedUrl(d.file, 300, { download: (req.query as any).inline ? undefined : dlName(d) }), expires_in: 300 };
  });

  app.patch('/api/v1/documents/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(200).optional(), category: z.enum(CATEGORIES).optional(), visibility: z.enum(VISIBILITY).optional(), issue_date: z.string().nullish(), expires_at: z.string().nullish() }).parse(req.body);
    const r = await one<any>(`UPDATE documents SET name=COALESCE($3,name), category=COALESCE($4,category), visibility=COALESCE($5,visibility), issue_date=CASE WHEN $6::boolean THEN $7::date ELSE issue_date END, expires_at=CASE WHEN $8::boolean THEN $9::date ELSE expires_at END WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [d.id, ctx.orgId, b.name ?? null, b.category ?? null, b.visibility ?? null, b.issue_date !== undefined, isoOrNull(b.issue_date ?? undefined), b.expires_at !== undefined, isoOrNull(b.expires_at ?? undefined)]);
    if (b.visibility && b.visibility !== d.visibility) await audit(ctx, 'document.visibility_changed', { type: 'document', id: d.id, label: d.name }, { visibility: d.visibility }, { visibility: b.visibility });
    await activity(ctx, 'document', d.id, 'system', 'Document details updated', null, { before: { name: d.name, category: d.category, visibility: d.visibility, expires_at: d.expires_at }, after: b });
    return { ...r, file: undefined };
  });
  app.post('/api/v1/documents/:id/verify', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    if (d.verification === 'verified') throw conflict('Already verified');
    await q(`UPDATE documents SET verification='verified', verified_by=$3, verified_at=now(), rejection_reason=NULL WHERE id=$1 AND organization_id=$2`, [d.id, ctx.orgId, ctx.userId]);
    await activity(ctx, 'document', d.id, 'status_change', 'Document verified', null, { from: d.verification, to: 'verified' });
    await audit(ctx, 'document.verified', { type: 'document', id: d.id, label: d.name }, { verification: d.verification }, { verification: 'verified' });
    return { ok: true };
  });
  app.post('/api/v1/documents/:id/reject', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    const b = z.object({ reason: z.string().min(3, 'Give a reason so the person knows what to fix').max(500) }).parse(req.body);
    await q(`UPDATE documents SET verification='rejected', verified_by=$3, verified_at=now(), rejection_reason=$4 WHERE id=$1 AND organization_id=$2`, [d.id, ctx.orgId, ctx.userId, b.reason]);
    await activity(ctx, 'document', d.id, 'status_change', 'Document rejected', b.reason, { from: d.verification, to: 'rejected' });
    await audit(ctx, 'document.rejected', { type: 'document', id: d.id, label: d.name }, { verification: d.verification }, { verification: 'rejected' }, b.reason);
    if (d.entity_type === 'worker') {
      const w = await one<any>(`SELECT user_id FROM workers WHERE id=$1`, [d.entity_id]);
      if (w?.user_id && d.visibility === 'worker') await notify(ctx.orgId, [w.user_id], { event: 'document.rejected', title: `Please re-upload: ${d.name}`, body: b.reason, link: '/portal/worker/documents' });
    }
    return { ok: true };
  });
  app.post('/api/v1/documents/:id/archive', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'delete');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    await q(`UPDATE documents SET archived_at=now() WHERE id=$1 AND organization_id=$2`, [d.id, ctx.orgId]);
    await audit(ctx, 'document.archived', { type: 'document', id: d.id, label: d.name }, null, null, b.reason);
    await activity(ctx, 'document', d.id, 'system', 'Document archived', b.reason ?? null);
    return { ok: true };
  });
  app.post('/api/v1/documents/:id/restore', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    await q(`UPDATE documents SET archived_at=NULL WHERE id=$1 AND organization_id=$2`, [d.id, ctx.orgId]);
    await activity(ctx, 'document', d.id, 'system', 'Document restored');
    return { ok: true };
  });
  app.post('/api/v1/documents/:id/request-renewal', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const d = await getOr404<any>('documents', ctx, (req.params as any).id);
    const v = await enrich(ctx.orgId, { document_id: d.id });
    const email = v.person?.email ?? v.contact?.email;
    if (!email) throw conflict('No email address on file for the document owner');
    await sendTemplate(ctx.orgId, 'document_expiring', email, { ...v, document: { name: d.name, expiresAt: d.expires_at ?? 'soon' } }, { related: d.entity_type && d.entity_id ? { type: d.entity_type, id: d.entity_id } : undefined });
    await activity(ctx, 'document', d.id, 'email', 'Renewal requested', `Sent to ${email}`);
    return { ok: true, to: email };
  });

  // ── Document templates (versioned) ──
  app.get('/api/v1/document-templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const lp = listParams(req);
    const where = ['t.organization_id=$1', lp.filters.archived === 'true' ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.category) { params.push(lp.filters.category); where.push(`t.category=$${params.length}`); }
    return paged({ select: `t.id, t.name, t.category, t.version, left(t.body, 200) preview, t.archived_at, t.created_at, t.updated_at, (SELECT count(*) FROM signature_requests s WHERE s.template_id=t.id)::int sent, (SELECT count(*) FROM signature_requests s WHERE s.template_id=t.id AND s.status='signed')::int signed`,
      from: 'document_templates t', where, params, lp, searchCols: ['t.name', 't.body'], sortMap: { name: 't.name', updated_at: 't.updated_at', category: 't.category' }, defaultSort: 't.name ASC' });
  });
  app.get('/api/v1/document-templates/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const t = await getOr404<any>('document_templates', ctx, (req.params as any).id);
    const versions = await q(`SELECT v.id, v.version, v.body, v.note, v.created_at, u.name created_by_name FROM document_template_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.template_id=$1 ORDER BY v.version DESC`, [t.id]);
    const vars = [...new Set([...t.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m: any) => m[1]))];
    return { ...t, versions, variables: vars };
  });
  const tplZ = z.object({ name: z.string().min(1).max(160), category: z.enum(CATEGORIES).default('contract'), body: z.string().min(10, 'Template body is too short').max(50000) });
  app.post('/api/v1/document-templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'create');
    const b = tplZ.parse(req.body);
    const t = await tx(async c => {
      const r = (await c.query(`INSERT INTO document_templates (organization_id, name, category, version, body) VALUES ($1,$2,$3,1,$4) RETURNING *`, [ctx.orgId, b.name, b.category, b.body])).rows[0];
      await c.query(`INSERT INTO document_template_versions (organization_id, template_id, version, body, note, created_by) VALUES ($1,$2,1,$3,'Created',$4)`, [ctx.orgId, r.id, b.body, ctx.userId]);
      return r;
    });
    await audit(ctx, 'document_template.created', { type: 'document_template', id: t.id, label: t.name });
    return t;
  });
  app.patch('/api/v1/document-templates/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const t = await getOr404<any>('document_templates', ctx, (req.params as any).id);
    const b = tplZ.partial().extend({ note: z.string().max(200).optional() }).parse(req.body);
    return tx(async c => {
      let version = t.version;
      if (b.body !== undefined && b.body !== t.body) {
        version = (await c.query(`SELECT COALESCE(max(version),0)+1 n FROM document_template_versions WHERE template_id=$1`, [t.id])).rows[0].n;
        await c.query(`INSERT INTO document_template_versions (organization_id, template_id, version, body, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.orgId, t.id, version, b.body, b.note ?? null, ctx.userId]);
      }
      return (await c.query(`UPDATE document_templates SET name=COALESCE($3,name), category=COALESCE($4,category), body=COALESCE($5,body), version=$6, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [t.id, ctx.orgId, b.name ?? null, b.category ?? null, b.body ?? null, version])).rows[0];
    });
  });
  app.post('/api/v1/document-templates/:id/archive', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const t = await getOr404<any>('document_templates', ctx, (req.params as any).id);
    const b = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
    await q(`UPDATE document_templates SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END, updated_at=now() WHERE id=$1 AND organization_id=$2`, [t.id, ctx.orgId, b.archived]);
    return { ok: true };
  });
  const targetZ = z.object({ entity_type: z.enum(['worker', 'candidate', 'company', 'placement']).optional(), entity_id: z.string().uuid().optional(), version: z.number().int().optional() });
  app.post('/api/v1/document-templates/:id/preview', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const t = await getOr404<any>('document_templates', ctx, (req.params as any).id);
    const b = targetZ.extend({ body: z.string().max(50000).optional() }).parse(req.body ?? {});
    if (b.entity_type && b.entity_id) await assertEntity(ctx, b.entity_type, b.entity_id);
    let body = b.body ?? t.body;
    if (b.version && !b.body) body = (await one<any>(`SELECT body FROM document_template_versions WHERE template_id=$1 AND version=$2`, [t.id, b.version]))?.body ?? body;
    const vars = await docVars(ctx, b.entity_type, b.entity_id);
    const used = [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m: any) => m[1] as string))];
    return { body: render(body, vars), variables: used, missing: used.filter(k => render(`{{${k}}}`, vars) === '') };
  });
  // Generate → PDF document attached to the record (optionally sent for signature right away).
  app.post('/api/v1/document-templates/:id/generate', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'create');
    const t = await getOr404<any>('document_templates', ctx, (req.params as any).id);
    if (t.archived_at) throw conflict('This template is archived');
    const b = targetZ.extend({ name: z.string().max(200).optional(), visibility: z.enum(VISIBILITY).optional(), expires_at: z.string().optional(),
      send: z.object({ signer_name: z.string().min(1).max(160), signer_email: z.string().email(), message: z.string().max(1000).optional() }).optional() }).parse(req.body);
    if (!b.entity_type || !b.entity_id) throw badRequest('Choose the record this document is for');
    await assertEntity(ctx, b.entity_type, b.entity_id);
    const vars = await docVars(ctx, b.entity_type, b.entity_id);
    const body = render(t.body, vars);
    const name = b.name || `${t.name} — ${vars.party?.name || vars.worker?.name || vars.candidate?.name || ''}`.replace(/ — $/, '');
    const pdf = await renderDocumentPdf({ orgName: ctx.org.name, title: t.name, body, footer: `${t.name} · template v${t.version} · generated ${new Date().toISOString().slice(0, 10)} by ${ctx.user.name}` });
    const rel = saveFile(`documents/${ctx.orgId}`, `${t.name}.pdf`, pdf);
    const visibility = b.visibility ?? (b.entity_type === 'company' ? 'client' : b.entity_type === 'candidate' ? 'candidate' : b.entity_type === 'worker' || b.entity_type === 'placement' ? 'worker' : 'internal');
    const d = await insertRow<any>('documents', { organization_id: ctx.orgId, entity_type: b.entity_type, entity_id: b.entity_id, name, category: t.category, file: rel, mime: 'application/pdf', size_bytes: pdf.length, visibility, issue_date: new Date().toISOString().slice(0, 10), expires_at: isoOrNull(b.expires_at), verification: 'verified', verified_by: ctx.userId, verified_at: new Date().toISOString(), created_by: ctx.userId });
    await activity(ctx, 'document', d.id, 'system', `Generated from template "${t.name}" (v${t.version})`);
    await activity(ctx, b.entity_type, b.entity_id, 'system', `Document generated: ${name}`, null, { document_id: d.id });
    let signature = null;
    if (b.send) signature = await createSignatureRequest(ctx, { documentId: d.id, templateId: t.id, templateVersion: t.version, entityType: b.entity_type, entityId: b.entity_id, title: t.name, body, signerName: b.send.signer_name, signerEmail: b.send.signer_email, message: b.send.message });
    return { document: { ...d, file: undefined }, signature: signature ? { id: signature.id, status: signature.status } : null };
  });

  // ── Signatures ──
  app.get('/api/v1/signatures', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const lp = listParams(req);
    const where = ['s.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) {
      if (lp.filters.status === 'open') where.push(`s.status IN ('sent','viewed')`);
      else { params.push(lp.filters.status); where.push(`s.status=$${params.length}`); }
    }
    if (lp.filters.entity_id) { params.push(lp.filters.entity_id); where.push(`s.entity_id::text=$${params.length}`); }
    const r = await paged<any>({ select: `s.id, s.title, s.signer_name, s.signer_email, s.status, s.created_at, s.viewed_at, s.signed_at, s.signed_ip, s.expires_at, s.document_id, s.signed_document_id, s.entity_type, s.entity_id, s.declined_reason,
        (s.status IN ('sent','viewed') AND s.expires_at < now()) overdue, ${entityLabelSql('s.entity_type', 's.entity_id')} entity_label, u.name created_by_name, t.name template_name`,
      from: 'signature_requests s LEFT JOIN users u ON u.id=s.created_by LEFT JOIN document_templates t ON t.id=s.template_id', where, params, lp,
      searchCols: ['s.title', 's.signer_name', 's.signer_email'], sortMap: { created_at: 's.created_at', signed_at: 's.signed_at', status: 's.status' }, defaultSort: 's.created_at DESC' });
    r.rows = r.rows.map(x => ({ ...x, entity_link: linkFor(x.entity_type, x.entity_id) }));
    const counts = await one<any>(`SELECT count(*) FILTER (WHERE status IN ('sent','viewed'))::int open, count(*) FILTER (WHERE status='viewed')::int viewed, count(*) FILTER (WHERE status='signed')::int signed, count(*) FILTER (WHERE status='declined')::int declined, count(*) FILTER (WHERE status='signed' AND signed_at > now() - interval '30 days')::int signed_30d FROM signature_requests WHERE organization_id=$1`, [ctx.orgId]);
    return { ...r, counts };
  });
  app.post('/api/v1/signatures', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'create');
    const b = z.object({ document_id: z.string().uuid(), signer_name: z.string().min(1).max(160), signer_email: z.string().email(), message: z.string().max(1000).optional(), expires_in_days: z.number().int().min(1).max(90).default(14), title: z.string().max(200).optional() }).parse(req.body);
    const d = await getOr404<any>('documents', ctx, b.document_id);
    if (d.signature_status === 'signed') throw conflict('This document is already signed');
    const open = await one(`SELECT 1 FROM signature_requests WHERE document_id=$1 AND status IN ('sent','viewed') AND lower(signer_email)=lower($2)`, [d.id, b.signer_email]);
    if (open) throw conflict('A signature request for this signer is already open — send a reminder instead');
    const body = `Please review and sign "${d.name}".\n\n${b.message ?? ''}`.trim();
    const sr = await createSignatureRequest(ctx, { documentId: d.id, templateId: null, entityType: d.entity_type, entityId: d.entity_id, title: b.title || d.name, body, signerName: b.signer_name, signerEmail: b.signer_email, message: b.message, expiresInDays: b.expires_in_days });
    return { id: sr.id, status: sr.status };
  });
  app.get('/api/v1/signatures/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'view');
    const s = await getOr404<any>('signature_requests', ctx, (req.params as any).id);
    return { ...s, token: undefined, signature_data: s.signature_data ? s.signature_data : null, sign_url: ['sent', 'viewed'].includes(s.status) ? `${WEB_URL}/sign/${s.token}` : null };
  });
  app.post('/api/v1/signatures/:id/remind', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const s = await getOr404<any>('signature_requests', ctx, (req.params as any).id);
    if (!['sent', 'viewed'].includes(s.status)) throw conflict(`This request is ${s.status}`);
    await rateLimit(`sig-remind:${s.id}`, 3, 3600);
    await q(`UPDATE signature_requests SET expires_at=GREATEST(expires_at, now() + interval '7 days') WHERE id=$1`, [s.id]);
    await sendTemplate(ctx.orgId, 'signature_request', s.signer_email, { signer: { name: s.signer_name }, document: { title: `Reminder — ${s.title}` }, org: { name: ctx.org.name }, link: `${WEB_URL}/sign/${s.token}` }, { related: s.entity_type && s.entity_id ? { type: s.entity_type, id: s.entity_id } : undefined });
    return { ok: true };
  });
  app.post('/api/v1/signatures/:id/cancel', async (req) => {
    const ctx = staff(req);
    need(ctx, 'documents', 'edit');
    const s = await getOr404<any>('signature_requests', ctx, (req.params as any).id);
    if (!['sent', 'viewed'].includes(s.status)) throw conflict(`This request is already ${s.status}`);
    const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    await q(`UPDATE signature_requests SET status='expired', declined_reason=$2 WHERE id=$1`, [s.id, b.reason ? `Cancelled: ${b.reason}` : 'Cancelled by sender']);
    if (s.document_id) await q(`UPDATE documents SET signature_status=NULL WHERE id=$1 AND signature_status='pending' AND NOT EXISTS (SELECT 1 FROM signature_requests x WHERE x.document_id=$1 AND x.id<>$2 AND x.status IN ('sent','viewed'))`, [s.document_id, s.id]);
    await audit(ctx, 'signature.cancelled', { type: 'signature_request', id: s.id, label: s.title }, null, null, b.reason);
    return { ok: true };
  });

  // ── Public signing page API (no login; the token is the credential) ──
  async function byToken(token: string) {
    if (!/^[\w-]{20,64}$/.test(token)) throw notFound();
    const s = await one<any>(`SELECT s.*, o.name org_name, b.logo_text, b.primary_color, b.hide_powered_by FROM signature_requests s JOIN organizations o ON o.id=s.organization_id LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE s.token=$1`, [token]);
    if (!s) throw notFound();
    return s;
  }
  app.get('/api/v1/public/sign/:token', { config: { public: true } }, async (req) => {
    await rateLimit(`sign-view:${req.ip}`, 120, 600);
    const s = await byToken((req.params as any).token);
    const expired = ['sent', 'viewed'].includes(s.status) && s.expires_at && new Date(s.expires_at) < new Date();
    if (s.status === 'sent' && !expired) {
      await q(`UPDATE signature_requests SET status='viewed', viewed_at=now() WHERE id=$1 AND status='sent'`, [s.id]);
      if (s.document_id) await activity({ orgId: s.organization_id, userId: null }, 'document', s.document_id, 'system', 'Signature request opened', `${s.signer_name} viewed the document`);
    }
    const doc = s.document_id ? await one<any>(`SELECT file, name, mime FROM documents WHERE id=$1`, [s.document_id]) : null;
    const signed = s.signed_document_id ? await one<any>(`SELECT file, name FROM documents WHERE id=$1`, [s.signed_document_id]) : null;
    return {
      title: s.title, body: s.rendered_body, message: s.message, signer_name: s.signer_name, signer_email: s.signer_email.replace(/^(.).*(@.*)$/, '$1•••$2'),
      status: expired ? 'expired' : s.status === 'sent' ? 'viewed' : s.status, signed_at: s.signed_at, signed_name: s.signed_name, expires_at: s.expires_at,
      org: { name: s.org_name, logo_text: s.logo_text, primary_color: s.primary_color, hide_powered_by: s.hide_powered_by },
      document_url: doc?.file ? signedUrl(doc.file, 1800) : null, document_mime: doc?.mime ?? null,
      signed_url: signed?.file ? signedUrl(signed.file, 1800, { download: `${signed.name.replace(/[^\w .\-]+/g, '')}.pdf` }) : null,
    };
  });
  app.post('/api/v1/public/sign/:token', { config: { public: true } }, async (req) => {
    await rateLimit(`sign-post:${req.ip}`, 10, 600);
    const s = await byToken((req.params as any).token);
    const b = z.object({ typed_name: z.string().trim().min(2, 'Type your full name').max(160), signature_data: z.string().startsWith('data:image/png;base64,', 'Draw your signature').max(700_000, 'Signature image is too large'), agree: z.literal(true, { errorMap: () => ({ message: 'You must agree to sign electronically' }) }) }).parse(req.body);
    if (!['sent', 'viewed'].includes(s.status)) throw conflict(`This document is already ${s.status}`);
    if (s.expires_at && new Date(s.expires_at) < new Date()) throw conflict('This signing link has expired. Ask the sender for a new one.');
    const png = Buffer.from(b.signature_data.slice('data:image/png;base64,'.length), 'base64');
    if (png.length < 100 || png.subarray(1, 4).toString() !== 'PNG') throw badRequest('Draw your signature before signing');
    const signedAt = new Date().toISOString();
    const ua = String(req.headers['user-agent'] ?? 'unknown').slice(0, 300);
    const cert = { requestId: s.id, documentTitle: s.title, signerName: s.signer_name, signerEmail: s.signer_email, typedName: b.typed_name, signedAt, ip: req.ip, userAgent: ua, sentAt: new Date(s.created_at).toISOString(), viewedAt: s.viewed_at ? new Date(s.viewed_at).toISOString() : null, contentSha256: crypto.createHash('sha256').update(s.rendered_body).digest('hex'), orgName: s.org_name };
    const pdf = await renderSignedPdf({ orgName: s.org_name, title: s.title, body: s.rendered_body, signaturePng: png, cert });
    const rel = saveFile(`documents/${s.organization_id}/signed`, `${s.title}-signed.pdf`, pdf);
    const orig = s.document_id ? await one<any>(`SELECT * FROM documents WHERE id=$1`, [s.document_id]) : null;
    const tpl = s.template_id ? await one<any>(`SELECT category FROM document_templates WHERE id=$1`, [s.template_id]) : null;
    const sys = { orgId: s.organization_id, userId: null };
    const signedDoc = await tx(async c => {
      // Re-check under lock so a double submit cannot sign twice.
      const lock = (await c.query(`SELECT status FROM signature_requests WHERE id=$1 FOR UPDATE`, [s.id])).rows[0];
      if (!['sent', 'viewed'].includes(lock.status)) throw conflict('This document was already signed');
      const visibility = orig?.visibility ?? (s.entity_type === 'company' ? 'client' : s.entity_type === 'candidate' ? 'candidate' : s.entity_type ? 'worker' : 'internal');
      const d = (await c.query(`INSERT INTO documents (organization_id, entity_type, entity_id, name, category, file, mime, size_bytes, visibility, issue_date, verification, verified_at, signature_status, source_document_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,current_date,'verified',now(),'signed',$9,$10) RETURNING *`,
        [s.organization_id, s.entity_type, s.entity_id, `${s.title} — signed by ${s.signer_name}`.slice(0, 200), orig?.category ?? tpl?.category ?? 'contract', rel, pdf.length, visibility, orig?.id ?? null, s.created_by])).rows[0];
      await c.query(`UPDATE signature_requests SET status='signed', signed_name=$2, signature_data=$3, signed_at=$4, signed_ip=$5, user_agent=$6, certificate=$7, signed_document_id=$8 WHERE id=$1`, [s.id, b.typed_name, b.signature_data, signedAt, req.ip, ua, JSON.stringify(cert), d.id]);
      if (orig) await c.query(`UPDATE documents SET signature_status='signed' WHERE id=$1`, [orig.id]);
      return d;
    });
    if (orig) await activity(sys, 'document', orig.id, 'status_change', `Signed by ${s.signer_name}`, `Typed name "${b.typed_name}" · IP ${req.ip}`, { signed_document_id: signedDoc.id });
    await activity(sys, 'document', signedDoc.id, 'system', 'Signed copy with signature certificate created', `Signed by ${s.signer_name} at ${signedAt}`);
    if (s.entity_type && s.entity_id && ENTITY_TABLES[s.entity_type]) await activity(sys, s.entity_type, s.entity_id, 'status_change', `"${s.title}" signed by ${s.signer_name}`, null, { document_id: signedDoc.id });
    await audit({ orgId: s.organization_id, userId: s.signer_user_id ?? null, user: { id: s.signer_user_id ?? '', name: s.signer_name, email: s.signer_email, avatar_color: null }, impersonatorId: null, ip: req.ip } as any, 'document.signed', { type: 'signature_request', id: s.id, label: s.title }, null, { signed_document_id: signedDoc.id, typed_name: b.typed_name });
    // A signed contractor agreement completes the matching onboarding item and is linked to the placement.
    if (signedDoc.category === 'contract' && (s.entity_type === 'worker' || s.entity_type === 'placement')) {
      const pls = await q<any>(`SELECT id FROM placements WHERE organization_id=$1 AND status IN ('onboarding','active','on_leave','notice') AND ${s.entity_type === 'worker' ? 'worker_id' : 'id'}=$2`, [s.organization_id, s.entity_id]);
      for (const p of pls) {
        await q(`UPDATE placement_onboarding_items SET done_at=now() WHERE placement_id=$1 AND done_at IS NULL AND title ILIKE '%agreement%'`, [p.id]);
        await q(`UPDATE placements SET contract_document_id=COALESCE(contract_document_id, $2) WHERE id=$1`, [p.id, signedDoc.id]);
      }
    }
    if (s.created_by) await notify(s.organization_id, [s.created_by], { event: 'document.signed', title: `${s.signer_name} signed "${s.title}"`, body: `Signed ${signedAt.slice(0, 16).replace('T', ' ')} UTC`, link: `/documents/${signedDoc.id}` });
    await emit(s.organization_id, 'document.signed', { document_id: signedDoc.id, signature_request_id: s.id, signer: { name: s.signer_name }, entity_type: s.entity_type, entity_id: s.entity_id });
    return { ok: true, signed_at: signedAt, signed_url: signedUrl(rel, 1800, { download: `${s.title.replace(/[^\w .\-]+/g, '')} (signed).pdf` }) };
  });
  app.post('/api/v1/public/sign/:token/decline', { config: { public: true } }, async (req) => {
    await rateLimit(`sign-post:${req.ip}`, 10, 600);
    const s = await byToken((req.params as any).token);
    const b = z.object({ reason: z.string().trim().min(3, 'Tell the sender why').max(500) }).parse(req.body);
    if (!['sent', 'viewed'].includes(s.status)) throw conflict(`This document is already ${s.status}`);
    await q(`UPDATE signature_requests SET status='declined', declined_reason=$2 WHERE id=$1`, [s.id, b.reason]);
    if (s.document_id) await q(`UPDATE documents SET signature_status=NULL WHERE id=$1`, [s.document_id]);
    if (s.document_id) await activity({ orgId: s.organization_id, userId: null }, 'document', s.document_id, 'status_change', `Signature declined by ${s.signer_name}`, b.reason);
    if (s.created_by) await notify(s.organization_id, [s.created_by], { event: 'document.declined', title: `${s.signer_name} declined to sign "${s.title}"`, body: b.reason, link: '/documents/signatures?status=declined' });
    return { ok: true };
  });

  // ── Portal documents (client + worker) ──
  for (const kind of ['client', 'worker'] as const) {
    app.get(`/api/v1/portal/${kind}/documents`, async (req) => {
      const ctx = portalCtx(req, kind);
      const params: unknown[] = [ctx.orgId];
      const w = portalDocWhere(ctx, kind, params);
      const docs = await q<any>(`SELECT d.id, d.name, d.category, d.mime, d.size_bytes, d.issue_date, d.expires_at, d.verification, d.rejection_reason, d.signature_status, d.created_at, d.created_by = $${params.length + 1} uploaded_by_me, ${expirySql} expiry_status
        FROM documents d WHERE d.organization_id=$1 AND d.archived_at IS NULL AND ${w} AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL) ORDER BY d.created_at DESC LIMIT 300`, [...params, ctx.userId]);
      const sigs = await q<any>(`SELECT id, title, status, created_at, signed_at, expires_at, token, signed_document_id FROM signature_requests WHERE organization_id=$1 AND (signer_user_id=$2 OR lower(signer_email)=lower($3)) ORDER BY (status IN ('sent','viewed')) DESC, created_at DESC LIMIT 50`, [ctx.orgId, ctx.userId, ctx.user.email]);
      return { documents: docs, signatures: sigs.map(s => ({ ...s, token: undefined, sign_url: ['sent', 'viewed'].includes(s.status) && (!s.expires_at || new Date(s.expires_at) > new Date()) ? `/sign/${s.token}` : null })) };
    });
    app.get(`/api/v1/portal/${kind}/documents/:id/download`, async (req) => {
      const ctx = portalCtx(req, kind);
      const id = (req.params as any).id;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
      const params: unknown[] = [ctx.orgId, id];
      const w = portalDocWhere(ctx, kind, params);
      const d = await one<any>(`SELECT d.* FROM documents d WHERE d.organization_id=$1 AND d.id=$2 AND d.archived_at IS NULL AND ${w}`, params);
      if (!d || !d.file) throw notFound();
      return { url: signedUrl(d.file, 300, { download: (req.query as any).inline ? undefined : dlName(d) }) };
    });
    app.post(`/api/v1/portal/${kind}/documents`, async (req) => {
      const ctx = portalCtx(req, kind);
      await rateLimit(`portal-upload:${ctx.userId}`, 30, 3600);
      const { file, fields } = await readUpload(req);
      if (!file) throw badRequest('Choose a file to upload');
      const b = z.object({ name: z.string().max(200).optional(), category: z.enum(kind === 'worker' ? ['id', 'compliance', 'general', 'contract'] as const : ['contract', 'policy', 'general'] as const).default('general'), expires_at: z.string().optional(), replaces_id: z.string().uuid().optional() }).parse(fields);
      let src: any = null;
      if (b.replaces_id) {
        const params: unknown[] = [ctx.orgId, b.replaces_id];
        src = await one<any>(`SELECT d.* FROM documents d WHERE d.organization_id=$1 AND d.id=$2 AND ${portalDocWhere(ctx, kind, params)}`, params);
        if (!src) throw notFound();
      }
      const rel = saveFile(`documents/${ctx.orgId}`, file.filename, file.buf);
      const d = await insertRow<any>('documents', { organization_id: ctx.orgId, entity_type: kind === 'client' ? 'company' : 'worker', entity_id: kind === 'client' ? ctx.companyId : ctx.workerId, name: (b.name || file.filename.replace(/\.[^.]+$/, '')).slice(0, 200), category: src?.category ?? b.category, file: rel, mime: file.mime, size_bytes: file.buf.length, visibility: kind, expires_at: isoOrNull(b.expires_at), verification: 'unverified', source_document_id: src?.id ?? null, created_by: ctx.userId });
      const sys = { orgId: ctx.orgId, userId: ctx.userId };
      await activity(sys, 'document', d.id, 'system', `Uploaded by ${ctx.user.name} in the ${kind} portal`, src ? `Renewal of "${src.name}"` : null);
      await activity(sys, kind === 'client' ? 'company' : 'worker', d.entity_id, 'system', `${ctx.user.name} uploaded ${d.name}`, null, { document_id: d.id });
      await notify(ctx.orgId, await docWatchers(ctx.orgId, d), { event: 'document.uploaded', title: `${ctx.user.name} uploaded "${d.name}"`, body: 'Review and verify it in Documents.', link: `/documents/${d.id}` });
      await emit(ctx.orgId, 'document.uploaded', { document_id: d.id, uploaded_by: ctx.user.name, entity_type: d.entity_type, entity_id: d.entity_id, category: d.category });
      return { id: d.id, name: d.name, verification: d.verification };
    });
  }

  // ── Worker portal: tasks (assigned tasks + action items: signatures, onboarding, renewals) ──
  app.get('/api/v1/portal/worker/tasks', async (req) => {
    const ctx = portalCtx(req, 'worker');
    const tasks = await q<any>(`SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.completed_at, (t.due_date < current_date AND t.status IN ('open','in_progress')) overdue
      FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id AND ta.user_id=$2 WHERE t.organization_id=$1 AND t.archived_at IS NULL AND (t.status IN ('open','in_progress') OR t.completed_at > now() - interval '30 days')
      ORDER BY (t.status IN ('open','in_progress')) DESC, t.due_date NULLS LAST, t.created_at DESC LIMIT 200`, [ctx.orgId, ctx.userId]);
    const sigs = await q<any>(`SELECT id, title, created_at, expires_at, token FROM signature_requests WHERE organization_id=$1 AND status IN ('sent','viewed') AND (expires_at IS NULL OR expires_at > now()) AND (signer_user_id=$2 OR lower(signer_email)=lower($3)) ORDER BY created_at`, [ctx.orgId, ctx.userId, ctx.user.email]);
    const onboarding = await q<any>(`SELECT i.id, i.title, i.required, p.title placement_title, co.name company_name FROM placement_onboarding_items i JOIN placements p ON p.id=i.placement_id JOIN companies co ON co.id=p.company_id
      WHERE i.organization_id=$1 AND p.worker_id=$2 AND i.owner='worker' AND i.done_at IS NULL AND p.status IN ('onboarding','active') ORDER BY i.required DESC, i.sort`, [ctx.orgId, ctx.workerId]);
    const params: unknown[] = [ctx.orgId];
    const w = portalDocWhere(ctx, 'worker', params);
    const renewals = await q<any>(`SELECT d.id, d.name, d.expires_at, (d.expires_at < current_date) expired FROM documents d WHERE d.organization_id=$1 AND d.archived_at IS NULL AND d.expires_at <= current_date + 30 AND ${w} AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL) ORDER BY d.expires_at`, params);
    const rejected = await q<any>(`SELECT d.id, d.name, d.rejection_reason FROM documents d WHERE d.organization_id=$1 AND d.archived_at IS NULL AND d.verification='rejected' AND ${w} AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.source_document_id=d.id AND n.archived_at IS NULL)`, params);
    return { tasks, signatures: sigs.map(s => ({ id: s.id, title: s.title, created_at: s.created_at, expires_at: s.expires_at, sign_url: `/sign/${s.token}` })), onboarding, renewals, rejected };
  });
  app.post('/api/v1/portal/worker/tasks/:id/status', async (req) => {
    const ctx = portalCtx(req, 'worker');
    const b = z.object({ status: z.enum(['open', 'in_progress', 'done']) }).parse(req.body);
    const id = (req.params as any).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const t = await one<any>(`SELECT t.* FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id AND ta.user_id=$3 WHERE t.id=$1 AND t.organization_id=$2`, [id, ctx.orgId, ctx.userId]);
    if (!t) throw notFound();
    await q(`UPDATE tasks SET status=$2, completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`, [id, b.status]);
    await activity({ orgId: ctx.orgId, userId: ctx.userId }, 'task', id, 'status_change', b.status === 'done' ? `Completed by ${ctx.user.name} (worker portal)` : `Reopened by ${ctx.user.name}`, null, { from: t.status, to: b.status });
    if (b.status === 'done' && t.created_by) await notify(ctx.orgId, [t.created_by], { event: 'task.completed', title: `${ctx.user.name} completed "${t.title}"`, link: `/crm/tasks?task=${id}` });
    return { ok: true };
  });

}
