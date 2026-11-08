// CRM — Client sign-up links (Leads → Generate link). A prospect answers one question per screen on a public,
// tenant-branded page; the submission becomes a Lead (company + contact) owned by the link's creator.
// Existing companies/contacts are matched (domain, name, email) so repeat sign-ups never create duplicates.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, insertRow, tx } from '../core/db';
import { staff, need, getOr404 } from '../core/context';
import { notFound } from '../core/errors';
import { activity, audit } from '../core/audit';
import { notify, usersWithRoles, subscribers } from '../core/notify';
import { emit } from '../core/events';
import { rateLimit } from '../core/ratelimit';
import { signedUrl } from '../core/storage';
import { WEB_URL } from '../core/settings';
import { sendMessage } from '../adapters/messaging';
import { domainOf, normalizeEmail, normalizeCompanyName, formatMoney } from '@veyro/shared';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'proton.me', 'protonmail.com', 'me.com', 'msn.com']);

/** Industries and the roles/work offered for each — shared with the public flow so choices stay consistent. */
export const INTAKE_INDUSTRIES = [
  { key: 'dental', label: 'Dental & medical' }, { key: 'real_estate', label: 'Real estate' }, { key: 'insurance', label: 'Insurance' },
  { key: 'ecommerce', label: 'E-commerce' }, { key: 'law', label: 'Legal' }, { key: 'marketing', label: 'Marketing & agencies' },
  { key: 'accounting', label: 'Accounting & finance' }, { key: 'other', label: 'Something else' },
];
const ROLE_BY_INDUSTRY: Record<string, string[]> = {
  dental: ['Front Desk / Reception VA', 'Insurance Verification', 'Medical Billing'],
  real_estate: ['Transaction Coordinator', 'Lead Generation / ISA', 'Listing Coordinator'],
  insurance: ['Account Manager VA', 'Quoting Specialist', 'Claims Support'],
  ecommerce: ['Customer Support', 'Store / Listings Assistant', 'Order Processing'],
  law: ['Legal Assistant', 'Paralegal', 'Client Intake'],
  marketing: ['Social Media Manager', 'Content Writer', 'Email Marketing'],
  accounting: ['Bookkeeper', 'Accounts Payable / Receivable', 'Payroll Assistant'],
};
const GENERAL_ROLES = ['Executive Assistant', 'Customer Support', 'Appointment Setter', 'Data Entry / Admin', 'Bookkeeper', 'Social Media Manager'];
export const INTAKE_TASKS = ['Scheduling & calendar', 'Phone calls', 'Inbox & email', 'Customer support', 'Data entry', 'Bookkeeping', 'Lead generation', 'Social media', 'Research', 'CRM updates', 'Order processing', 'Content writing'];
const TIMELINES = ['asap', 'two_weeks', 'month', 'exploring'] as const;
const TIMELINE_LABEL: Record<string, string> = { asap: 'As soon as possible', two_weeks: 'Within 2 weeks', month: 'Within a month', exploring: 'Just exploring' };

const visitor = (req: FastifyRequest) => crypto.createHash('sha256').update(`${req.ip}|${req.headers['user-agent'] ?? ''}`).digest('hex').slice(0, 16);
async function orgBySlug(slug: string) {
  const o = await one<any>(`SELECT o.id, o.name, o.slug, o.status, b.logo_text, b.logo_file, b.primary_color, b.accent_color, b.support_email, b.hide_powered_by FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.slug=$1`, [slug]);
  if (!o || ['deleted', 'suspended'].includes(o.status)) throw notFound('This sign-up page does not exist');
  return o;
}
const activeLink = (orgId: string, token?: string | null) => (token ? one<any>(`SELECT l.*, u.name user_name FROM lead_intake_links l JOIN users u ON u.id=l.user_id WHERE l.organization_id=$1 AND l.token=$2 AND l.active`, [orgId, token]) : Promise.resolve(null));
const linkUrl = (slug: string, token: string) => `${WEB_URL}/hire/${slug}/l/${token}`;

