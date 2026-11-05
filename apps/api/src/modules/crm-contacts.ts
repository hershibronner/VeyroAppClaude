// CRM — Contacts: people with multiple contact methods, optional & changeable company link, primary flag.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, can, type Ctx } from '../core/context';
import { notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { listParams, paged } from '../core/list';
import { optStr, optEmail, optUuid, insertContact, syncContactPrimary, assertScope, isUuid, fieldError } from './_crm/util';

const methodInput = z.object({ kind: z.enum(['email', 'phone', 'whatsapp']), value: z.string().trim().min(3, 'Enter a value').max(200), label: optStr(40), is_primary: z.boolean().optional() })
  .superRefine((m, c) => { if (m.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.value)) c.addIssue({ code: 'custom', path: ['value'], message: 'Enter a valid email' }); });
const contactBody = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(100), last_name: optStr(100), title: optStr(120),
  company_id: optUuid, is_primary: z.boolean().optional(), notes: optStr(5000), email: optEmail, phone: optStr(40),
  methods: z.array(methodInput).max(20).optional(),
});

async function contactOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const c = await one<any>(`SELECT * FROM contacts WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
  if (!c) throw notFound();
  return c;
}
async function companyName(ctx: Ctx, id: string | null) {
  if (!id) return null;
  const c = await one<any>(`SELECT id, name, stage FROM companies WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
  if (!c) fieldError('company_id', 'Company not found in this workspace');
  return c;
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/contacts', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId];
    const where = ['ct.organization_id=$1', 'ct.archived_at IS NULL'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (isUuid(f.company_id)) add('ct.company_id = ?', f.company_id);
    if (f.has_company === 'false') where.push('ct.company_id IS NULL'); else if (f.has_company === 'true') where.push('ct.company_id IS NOT NULL');
    if (f.primary === 'true') where.push('ct.is_primary'); else if (f.primary === 'false') where.push('NOT ct.is_primary');
    if (f.stage === 'lead') where.push(`co.stage IN ('lead','qualified')`); else if (f.stage === 'client') where.push(`co.stage IN ('client','inactive')`);
    if (f.portal === 'true') where.push(`EXISTS (SELECT 1 FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=ct.organization_id AND m.company_id=ct.company_id AND lower(u.email)=lower(ct.email) AND m.status='active')`);
    return paged({
      select: `ct.id, ct.first_name, ct.last_name, concat_ws(' ', ct.first_name, ct.last_name) name, ct.title, ct.email, ct.phone, ct.is_primary, ct.company_id, co.name company_name, co.stage company_stage, ct.created_at,
        (SELECT count(*) FROM contact_methods m WHERE m.contact_id=ct.id)::int methods_count,
        (SELECT max(a.created_at) FROM activities a WHERE a.organization_id=ct.organization_id AND a.entity_type='contact' AND a.entity_id=ct.id) last_activity_at`,
      from: 'contacts ct LEFT JOIN companies co ON co.id=ct.company_id',
      where, params, lp, searchCols: ["concat_ws(' ', ct.first_name, ct.last_name)", 'ct.email', 'ct.phone', 'ct.title', 'co.name', `(SELECT string_agg(value, ' ') FROM contact_methods m WHERE m.contact_id=ct.id)`],
      sortMap: { name: 'ct.first_name', company_name: 'co.name', created_at: 'ct.created_at', title: 'ct.title', last_activity_at: 'last_activity_at' }, defaultSort: 'ct.first_name ASC, ct.last_name ASC',
    });
  });

  app.get('/api/v1/contacts/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'view');
    const c = await contactOr404(ctx, (req.params as any).id);
    const [methods, company, creator, opps, portal, companies] = await Promise.all([
      q<any>(`SELECT id, kind, value, label, is_primary, created_at FROM contact_methods WHERE contact_id=$1 ORDER BY kind, is_primary DESC, created_at`, [c.id]),
      c.company_id ? one<any>(`SELECT co.id, co.name, co.stage, co.industry, u.name account_manager_name FROM companies co LEFT JOIN users u ON u.id=co.account_manager_id WHERE co.id=$1`, [c.company_id]) : null,
      one<any>(`SELECT name FROM users WHERE id=$1`, [c.created_by]),
      can(ctx, 'opportunities', 'view') ? q<any>(`SELECT o.id, o.name, o.stage, o.value_cents, o.currency, co.name company_name FROM opportunities o LEFT JOIN companies co ON co.id=o.company_id WHERE o.organization_id=$1 AND o.contact_id=$2 AND o.archived_at IS NULL ORDER BY o.created_at DESC`, [ctx.orgId, c.id]) : [],
      c.email && c.company_id ? one<any>(`SELECT m.status, r.name role_name, u.last_login_at FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND lower(u.email)=lower($3)`, [ctx.orgId, c.company_id, c.email]) : null,
      q<any>(`SELECT co.id, co.name, co.stage, cc.role FROM company_contacts cc JOIN companies co ON co.id=cc.company_id WHERE cc.contact_id=$1 AND cc.organization_id=$2 ORDER BY co.name`, [c.id, ctx.orgId]),
    ]);
    return { ...c, name: [c.first_name, c.last_name].filter(Boolean).join(' '), methods, company, created_by_name: creator?.name ?? null, opportunities: opps, portal_access: portal, company_history: companies };
  });

  app.post('/api/v1/contacts', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'create');
    const b = contactBody.parse(req.body);
    const co = await companyName(ctx, b.company_id ?? null);
    const row = await tx(async db => {
      const r = await insertContact(ctx, { ...b, company_id: co?.id ?? null }, db);
      await activity(ctx, 'contact', r.id, 'system', 'Contact created', co ? `Linked to ${co.name}` : null, {}, db);
      if (co) await activity(ctx, 'company', co.id, 'system', `Contact added: ${[b.first_name, b.last_name].filter(Boolean).join(' ')}`, b.title ?? null, { contact_id: r.id }, db);
      return r;
    });
    return one(`SELECT * FROM contacts WHERE id=$1`, [row.id]);
  });

  app.patch('/api/v1/contacts/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'edit');
    const c = await contactOr404(ctx, (req.params as any).id);
    const b = contactBody.partial().omit({ methods: true, email: true, phone: true }).parse(req.body);
    const changingCompany = 'company_id' in b && (b.company_id ?? null) !== c.company_id;
    const newCo = changingCompany ? await companyName(ctx, b.company_id ?? null) : null;
    const oldCo = changingCompany && c.company_id ? await one<any>(`SELECT id, name FROM companies WHERE id=$1`, [c.company_id]) : null;
    return tx(async db => {
      const patch: Record<string, unknown> = {};
      for (const k of ['first_name', 'last_name', 'title', 'notes', 'is_primary', 'company_id'] as const) if (k in b) patch[k] = (b as any)[k] ?? (k === 'is_primary' ? false : null);
      if (changingCompany && !newCo) patch.is_primary = false;
      const keys = Object.keys(patch);
      if (!keys.length) return c;
      const row = (await db.query(`UPDATE contacts SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [c.id, ctx.orgId, ...Object.values(patch)])).rows[0];
      if (changingCompany) {
        if (c.company_id) await db.query(`DELETE FROM company_contacts WHERE company_id=$1 AND contact_id=$2`, [c.company_id, c.id]);
        if (newCo) await db.query(`INSERT INTO company_contacts (organization_id, company_id, contact_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.orgId, newCo.id, c.id, row.title]);
        const msg = oldCo && newCo ? `Moved from ${oldCo.name} to ${newCo.name}` : newCo ? `Linked to ${newCo.name}` : `Unlinked from ${oldCo?.name ?? 'company'}`;
        await activity(ctx, 'contact', c.id, 'system', msg, null, { from: c.company_id, to: newCo?.id ?? null }, db);
        if (oldCo) await activity(ctx, 'company', oldCo.id, 'system', `Contact ${row.first_name} ${row.last_name ?? ''} unlinked`.trim(), null, { contact_id: c.id }, db);
        if (newCo) await activity(ctx, 'company', newCo.id, 'system', `Contact ${row.first_name} ${row.last_name ?? ''} linked`.trim(), null, { contact_id: c.id }, db);
      } else {
        await activity(ctx, 'contact', c.id, 'system', `Updated ${keys.map(k => k.replace(/_/g, ' ')).join(', ')}`, null, {}, db);
      }
      if (row.is_primary && row.company_id) {
        await db.query(`UPDATE contacts SET is_primary=false WHERE company_id=$1 AND id<>$2 AND organization_id=$3`, [row.company_id, row.id, ctx.orgId]);
        if (!c.is_primary || changingCompany) await activity(ctx, 'company', row.company_id, 'system', `Primary contact set to ${row.first_name} ${row.last_name ?? ''}`.trim(), null, { contact_id: c.id }, db);
      }
      return row;
    });
  });

  // ── Contact methods ──
  app.post('/api/v1/contacts/:id/methods', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'edit');
    const c = await contactOr404(ctx, (req.params as any).id);
    const m = methodInput.parse(req.body);
    const out = await tx(async db => {
      const hasAny = (await db.query(`SELECT 1 FROM contact_methods WHERE contact_id=$1 AND (kind=$2 OR ($2 <> 'email' AND kind <> 'email')) LIMIT 1`, [c.id, m.kind])).rows.length > 0;
      const primary = m.is_primary || !hasAny;
      if (primary) await db.query(`UPDATE contact_methods SET is_primary=false WHERE contact_id=$1 AND (CASE WHEN $2='email' THEN kind='email' ELSE kind<>'email' END)`, [c.id, m.kind]);
      const r = (await db.query(`INSERT INTO contact_methods (organization_id, contact_id, kind, value, label, is_primary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, c.id, m.kind, m.value, m.label ?? null, primary])).rows[0];
      await syncContactPrimary(c.id, db);
      await activity(ctx, 'contact', c.id, 'system', `Added ${m.kind} ${m.value}`, null, {}, db);
      return r;
    });
    return out;
  });
  app.patch('/api/v1/contacts/:id/methods/:mid', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'edit');
    const c = await contactOr404(ctx, (req.params as any).id);
    const { mid } = req.params as any;
    if (!isUuid(mid)) throw notFound();
    const cur = await one<any>(`SELECT * FROM contact_methods WHERE id=$1 AND contact_id=$2`, [mid, c.id]);
    if (!cur) throw notFound();
    const b = z.object({ value: z.string().trim().min(3).max(200).optional(), label: optStr(40), is_primary: z.boolean().optional() }).parse(req.body);
    if (b.value && cur.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.value)) fieldError('value', 'Enter a valid email');
    return tx(async db => {
      if (b.is_primary) await db.query(`UPDATE contact_methods SET is_primary=false WHERE contact_id=$1 AND (CASE WHEN $2='email' THEN kind='email' ELSE kind<>'email' END)`, [c.id, cur.kind]);
      const r = (await db.query(`UPDATE contact_methods SET value=COALESCE($2,value), label=CASE WHEN $3::boolean THEN $4 ELSE label END, is_primary=COALESCE($5,is_primary) WHERE id=$1 RETURNING *`, [mid, b.value ?? null, 'label' in b, b.label ?? null, b.is_primary ?? null])).rows[0];
      await syncContactPrimary(c.id, db);
      await activity(ctx, 'contact', c.id, 'system', b.is_primary ? `Primary ${cur.kind} set to ${r.value}` : `Updated ${cur.kind} ${r.value}`, null, {}, db);
      return r;
    });
  });
  app.delete('/api/v1/contacts/:id/methods/:mid', async (req) => {
    const ctx = staff(req); need(ctx, 'contacts', 'edit');
    const c = await contactOr404(ctx, (req.params as any).id);
    const { mid } = req.params as any;
    if (!isUuid(mid)) throw notFound();
    return tx(async db => {
      const cur = (await db.query(`DELETE FROM contact_methods WHERE id=$1 AND contact_id=$2 RETURNING *`, [mid, c.id])).rows[0];
      if (!cur) throw notFound();
      if (cur.is_primary) await db.query(`UPDATE contact_methods SET is_primary=true WHERE id = (SELECT id FROM contact_methods WHERE contact_id=$1 AND (CASE WHEN $2='email' THEN kind='email' ELSE kind<>'email' END) ORDER BY created_at LIMIT 1)`, [c.id, cur.kind]);
      await syncContactPrimary(c.id, db);
      await activity(ctx, 'contact', c.id, 'system', `Removed ${cur.kind} ${cur.value}`, null, {}, db);
      return { ok: true };
    });
  });

  // Archive (Sales: own contacts only)
  app.delete('/api/v1/contacts/:id', async (req) => {
    const ctx = staff(req);
    const c = await contactOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'contacts', 'delete', c);
    await q(`UPDATE contacts SET archived_at=now(), is_primary=false, updated_at=now() WHERE id=$1 AND organization_id=$2`, [c.id, ctx.orgId]);
    await activity(ctx, 'contact', c.id, 'system', 'Contact archived');
    if (c.company_id) await activity(ctx, 'company', c.company_id, 'system', `Contact archived: ${[c.first_name, c.last_name].filter(Boolean).join(' ')}`);
    await audit(ctx, 'contact.archived', { type: 'contact', id: c.id, label: [c.first_name, c.last_name].filter(Boolean).join(' ') });
    return { ok: true };
  });
}
