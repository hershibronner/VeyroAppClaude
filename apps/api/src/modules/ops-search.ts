import { humanDate } from '../core/templates';
// OPS: Global search (⌘K) — permission-filtered across clients, leads, contacts, candidates, workers, positions, invoices, documents, messages.
import type { FastifyInstance } from 'fastify';
import { q } from '../core/db';
import { staff, can, scopeOf } from '../core/context';
import { rateLimit } from '../core/ratelimit';
import { ENTITY_RESOURCE } from './_insights/common';

interface Result { type: string; id: string; title: string; subtitle: string | null; link: string }

export default async function (app: FastifyInstance) {
  app.get('/api/v1/search', async (req) => {
    const ctx = staff(req);
    await rateLimit(`search:${ctx.userId}`, 120, 60);
    const raw = String((req.query as any).q ?? '').trim().slice(0, 100);
    if (raw.length < 2) return { results: [] };
    const like = `%${raw.replace(/[%_\\]/g, m => '\\' + m)}%`;
    const per = Math.min(10, Number((req.query as any).limit) || 5);
    const org = ctx.orgId;
    const jobs: Promise<Result[]>[] = [];
    const run = (sql: string, params: unknown[], map: (r: any) => Result) => jobs.push(q<any>(sql, params).then(rows => rows.map(map)));

    if (can(ctx, 'clients', 'view'))
      run(`SELECT id, name, industry, country, stage FROM companies WHERE organization_id=$1 AND archived_at IS NULL AND stage IN ('client','inactive') AND (name ILIKE $2 OR domain ILIKE $2 OR email ILIKE $2) ORDER BY (name ILIKE $3) DESC, name LIMIT ${per}`, [org, like, `${raw}%`],
        r => ({ type: 'client', id: r.id, title: r.name, subtitle: [r.stage === 'inactive' ? 'Inactive client' : 'Client', r.industry, r.country].filter(Boolean).join(' · '), link: `/crm/clients/${r.id}` }));
    if (can(ctx, 'leads', 'view'))
      run(`SELECT id, name, lead_status, source FROM companies WHERE organization_id=$1 AND archived_at IS NULL AND stage IN ('lead','qualified') AND (name ILIKE $2 OR domain ILIKE $2 OR email ILIKE $2) ORDER BY (name ILIKE $3) DESC, name LIMIT ${per}`, [org, like, `${raw}%`],
        r => ({ type: 'lead', id: r.id, title: r.name, subtitle: ['Lead', r.lead_status?.replace(/_/g, ' '), r.source].filter(Boolean).join(' · '), link: `/crm/leads/${r.id}` }));
    if (can(ctx, 'contacts', 'view'))
      run(`SELECT ct.id, concat_ws(' ', ct.first_name, ct.last_name) name, ct.title, ct.email, co.name company FROM contacts ct LEFT JOIN companies co ON co.id=ct.company_id WHERE ct.organization_id=$1 AND ct.archived_at IS NULL AND (concat_ws(' ', ct.first_name, ct.last_name) ILIKE $2 OR ct.email ILIKE $2 OR ct.phone ILIKE $2) ORDER BY ct.first_name LIMIT ${per}`, [org, like],
        r => ({ type: 'contact', id: r.id, title: r.name, subtitle: [r.title, r.company, r.email].filter(Boolean).join(' · '), link: `/crm/contacts/${r.id}` }));
    if (can(ctx, 'candidates', 'view'))
      run(`SELECT c.id, concat_ws(' ', c.first_name, c.last_name) name, c.headline, c.country, c.status FROM candidates c WHERE c.organization_id=$1 AND c.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.candidate_id=c.id AND w.status IN ('active','on_leave'))
        AND (concat_ws(' ', c.first_name, c.last_name) ILIKE $2 OR c.email ILIKE $2 OR c.phone ILIKE $2 OR c.headline ILIKE $2 OR array_to_string(c.skills, ' ') ILIKE $2) ORDER BY (concat_ws(' ', c.first_name, c.last_name) ILIKE $3) DESC, c.created_at DESC LIMIT ${per}`, [org, like, `${raw}%`],
        r => ({ type: 'candidate', id: r.id, title: r.name, subtitle: [r.headline, r.country, r.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '), link: `/recruiting/candidates/${r.id}` }));
    if (can(ctx, 'workers', 'view'))
      run(`SELECT w.id, concat_ws(' ', c.first_name, c.last_name) name, w.status, (SELECT co.name || ' · ' || p.title FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=w.id ORDER BY (p.status='active') DESC, p.start_date DESC LIMIT 1) placement
        FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.organization_id=$1 AND (concat_ws(' ', c.first_name, c.last_name) ILIKE $2 OR c.email ILIKE $2 OR w.employee_code ILIKE $2) ORDER BY (w.status='active') DESC, c.first_name LIMIT ${per}`, [org, like],
        r => ({ type: 'worker', id: r.id, title: r.name, subtitle: [r.status?.replace(/_/g, ' '), r.placement].filter(Boolean).join(' · '), link: `/workforce/workers/${r.id}` }));
    if (can(ctx, 'positions', 'view')) {
      const assigned = scopeOf(ctx, 'positions', 'view') !== 'all';
      run(`SELECT p.id, p.title, p.status, co.name company FROM positions p LEFT JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.archived_at IS NULL AND (p.title ILIKE $2 OR co.name ILIKE $2)
        ${assigned ? 'AND EXISTS (SELECT 1 FROM position_recruiter_assignments a WHERE a.position_id=p.id AND a.user_id=$3 AND a.unassigned_at IS NULL)' : ''} ORDER BY (p.status='open') DESC, p.created_at DESC LIMIT ${per}`, assigned ? [org, like, ctx.userId] : [org, like],
        r => ({ type: 'position', id: r.id, title: r.title, subtitle: [r.company, r.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '), link: `/recruiting/positions/${r.id}` }));
    }
    if (can(ctx, 'invoices', 'view'))
      run(`SELECT i.id, i.number, i.status, i.total_cents, i.currency, co.name company FROM invoices i JOIN companies co ON co.id=i.company_id WHERE i.organization_id=$1 AND (i.number ILIKE $2 OR co.name ILIKE $2) ORDER BY i.issue_date DESC LIMIT ${per}`, [org, like],
        r => ({ type: 'invoice', id: r.id, title: r.number, subtitle: [r.company, (Number(r.total_cents) / 100).toLocaleString('en-US', { style: 'currency', currency: r.currency }), r.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '), link: `/finance/invoices/${r.id}` }));
    if (can(ctx, 'documents', 'view')) {
      const hidden = Object.entries(ENTITY_RESOURCE).filter(([t, r]) => !(t === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, r as any, 'view'))).map(([t]) => t);
      run(`SELECT d.id, d.name, d.category, d.expires_at FROM documents d WHERE d.organization_id=$1 AND d.archived_at IS NULL AND d.name ILIKE $2 AND (d.entity_type IS NULL OR NOT (d.entity_type = ANY($3))) ORDER BY d.created_at DESC LIMIT ${per}`, [org, like, hidden],
        r => ({ type: 'document', id: r.id, title: r.name, subtitle: [r.category?.replace(/_/g, ' '), r.expires_at ? `expires ${humanDate(r.expires_at)}` : null].filter(Boolean).join(' · '), link: `/documents/${r.id}` }));
    }
    if (can(ctx, 'messages', 'view'))
      run(`SELECT DISTINCT ON (t.id) t.id, t.subject, m.body, u.name author, m.created_at FROM message_threads t JOIN thread_participants tp ON tp.thread_id=t.id AND tp.user_id=$3 LEFT JOIN messages m ON m.thread_id=t.id AND m.body ILIKE $2 LEFT JOIN users u ON u.id=m.author_id
        WHERE t.organization_id=$1 AND (t.subject ILIKE $2 OR m.id IS NOT NULL) ORDER BY t.id, m.created_at DESC LIMIT ${per}`, [org, like, ctx.userId],
        r => ({ type: 'message', id: r.id, title: r.subject, subtitle: r.body ? `${r.author ?? 'Someone'}: ${String(r.body).slice(0, 90)}` : 'Conversation', link: `/comms/inbox?thread=${r.id}` }));

    const groups = await Promise.all(jobs);
    return { results: groups.flat() };
  });
}