const submitBody = z.object({
  token: z.string().max(80).nullable().optional(),
  first_name: z.string().trim().min(1, 'Tell us your first name').max(80), last_name: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().email('Enter a valid work email').max(200), phone: z.string().trim().max(40).optional().default(''),
  title: z.string().trim().max(120).optional().default(''),
  company: z.string().trim().min(2, 'Tell us your company name').max(160), website: z.string().trim().max(200).optional().default(''),
  industry: z.string().max(40), company_size: z.string().max(20).optional().default(''),
  vas: z.number().int().min(1, 'At least 1').max(500),
  roles: z.array(z.string().max(120)).min(1, 'Pick at least one role').max(20), roles_other: z.string().max(200).optional().default(''),
  tasks: z.array(z.string().max(120)).max(30).default([]), tasks_other: z.string().max(500).optional().default(''),
  employment: z.enum(['full_time', 'part_time', 'mixed']).default('full_time'),
  hours: z.string().max(80).optional().default(''),
  rate_min_cents: z.number().int().min(100).max(20000), rate_max_cents: z.number().int().min(100).max(20000),
  timeline: z.enum(TIMELINES).default('exploring'),
  notes: z.string().max(2000).optional().default(''),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree so we can contact you' }) }),
  website_url_confirm: z.string().max(0).optional(), // honeypot
}).refine(b => b.rate_max_cents >= b.rate_min_cents, { message: 'Max rate must be at least your min rate', path: ['rate_max_cents'] });

function leadScore(b: z.infer<typeof submitBody>): number {
  const mid = (b.rate_min_cents + b.rate_max_cents) / 2;
  let s = 30 + Math.min(25, b.vas * 5);
  s += ({ asap: 20, two_weeks: 15, month: 8, exploring: 0 } as Record<string, number>)[b.timeline];
  s += mid >= 1000 ? 10 : mid >= 600 ? 5 : 0;
  if (b.phone.replace(/\D/g, '').length >= 7) s += 5;
  if (b.website) s += 5;
  return Math.min(100, s);
}

