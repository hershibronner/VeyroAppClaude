// PUBLIC — "Contact us" from the landing page (/home). No login. Rate-limited; stored in contact_requests,
// platform admins get an in-app notification and an email copy (to CONTACT_EMAIL, else every active platform admin).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../core/db';
import { rateLimit } from '../core/ratelimit';
import { sendMessage } from '../adapters/messaging';
import { notifyPlatform } from './_admin/common';

const Body = z.object({
  name: z.string().trim().min(1, 'Tell us your name').max(120),
  email: z.string().trim().email('Enter a valid email').max(200),
  company: z.string().trim().max(160).optional(),
  team_size: z.string().trim().max(40).optional(),
  interest: z.string().trim().max(80).optional(),
  message: z.string().trim().max(4000).optional(),
});

export default async function routes(app: FastifyInstance) {
  app.post('/api/v1/public/contact', { config: { public: true } }, async (req) => {
    const b = Body.parse(req.body);
    await rateLimit(`contact:${req.ip}`, 5, 3600);
    const r = await one<any>(`INSERT INTO contact_requests (name, email, company, team_size, interest, message, ip) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.name, b.email.toLowerCase(), b.company || null, b.team_size || null, b.interest || null, b.message || null, req.ip]);

    const title = `New contact request: ${b.name}${b.company ? ` (${b.company})` : ''}`;
    const lines = [`Name: ${b.name}`, `Email: ${b.email}`, b.company && `Company: ${b.company}`, b.team_size && `Team size: ${b.team_size}`, b.interest && `Interested in: ${b.interest}`, b.message && `\n${b.message}`].filter(Boolean).join('\n');
    await notifyPlatform(title, lines.slice(0, 1000), null, 'contact.request').catch(() => {});

    const to = process.env.CONTACT_EMAIL
      ? [process.env.CONTACT_EMAIL]
      : (await q<any>(`SELECT u.email FROM platform_admins p JOIN users u ON u.id=p.user_id WHERE p.status='active' AND (p.expires_at IS NULL OR p.expires_at > now())`)).map(x => x.email);
    for (const addr of to) await sendMessage({ orgId: null, channel: 'email', to: addr, subject: title, text: `${lines}\n\nReply directly to ${b.email}.`, fromName: 'VeyroApp website' }).catch(() => {});

    return { ok: true, id: r.id };
  });
}