export default async function (app: FastifyInstance) {
  // ── Staff: links ──
  app.get('/api/v1/leads/intake-links', async (req) => {
    const ctx = staff(req);
    need(ctx, 'leads', 'view');
    const rows = await q<any>(`SELECT l.*, u.name owner_name, (SELECT count(*)::int FROM lead_intakes i WHERE i.link_id=l.id) submissions, (SELECT max(created_at) FROM lead_intakes i WHERE i.link_id=l.id) last_submission_at
      FROM lead_intake_links l JOIN users u ON u.id=l.user_id WHERE l.organization_id=$1 ORDER BY (l.user_id=$2) DESC, l.created_at DESC LIMIT 100`, [ctx.orgId, ctx.userId]);
    const general = await one<any>(`SELECT count(*)::int n FROM lead_intakes WHERE organization_id=$1 AND link_id IS NULL`, [ctx.orgId]);
    return { general: { url: `${WEB_URL}/hire/${ctx.org.slug}`, submissions: general.n }, rows: rows.map(l => ({ ...l, url: linkUrl(ctx.org.slug, l.token), mine: l.user_id === ctx.userId })) };
  });
  app.post('/api/v1/leads/intake-links', async (req) => {
    const ctx = staff(req);
    need(ctx, 'leads', 'create');
    const b = z.object({ label: z.string().trim().max(120).optional().default(''), source: z.string().trim().max(40).default('Website'), campaign: z.string().trim().max(120).optional().default('') }).parse(req.body);
    const l = await insertRow<any>('lead_intake_links', { organization_id: ctx.orgId, user_id: ctx.userId, token: crypto.randomBytes(8).toString('base64url'), label: b.label || `${ctx.user.name.split(' ')[0]}'s sign-up link`, source: b.source || 'Website', campaign: b.campaign || null });
    await audit(ctx, 'lead_intake_link.created', { type: 'lead_intake_link', id: l.id, label: l.label });
    return { ...l, owner_name: ctx.user.name, submissions: 0, url: linkUrl(ctx.org.slug, l.token), mine: true };
  });
  app.post('/api/v1/leads/intake-links/:id/active', async (req) => {
    const ctx = staff(req);
    need(ctx, 'leads', 'edit');
    const l = await getOr404<any>('lead_intake_links', ctx, (req.params as any).id);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await q(`UPDATE lead_intake_links SET active=$2 WHERE id=$1`, [l.id, active]);
    await audit(ctx, active ? 'lead_intake_link.activated' : 'lead_intake_link.deactivated', { type: 'lead_intake_link', id: l.id, label: l.label });
    return { ok: true };
  });

  // ── Public: page config ──
  app.get('/api/v1/public/intake/:slug', { config: { public: true } }, async (req) => {
    const { slug } = req.params as any;
    const { token } = req.query as { token?: string };
    const o = await orgBySlug(slug);
    const link = await activeLink(o.id, token);
    if (link) {
      const ok = await rateLimit(`intake-click:${link.id}:${visitor(req)}`, 1, 1800).then(() => true).catch(() => false);
      if (ok) await q(`UPDATE lead_intake_links SET clicks=clicks+1 WHERE id=$1`, [link.id]);
    }
    return {
      org: { name: o.name, slug: o.slug, logo_text: o.logo_text ?? o.name, logo_url: signedUrl(o.logo_file, 86400), primary_color: o.primary_color ?? '#4F6BF6', accent_color: o.accent_color ?? '#7044FF', support_email: o.support_email, hide_powered_by: !!o.hide_powered_by },
      link: link ? { owner_first_name: String(link.user_name).split(' ')[0] } : null,
      link_inactive: !!token && !link,
      industries: INTAKE_INDUSTRIES, roles_by_industry: ROLE_BY_INDUSTRY, general_roles: GENERAL_ROLES, tasks: INTAKE_TASKS,
    };
  });

  // ── Public: submit ──
  app.post('/api/v1/public/intake/:slug/submit', { config: { public: true } }, async (req) => {
    const { slug } = req.params as any;
    const o = await orgBySlug(slug);
    await rateLimit(`intake-submit:${o.id}:${req.ip}`, 10, 3600);
    const b = submitBody.parse(req.body);
    const link = await activeLink(o.id, b.token);
    const email = normalizeEmail(b.email)!;
    const emailDomain = email.split('@')[1];
    const domain = domainOf(b.website) ?? (FREE_MAIL.has(emailDomain) ? null : emailDomain);
    const owner = link?.user_id ?? (await usersWithRoles(o.id, ['sales']))[0] ?? (await usersWithRoles(o.id, ['owner']))[0] ?? null;
    const score = leadScore(b);
    const midCents = Math.round((b.rate_min_cents + b.rate_max_cents) / 2);
    const monthly = b.vas * midCents * 160;
    const roles = [...b.roles, ...(b.roles_other ? [b.roles_other] : [])];
    const industryLabel = INTAKE_INDUSTRIES.find(i => i.key === b.industry)?.label ?? b.industry;
    const rate = `${formatMoney(b.rate_min_cents)}–${formatMoney(b.rate_max_cents)}/hr`;
    const summary = [
      `${b.vas} VA${b.vas > 1 ? 's' : ''} · ${b.employment.replace('_', '-')}${b.hours ? ` · ${b.hours}` : ''}`,
      `Roles: ${roles.join(', ')}`,
      b.tasks.length || b.tasks_other ? `Work: ${[...b.tasks, b.tasks_other].filter(Boolean).join(', ')}` : null,
      `Budget: ${rate} · Start: ${TIMELINE_LABEL[b.timeline]}`,
      b.notes ? `Notes: ${b.notes}` : null,
    ].filter(Boolean).join('\n');

    const existingContact = await one<any>(`SELECT c.* FROM contacts c WHERE c.organization_id=$1 AND lower(c.email)=$2 AND c.archived_at IS NULL LIMIT 1`, [o.id, email]);
    let company = existingContact?.company_id ? await one<any>(`SELECT * FROM companies WHERE id=$1 AND archived_at IS NULL`, [existingContact.company_id]) : null;
    if (!company && domain) company = await one<any>(`SELECT * FROM companies WHERE organization_id=$1 AND domain=$2 AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [o.id, domain]);
    if (!company) {
      const norm = normalizeCompanyName(b.company);
      const cands = await q<any>(`SELECT * FROM companies WHERE organization_id=$1 AND archived_at IS NULL AND lower(name) LIKE $2 LIMIT 20`, [o.id, `%${norm.split(' ')[0] ?? ''}%`]);
      company = cands.find(c => normalizeCompanyName(c.name) === norm) ?? null;
    }
    const duplicate = !!company;

    const res = await tx(async (c) => {
      let co = company;
      if (!co) {
        co = await insertRow<any>('companies', {
          organization_id: o.id, name: b.company, website: b.website ? (/^https?:\/\//.test(b.website) ? b.website : `https://${b.website}`) : null, domain, industry: b.industry === 'other' ? null : b.industry,
          size: b.company_size || null, stage: 'lead', lead_status: 'new', source: link?.source ?? 'Website', campaign: link?.campaign ?? 'Client sign-up page', owner_id: owner,
          lead_score: score, est_workers: b.vas, est_monthly_value_cents: monthly, currency: 'USD', notes: summary, next_follow_up: new Date().toISOString().slice(0, 10), phone: b.phone || null, email,
        }, c);
      } else {
        await c.query(`UPDATE companies SET lead_score=GREATEST(lead_score,$2), est_workers=COALESCE(est_workers,$3), est_monthly_value_cents=COALESCE(est_monthly_value_cents,$4), next_follow_up=COALESCE(next_follow_up, current_date), updated_at=now() WHERE id=$1`, [co.id, score, b.vas, monthly]);
      }
      let ct = existingContact;
      if (!ct) {
        const hasPrimary = (await c.query(`SELECT 1 FROM contacts WHERE company_id=$1 AND is_primary`, [co.id])).rowCount;
        ct = await insertRow<any>('contacts', { organization_id: o.id, company_id: co.id, first_name: b.first_name, last_name: b.last_name || null, title: b.title || null, email, phone: b.phone || null, is_primary: !hasPrimary }, c);
        await insertRow('contact_methods', { organization_id: o.id, contact_id: ct.id, kind: 'email', value: email, label: 'work', is_primary: true }, c);
        if (b.phone) await insertRow('contact_methods', { organization_id: o.id, contact_id: ct.id, kind: 'phone', value: b.phone, label: 'mobile', is_primary: true }, c);
        await c.query(`INSERT INTO company_contacts (organization_id, company_id, contact_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [o.id, co.id, ct.id, hasPrimary ? 'other' : 'primary']);
      }
      const intake = await insertRow<any>('lead_intakes', { organization_id: o.id, link_id: link?.id ?? null, company_id: co.id, contact_id: ct.id, answers: JSON.stringify({ ...b, consent: undefined, website_url_confirm: undefined }), duplicate_of_existing: duplicate, ip_hash: visitor(req) }, c);
      await c.query(`INSERT INTO lead_score_events (organization_id, company_id, delta, reason) VALUES ($1,$2,$3,$4)`, [o.id, co.id, duplicate ? 0 : score, 'Client sign-up form']);
      const task = await insertRow<any>('tasks', { organization_id: o.id, title: `Call ${b.first_name} at ${co.name} — new sign-up (${b.vas} VA${b.vas > 1 ? 's' : ''})`, description: summary, priority: b.timeline === 'asap' ? 'high' : 'medium', due_date: new Date().toISOString().slice(0, 10), related_type: 'company', related_id: co.id, created_by: owner }, c);
      if (owner) await c.query(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [task.id, owner]);
      return { co, ct, intake };
    });

    const sys = { orgId: o.id, userId: null };
    await activity(sys, 'company', res.co.id, 'system', duplicate ? `${b.first_name} submitted the sign-up form again` : `New sign-up: ${b.first_name} ${b.last_name}`.trim(), summary, { intake_id: res.intake.id, link_owner: link?.user_name ?? null, source: link?.source ?? 'Website' });
    const recipients = [res.co.owner_id ?? owner, link?.user_id, ...(await subscribers(o.id, 'lead.new'))];
    await notify(o.id, recipients, { event: 'lead.new', title: `New client sign-up: ${res.co.name}`, body: `${b.vas} VA${b.vas > 1 ? 's' : ''} · ${rate} · ${TIMELINE_LABEL[b.timeline]}`, link: `/crm/leads/${res.co.id}` });
    await sendMessage({ orgId: o.id, channel: 'email', to: email, subject: `Thanks, ${b.first_name} — we got your request`, text: `Hi ${b.first_name},\n\nThanks for telling us about ${b.company}. A ${o.name} specialist will reach out within one business day to talk through your ${b.vas} ${industryLabel.toLowerCase()} role${b.vas > 1 ? 's' : ''}.\n\nWhat you shared:\n${summary}\n\n— ${o.name}`, related: { type: 'company', id: res.co.id } });
    if (!duplicate) await emit(o.id, 'lead.created', { company_id: res.co.id, company_name: res.co.name, owner_id: res.co.owner_id, source: res.co.source, est_workers: b.vas });
    return { ok: true, first_name: b.first_name, company: res.co.name, owner_first_name: link ? String(link.user_name).split(' ')[0] : null };
  });
}
