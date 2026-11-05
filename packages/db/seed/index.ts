// VeyroApp demo seed. All people, companies, emails and phone numbers are invented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { createPool, STORAGE_DIR, ensureOrgDefaults } from '../src/index';
import {
  addDays, weekStart, todayUtc, isoDow, zonedToUtc, linesByRate, computePayroll, invoiceTotals, computeCommission,
  mockDesktopSvg, MOCK_APPS, Rate, rateForDate,
} from '@veyro/shared';
import { CLIENTS, LEADS, POSITION_TITLES, FAMILIES, COUNTRIES, UNIVERSITIES, EMPLOYERS, LEAD_SOURCES } from './data';

// ── deterministic helpers ──────────────────────────────────────────
let s = 20251027;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;
const sample = <T>(arr: readonly T[], n: number): T[] => { const a = [...arr]; const out: T[] = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
const uid = () => crypto.randomUUID();
const token = (n = 12) => crypto.randomBytes(n).toString('base64url');
const COLORS = ['#345CFF', '#7044FF', '#0EA5E9', '#14B8A6', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6', '#10B981', '#6366F1'];
const TODAY = todayUtc();
const WINDOW_START = addDays(TODAY, -182);
const LAST_WEEK = addDays(weekStart(TODAY), -7);
const THIS_WEEK = weekStart(TODAY);
const ts = (date: string, h = 12, m = 0) => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).toISOString();
const daysAgoTs = (d: number, h = int(13, 22)) => ts(addDays(TODAY, -d), h, int(0, 59));
const monthStart = (d: string) => d.slice(0, 8) + '01';
const monthEnd = (d: string) => addDays(addMonths(monthStart(d), 1), -1);
function addMonths(d: string, n: number) { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); }
const roundTo = (cents: number, step = 50) => Math.round(cents / step) * step;

let c: PoolClient;
async function insert(table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const chunk = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part.map(r => '(' + cols.map(col => { if (r[col] === undefined) return 'DEFAULT'; params.push(r[col]); return '$' + params.length; }).join(',') + ')');
    await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

// ── shared identities ──────────────────────────────────────────────
const PW = bcrypt.hashSync('demo1234', 8);
const users = new Map<string, { id: string; name: string; email: string }>();
function user(email: string, name: string, extra: Record<string, unknown> = {}) {
  if (users.has(email)) return users.get(email)!;
  const u = { id: uid(), name, email };
  users.set(email, u);
  userRows.push({ id: u.id, email, name, password_hash: PW, avatar_color: pick(COLORS), phone: `+1 555 01${int(10, 99)}`, ...extra });
  return u;
}
const userRows: Record<string, unknown>[] = [];

interface AgencyCfg {
  name: string; slug: string; primary: string; accent: string; logoText: string;
  plan: string; comped: boolean; status: string;
  staff: { email: string; name: string; role: string; scope?: string; team?: string }[];
  clients: typeof CLIENTS; leads: typeof LEADS;
  nCandidates: number; nPlacements: { active: number; onboarding: number; on_leave: number; ended: number };
  nContacts: number; nOpps: number; nPositions: number; nInterviews: number; nOffers: number; nTasks: number;
  special?: boolean; // MAGA demo identities (Jose, Maria, Dana)
  countries: string[];
}

async function seedAgency(cfg: AgencyCfg) {
  const orgId = uid();
  await insert('organizations', [{ id: orgId, name: cfg.name, slug: cfg.slug, created_at: daysAgoTs(420) }]);
  const ownerEmail = cfg.staff[0].email;
  const owner = user(ownerEmail, cfg.staff[0].name);
  await insertUsersSoFar();
  const roleIds = await ensureOrgDefaults(c, orgId, { ownerId: owner.id });
  await c.query(`UPDATE organization_branding SET logo_text=$2, primary_color=$3, accent_color=$4, email_sender_name=$5, support_email=$6 WHERE organization_id=$1`, [orgId, cfg.logoText, cfg.primary, cfg.accent, cfg.name, `support@${cfg.slug}.example`]);
  await insert('subscriptions', [{ organization_id: orgId, plan_key: cfg.plan, status: cfg.status, comped: cfg.comped, trial_ends_at: cfg.status === 'trialing' ? addDays(TODAY, 9) : null, card_last4: cfg.comped ? null : '4242' }]);
  await insert('feature_flags', ['ai_matching', 'screenshots', 'client_portal', 'worker_portal', 'automation', 'report_builder', 'white_label', 'public_api'].map(k => ({ organization_id: orgId, key: k, enabled: k === 'white_label' ? false : true })));

  // staff
  const staff: Record<string, { id: string; name: string; role: string }> = {};
  const memberships: Record<string, unknown>[] = [];
  for (const st of cfg.staff) {
    const u = user(st.email, st.name, { personal_link_token: null });
    staff[st.email] = { id: u.id, name: st.name, role: st.role };
    memberships.push({ organization_id: orgId, user_id: u.id, role_id: roleIds[st.role], recruiting_scope: st.scope ?? 'all', team: st.team ?? null, created_at: daysAgoTs(int(60, 400)) });
  }
  await insertUsersSoFar();
  await insert('organization_memberships', memberships);
  const byRole = (r: string) => Object.values(staff).filter(s => s.role === r);
  const recruiters = byRole('recruiter');
  const sales = byRole('sales')[0] ?? Object.values(staff)[0];
  const ams = byRole('account_manager').length ? byRole('account_manager') : [Object.values(staff)[0]];
  const ownerId = owner.id;
  const anyStaff = () => pick(Object.values(staff)).id;

  const policies = (await c.query(`SELECT id, is_default FROM monitoring_policies WHERE organization_id=$1`, [orgId])).rows;
  const defaultPolicy = policies.find(p => p.is_default)!.id;
  const onboardingItems = (await c.query(`SELECT i.title, i.required, i.owner FROM onboarding_template_items i JOIN onboarding_templates t ON t.id=i.template_id WHERE t.organization_id=$1 ORDER BY i.sort`, [orgId])).rows;

  // ── companies (clients + leads) ──
  const companies: Record<string, unknown>[] = [];
  const clientIds: { id: string; name: string; industry: string; tz: string; tax: number }[] = [];
  for (const [i, cl] of cfg.clients.entries()) {
    const id = uid();
    const wasLead = i % 2 === 0;
    const created = int(200, 420);
    clientIds.push({ id, name: cl.name, industry: cl.industry, tz: cl.tz, tax: cl.tax ?? 0 });
    companies.push({ id, organization_id: orgId, name: cl.name, website: `https://www.${cl.domain}`, domain: cl.domain, industry: cl.industry, size: cl.size, country: 'United States', phone: `+1 ${cl.area} 555 0${int(100, 199)}`, email: `office@${cl.domain}`, address: `${int(100, 9999)} ${pick(['Main St', 'Oak Ave', 'Market St', 'Pine Rd', 'Commerce Blvd'])}, ${cl.city}`, stage: i === cfg.clients.length - 1 && cfg.clients.length > 5 ? 'inactive' : 'client', lead_status: wasLead ? 'converted' : null, source: wasLead ? pick(LEAD_SOURCES) : 'Referral', owner_id: sales.id, account_manager_id: pick(ams).id, lead_score: wasLead ? int(70, 95) : 0, est_workers: int(1, 6), est_monthly_value_cents: int(3, 18) * 100000, converted_at: wasLead ? daysAgoTs(created - 20) : null, timesheet_approval: i % 4 === 3 ? 'agency' : 'client', payment_terms_days: pick([15, 15, 30]), tax_bp: cl.tax ?? 0, created_by: sales.id, created_at: daysAgoTs(created) });
  }
  const leadIds: string[] = [];
  const leadStatuses = ['new', 'new', 'contacted', 'contacted', 'qualified', 'unqualified'];
  for (const [i, ld] of cfg.leads.entries()) {
    const id = uid(); leadIds.push(id);
    const st = leadStatuses[i % leadStatuses.length];
    companies.push({ id, organization_id: orgId, name: ld.name, website: `https://${ld.domain}`, domain: ld.domain, industry: ld.industry, size: pick(['1-10', '11-50', '51-200']), country: pick(['United States', 'United States', 'United States', 'Canada', 'Australia', 'United Kingdom']), stage: st === 'qualified' ? 'qualified' : 'lead', lead_status: st, source: LEAD_SOURCES[i % LEAD_SOURCES.length], campaign: pick(['Q3 Dental Outreach', 'LinkedIn — Ops Leaders', 'Webinar: Hiring Remote', null, null]), owner_id: sales.id, lead_score: st === 'qualified' ? int(65, 92) : st === 'unqualified' ? int(5, 30) : int(25, 70), est_workers: int(1, 8), est_monthly_value_cents: int(2, 25) * 100000, notes: pick(['Interested in 2 VAs for front desk.', 'Asked for pricing deck.', 'Growing fast; hiring freeze lifts next quarter.', null]), next_follow_up: st === 'unqualified' ? null : addDays(TODAY, int(-4, 12)), disqualify_reason: st === 'unqualified' ? pick(['Budget too small', 'Needs onsite staff only', 'Chose another vendor']) : null, created_by: sales.id, created_at: daysAgoTs(int(2, 120)) });
  }
  await insert('companies', companies);

  // ── contacts ──
  const contacts: Record<string, unknown>[] = [];
  const contactMethods: Record<string, unknown>[] = [];
  const primaryContact: Record<string, { id: string; first: string; email: string; name: string }> = {};
  const firstNames = ['Dana', 'Michael', 'Jennifer', 'Robert', 'Laura', 'Kevin', 'Amanda', 'Brian', 'Rachel', 'Steven', 'Megan', 'Eric', 'Nicole', 'Jason', 'Heather', 'Greg', 'Tara', 'Paul', 'Lisa', 'Chris'];
  const lastNames = ['Fox', 'Hart', 'Brennan', 'Collins', 'Dawson', 'Ellis', 'Fischer', 'Grant', 'Hughes', 'Iverson', 'Jensen', 'Keller', 'Lambert', 'Monroe', 'Nolan', 'Owens', 'Price', 'Quinn', 'Reid', 'Sutton'];
  const allCompanyRefs = [...clientIds.map(x => ({ id: x.id, domain: cfg.clients.find(cc => cc.name === x.name)!.domain, client: true })), ...cfg.leads.map((l, i) => ({ id: leadIds[i], domain: l.domain, client: false }))];
  let ci = 0;
  for (const ref of allCompanyRefs) {
    if (contacts.length >= cfg.nContacts) break;
    const n = ref.client ? 2 : 1;
    for (let k = 0; k < n && contacts.length < cfg.nContacts; k++) {
      const special = cfg.special && ci === 0;
      const first = special ? 'Dana' : firstNames[(ci * 7 + k) % firstNames.length];
      const last = special ? 'Fox' : lastNames[(ci * 3 + k * 5) % lastNames.length];
      const id = uid();
      const email = special ? 'client@veyro.demo' : `${first.toLowerCase()}.${last.toLowerCase()}@${ref.domain}`;
      contacts.push({ id, organization_id: orgId, company_id: ref.id, first_name: first, last_name: last, title: k === 0 ? pick(['Owner', 'Practice Manager', 'Operations Director', 'COO', 'Managing Partner']) : pick(['Office Manager', 'Finance Lead', 'HR Coordinator']), email, phone: `+1 555 01${String(ci).padStart(2, '0')}`, is_primary: k === 0, created_by: sales.id, created_at: daysAgoTs(int(30, 300)) });
      contactMethods.push({ organization_id: orgId, contact_id: id, kind: 'email', value: email, label: 'work', is_primary: true });
      contactMethods.push({ organization_id: orgId, contact_id: id, kind: 'phone', value: `+1 555 01${String(ci).padStart(2, '0')}`, label: 'office', is_primary: true });
      if (chance(0.3)) contactMethods.push({ organization_id: orgId, contact_id: id, kind: 'phone', value: `+1 555 02${String(ci).padStart(2, '0')}`, label: 'mobile', is_primary: false });
      if (k === 0) primaryContact[ref.id] = { id, first, email, name: `${first} ${last}` };
    }
    ci++;
  }
  await insert('contacts', contacts);
  await insert('contact_methods', contactMethods);
  await insert('company_contacts', contacts.map(x => ({ organization_id: orgId, company_id: x.company_id, contact_id: x.id, role: x.is_primary ? 'primary' : 'other' })));

  // ── opportunities ──
  const opps: Record<string, unknown>[] = [];
  const oppStages = ['new', 'discovery', 'proposal', 'negotiation', 'won', 'lost'];
  for (let i = 0; i < cfg.nOpps; i++) {
    const comp = i < clientIds.length ? clientIds[i] : { id: leadIds[i % leadIds.length], name: cfg.leads[i % cfg.leads.length].name };
    const stage = i < clientIds.length * 0.6 ? 'won' : oppStages[i % 6];
    opps.push({ id: uid(), organization_id: orgId, company_id: comp.id, contact_id: primaryContact[comp.id]?.id ?? null, name: `${comp.name} — ${pick(['Front desk team', 'Admin support', 'Billing team', 'Expansion', 'Pilot VA'])}`, stage, owner_id: sales.id, est_workers: int(1, 5), value_cents: int(3, 30) * 100000, expected_close: addDays(TODAY, stage === 'won' || stage === 'lost' ? -int(10, 150) : int(5, 60)), probability: ({ new: 10, discovery: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 } as Record<string, number>)[stage], source: pick(LEAD_SOURCES), closed_at: stage === 'won' || stage === 'lost' ? daysAgoTs(int(10, 150)) : null, lost_reason: stage === 'lost' ? 'Went with in-house hire' : null, created_by: sales.id, created_at: daysAgoTs(int(20, 200)) });
  }
  await insert('opportunities', opps);

  // ── positions ──
  const positions: { id: string; companyId: string; title: string; family: string; status: string; tz: string; recruiters: string[] }[] = [];
  const posRows: Record<string, unknown>[] = [];
  const assignRows: Record<string, unknown>[] = [];
  const reqRows: Record<string, unknown>[] = [];
  for (let i = 0; i < cfg.nPositions; i++) {
    const cl = clientIds[i % Math.max(1, clientIds.length - 1)];
    const titles = POSITION_TITLES[cl.industry];
    const title = titles[Math.floor(i / clientIds.length) % titles.length];
    const fam = FAMILIES[cl.industry];
    const status = i < 4 ? 'filled' : pick(['open', 'open', 'open', 'open', 'on_hold', 'draft', 'closed']);
    const id = uid();
    const pay = int(5, 9) * 100;
    const recs = recruiters.length ? (i % 3 === 0 ? recruiters.slice(0, 1) : sample(recruiters, Math.min(2, recruiters.length))).map(r => r.id) : [];
    positions.push({ id, companyId: cl.id, title, family: cl.industry, status, tz: cl.tz, recruiters: recs });
    posRows.push({ id, organization_id: orgId, company_id: cl.id, title, openings: int(1, 3), filled: 0, urgency: pick(['normal', 'normal', 'high', 'critical', 'low']), health: pick(['on_track', 'on_track', 'at_risk', 'critical']), employment_type: pick(['full_time', 'full_time', 'part_time']), schedule: 'Mon–Fri 9:00–17:00', timezone: cl.tz, weekly_hours: 40, skills: sample(fam.skills, 4), software: sample(fam.software, 2), languages: ['English'], equipment: 'Standard remote kit', bill_budget_cents: roundTo(pay * 2.5, 100), pay_min_cents: pay, pay_max_cents: pay + 300, description: `${cl.name} is hiring a ${title} to support its ${cl.industry.replace('_', ' ')} team. You will ${fam.duty}. Schedule: Monday–Friday, ${cl.tz.split('/')[1].replace('_', ' ')} business hours.`, status, created_by: sales.id, created_at: daysAgoTs(int(15, 200)) });
    recs.forEach((r, k) => assignRows.push({ organization_id: orgId, position_id: id, user_id: r, is_lead: k === 0, assigned_by: ownerId, assigned_at: daysAgoTs(int(10, 150)) }));
    if (chance(0.5)) reqRows.push({ organization_id: orgId, position_id: id, title: pick(['Typing test 50+ WPM', 'Prior US client experience', 'HIPAA training certificate', 'Background check clear']), required: chance(0.7) });
  }
  await insert('positions', posRows);
  await insert('position_recruiter_assignments', assignRows);
  await insert('position_requirements', reqRows);
  // client onboarding requirements (template per first few clients)
  for (const cl of clientIds.slice(0, 4)) {
    const t = uid();
    await insert('onboarding_templates', [{ id: t, organization_id: orgId, name: `${cl.name} requirements`, scope: 'client', company_id: cl.id }]);
    await insert('onboarding_template_items', [
      { organization_id: orgId, template_id: t, title: cl.industry === 'dental' ? 'HIPAA training certificate' : 'Client NDA signed', required: true, owner: 'worker', sort: 0 },
      { organization_id: orgId, template_id: t, title: 'Client systems access granted', required: true, owner: 'client', sort: 1 },
      { organization_id: orgId, template_id: t, title: 'Meet-and-greet call with client', required: false, owner: 'client', sort: 2 },
    ]);
  }

  // sourcing links
  const linkRows: Record<string, unknown>[] = [];
  const recruiterLink: Record<string, string> = {};
  for (const r of recruiters) { const id = uid(); recruiterLink[r.id] = id; linkRows.push({ id, organization_id: orgId, user_id: r.id, token: token(9), label: 'Personal link', created_at: daysAgoTs(200) }); }
  for (const p of positions.filter(p => p.status === 'open')) for (const r of p.recruiters) linkRows.push({ organization_id: orgId, user_id: r, position_id: p.id, token: token(9), label: p.title, created_at: daysAgoTs(int(5, 60)) });
  await insert('sourcing_links', linkRows);

  // ── candidates ──
  const hiredN = cfg.nPlacements.active + cfg.nPlacements.onboarding + cfg.nPlacements.on_leave + cfg.nPlacements.ended;
  const restN = cfg.nCandidates - hiredN;
  const restStatuses = ['new_applicant', 'new_applicant', 'new_applicant', 'screening', 'screening', 'assessment', 'recruiter_review', 'recruiter_review', 'interview', 'qualified', 'qualified', 'talent_pool', 'talent_pool', 'submitted', 'submitted', 'on_hold', 'future', 'rejected', 'withdrawn'];
  const cands: { id: string; first: string; last: string; email: string; status: string; family: string; country: string; recruiter: string | null; payCents: number; tz: string }[] = [];
  const candRows: Record<string, unknown>[] = [];
  const famKeys = Object.keys(FAMILIES);
  for (let i = 0; i < cfg.nCandidates; i++) {
    const hired = i < hiredN;
    let status = hired ? 'hired' : restStatuses[(i - hiredN) % restStatuses.length];
    if (!hired && i === cfg.nCandidates - 1) status = 'blacklisted';
    const country = COUNTRIES[cfg.countries[i % cfg.countries.length]];
    let first = pick(country.first), last = pick(country.last);
    const familyKey = hired ? positions[i % positions.length].family : famKeys[i % famKeys.length];
    if (cfg.special && i === 0) { first = 'Jose'; last = 'Ramirez'; }
    if (cfg.special && i === hiredN) { first = 'Maria'; last = 'Santos'; status = 'assessment'; }
    const fam = FAMILIES[familyKey];
    const years = int(1, 12);
    const skills = sample(fam.skills, int(3, 6));
    const software = sample(fam.software, int(2, 4));
    const langs = ['English', ...(country.lang ? [country.lang] : [])];
    const minR = int(country.rate[0], country.rate[1]) * 50;
    const id = uid();
    const email = cfg.special && i === 0 ? 'worker@veyro.demo' : cfg.special && i === hiredN ? 'candidate@veyro.demo' : `${first.toLowerCase().replace(/\s/g, '')}.${last.toLowerCase().replace(/\s/g, '')}${i}@mail.example`;
    const phone = `${country.dial} 555 ${String(1000 + i).slice(-4)}`;
    const recruiter = recruiters.length ? recruiters[i % recruiters.length].id : null;
    const edu = { degree: pick(['BS Business Administration', 'BA Communication', 'BS Accountancy', 'BS Information Technology', 'BA English', 'BS Nursing', 'Associate in Office Administration']), school: pick(UNIVERSITIES[country.code] ?? UNIVERSITIES.PH), year: 2024 - years - int(0, 3) };
    const exp = [0, 1].map(k => ({ title: k === 0 ? fam.role : pick(['Customer Service Representative', 'Administrative Assistant', 'Data Entry Specialist']), company: pick(EMPLOYERS), start: 2025 - years + k * Math.ceil(years / 2), end: k === 0 ? 'Present' : String(2025 - Math.floor(years / 2)) }));
    const resume = [
      `${first} ${last}`,
      `${fam.role} · ${country.city}, ${country.name}`,
      `Email: ${email} | Phone: ${phone}`,
      '',
      'SUMMARY',
      `${years} years of experience as a ${fam.role.toLowerCase()} supporting US-based ${familyKey.replace('_', ' ')} businesses. Known for reliability, clear communication and ${skills[0].toLowerCase()}.`,
      '',
      'EXPERIENCE',
      ...exp.flatMap(e => [`${e.title} — ${e.company} (${e.start}–${e.end})`, `- ${fam.duty[0].toUpperCase() + fam.duty.slice(1)}`, `- Used ${software.slice(0, 2).join(' and ')} daily for ${skills.slice(1, 3).join(' and ').toLowerCase()}`]),
      '',
      'EDUCATION',
      `${edu.degree} — ${edu.school}, ${edu.year}`,
      '',
      'SKILLS',
      skills.join(', '),
      '',
      'SOFTWARE',
      software.join(', '),
      '',
      'LANGUAGES',
      langs.map((l, k) => `${l} (${k === 0 && country.lang ? 'fluent' : 'native'})`).join(', '),
    ].join('\n');
    const created = hired ? int(200, 400) : status === 'new_applicant' ? int(0, 10) : int(10, 170);
    cands.push({ id, first, last, email, status, family: familyKey, country: country.name, recruiter, payCents: minR, tz: country.tz });
    candRows.push({ id, organization_id: orgId, first_name: first, last_name: last, email, phone, country: country.name, city: country.city, timezone: country.tz, headline: fam.role, years_experience: years, skills, software, languages: langs, education: JSON.stringify([{ ...edu, evidence: `${edu.degree} — ${edu.school}, ${edu.year}` }]), experience: JSON.stringify(exp), rate_min_cents: minR, rate_target_cents: minR + int(1, 4) * 50, rate_currency: 'USD', rate_unit: 'hour', availability_status: hired ? 'employed' : pick(['available', 'available', 'employed']), earliest_start: addDays(TODAY, int(0, 30)), weekly_hours: 40, preferred_hours: 'US Eastern business hours', resume_text: resume, portfolio_url: chance(0.25) ? `https://portfolio.example/${first.toLowerCase()}${i}` : null, source: recruiter && chance(0.6) ? 'Recruiter link' : pick(['Website', 'LinkedIn', 'Referral', 'Job board', 'Facebook group']), sourced_by: recruiter, tags: chance(0.3) ? [pick(['bilingual', 'night shift ok', 'fast typer', 'top performer', 'rehire'])] : [], status, status_reason: status === 'blacklisted' ? 'Falsified employment history (verified with prior employer)' : status === 'rejected' ? 'Insufficient English proficiency for client-facing role' : null, avatar_color: pick(COLORS), created_by: recruiter, created_at: daysAgoTs(created), updated_at: daysAgoTs(Math.max(0, created - int(0, 5))) });
  }
  await insert('candidates', candRows);

  // applications
  const appRows: Record<string, unknown>[] = [];
  const openPositions = positions.filter(p => p.status === 'open' || p.status === 'filled');
  for (const [i, cd] of cands.entries()) {
    const pos = openPositions.filter(p => p.family === cd.family);
    const p = pos.length ? pick(pos) : pick(openPositions);
    const viaLink = cd.recruiter && chance(0.6);
    appRows.push({ organization_id: orgId, candidate_id: cd.id, position_id: chance(0.85) ? p.id : null, source: viaLink ? 'Recruiter link' : pick(['Website', 'LinkedIn', 'Job board']), recruiter_id: cd.recruiter, sourcing_link_id: viaLink ? recruiterLink[cd.recruiter!] : null, status: cd.status === 'new_applicant' ? 'new' : 'advanced', created_at: (candRows[i].created_at as string) });
    if (i % 5 === 0) appRows.push({ organization_id: orgId, candidate_id: cd.id, position_id: pick(openPositions).id, source: 'Website', recruiter_id: cd.recruiter, status: 'reviewed', created_at: daysAgoTs(int(1, 30)) });
  }
  await insert('applications', appRows);

  // submissions
  const subRows: Record<string, unknown>[] = [];
  const subFor: Record<string, { id: string; positionId: string }> = {};
  const hiredCands = cands.slice(0, hiredN);
  const placementPositions: typeof positions = [];
  for (const [i, cd] of hiredCands.entries()) {
    const p = cfg.special && i === 0 ? positions.find(pp => pp.companyId === clientIds[0].id)! : positions[i % positions.length];
    placementPositions.push(p);
    const id = uid(); subFor[cd.id] = { id, positionId: p.id };
    subRows.push({ id, organization_id: orgId, candidate_id: cd.id, position_id: p.id, status: 'hired', submitted_by: cd.recruiter, shareable: JSON.stringify({ contact: false, rate: false, notes: false }), presentation: `${cd.first} brings experience in ${FAMILIES[cd.family].skills.slice(0, 2).join(' and ').toLowerCase()}.`, client_decision: 'approve', created_at: daysAgoTs(int(200, 420)) });
  }
  const subStatuses = ['submitted', 'client_review', 'client_review', 'client_interview', 'offer', 'rejected'];
  const pipelineCands = cands.filter(cd => ['submitted', 'interview', 'qualified', 'talent_pool'].includes(cd.status));
  for (const [i, cd] of pipelineCands.entries()) {
    const st = cd.status === 'submitted' ? subStatuses[i % subStatuses.length] : 'rejected';
    if (cd.status !== 'submitted' && i % 3 !== 0) continue;
    const pos = openPositions.filter(p => p.status === 'open');
    const p = pos.find(pp => pp.family === cd.family) ?? pick(pos.length ? pos : positions);
    const id = uid(); subFor[cd.id] = { id, positionId: p.id };
    subRows.push({ id, organization_id: orgId, candidate_id: cd.id, position_id: p.id, status: st, submitted_by: cd.recruiter, shareable: JSON.stringify({ contact: false, rate: false, notes: false }), presentation: `${cd.first} — ${FAMILIES[cd.family].role}, strong in ${FAMILIES[cd.family].skills[0].toLowerCase()}.`, client_feedback: st === 'rejected' ? 'Looking for more years in a similar role.' : st === 'client_interview' ? 'Strong profile — would like to meet.' : null, created_at: daysAgoTs(int(2, 40)) });
  }
  await insert('candidate_submissions', subRows);

  // interviews
  const intRows: Record<string, unknown>[] = [];
  const fbRows: Record<string, unknown>[] = [];
  const intCands = cands.filter(cd => ['interview', 'submitted', 'qualified', 'talent_pool', 'hired'].includes(cd.status)).slice(0, cfg.nInterviews);
  for (const [i, cd] of intCands.entries()) {
    const future = i % 3 === 0;
    const when = future ? new Date(Date.now() + int(1, 7) * 86400000 + int(1, 8) * 3600000) : new Date(Date.now() - int(1, 60) * 86400000);
    when.setUTCMinutes(when.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    const id = uid();
    const kind = subFor[cd.id] && i % 2 === 0 ? 'client' : 'internal';
    intRows.push({ id, organization_id: orgId, candidate_id: cd.id, position_id: subFor[cd.id]?.positionId ?? null, submission_id: kind === 'client' ? subFor[cd.id]?.id ?? null : null, kind, scheduled_at: when.toISOString(), duration_min: kind === 'client' ? 45 : 30, timezone: 'America/New_York', meeting_url: `https://meet.veyro.local/${token(6)}`, interviewers: kind === 'client' ? 'Client hiring manager' : staffName(cd.recruiter), interviewer_ids: cd.recruiter ? [cd.recruiter] : [], status: future ? 'scheduled' : 'completed', outcome: future ? null : pick(['advance', 'advance', 'hold', 'reject']), created_by: cd.recruiter, created_at: new Date(when.getTime() - 3 * 86400000).toISOString() });
    if (!future) fbRows.push({ organization_id: orgId, interview_id: id, author_id: cd.recruiter, author_label: staffName(cd.recruiter), scores: JSON.stringify({ communication: int(3, 5), experience: int(2, 5), culture: int(3, 5), technical: int(2, 5) }), overall: int(3, 5), recommendation: pick(['hire', 'hire', 'maybe', 'no_hire']), notes: pick(['Clear communicator, good examples.', 'Solid tools knowledge; slightly slow on scenario questions.', 'Great energy, would be a strong fit.']) });
  }
  await insert('interviews', intRows);
  await insert('interview_feedback', fbRows);
  function staffName(id: string | null) { return Object.values(staff).find(s => s.id === id)?.name ?? null; }

  // assessments
  const tpls = (await c.query(`SELECT id FROM assessment_templates WHERE organization_id=$1`, [orgId])).rows.map(r => r.id);
  const asmRows: Record<string, unknown>[] = [];
  for (const [i, cd] of cands.filter(cd => ['assessment', 'recruiter_review', 'interview', 'qualified'].includes(cd.status)).entries()) {
    const st = cd.status === 'assessment' ? (i % 2 ? 'sent' : 'started') : 'scored';
    asmRows.push({ organization_id: orgId, template_id: tpls[i % tpls.length], candidate_id: cd.id, status: st, answers: JSON.stringify(st === 'scored' ? { '0': 'I would acknowledge the frustration, apologise, and offer the two earliest available slots.', '1': 'Triage by urgency, reply to patients first, batch internal messages.' } : {}), score: st === 'scored' ? int(62, 96) : null, sent_by: cd.recruiter, sent_at: daysAgoTs(int(3, 30)), completed_at: st === 'scored' ? daysAgoTs(int(1, 3)) : null, scored_at: st === 'scored' ? daysAgoTs(1) : null });
  }
  await insert('assessments', asmRows);

  // ── workers & placements ──
  const workerRows: Record<string, unknown>[] = [];
  const placementRows: Record<string, unknown>[] = [];
  const rateRows: Record<string, unknown>[] = [];
  const onbRows: Record<string, unknown>[] = [];
  const offerRows: Record<string, unknown>[] = [];
  interface PL { id: string; workerId: string; companyId: string; candidate: (typeof cands)[0]; title: string; status: string; start: string; end: string | null; tz: string; rates: Rate[]; am: string; recruiter: string | null; ot: boolean; leaveFrom: string | null }
  const pls: PL[] = [];
  const statusList = [...Array(cfg.nPlacements.active).fill('active'), ...Array(cfg.nPlacements.onboarding).fill('onboarding'), ...Array(cfg.nPlacements.on_leave).fill('on_leave'), ...Array(cfg.nPlacements.ended).fill('ended')];
  for (const [i, cd] of hiredCands.entries()) {
    const status = statusList[i];
    const pos = placementPositions[i];
    const comp = clientIds.find(cl => cl.id === pos.companyId)!;
    const workerId = uid(), plId = uid();
    const start = status === 'onboarding' ? addDays(TODAY, int(3, 14)) : cfg.special && i === 0 ? addDays(TODAY, -240) : addDays(TODAY, -int(40, 420));
    const end = status === 'ended' ? addDays(TODAY, -int(30, 60)) : null;
    const pay = roundTo(cd.payCents + int(0, 2) * 50, 50);
    const bill = roundTo(pay * (2.2 + rnd() * 0.5), 50);
    const rates: Rate[] = [];
    const r1 = uid();
    const baseRate = cfg.special && i === 0 ? { pay: 600, bill: 1500 } : { pay, bill };
    const raise = cfg.special && i === 0 ? addDays(TODAY, -60) : (status === 'active' && chance(0.45) ? addDays(TODAY, -int(20, 140)) : null);
    // mid-week raise date (Wednesday) so rate periods split inside a week
    const raiseDate = raise ? addDays(weekStart(raise), 2) : null;
    rates.push({ id: r1, effectiveFrom: start, effectiveTo: raiseDate && raiseDate > start ? addDays(raiseDate, -1) : null, payRateCents: baseRate.pay, billRateCents: baseRate.bill, currency: 'USD', unit: 'hour', otMultiplierBp: 15000, otThresholdMinutes: 2400 });
    if (raiseDate && raiseDate > start) rates.push({ id: uid(), effectiveFrom: raiseDate, effectiveTo: null, payRateCents: baseRate.pay + (cfg.special && i === 0 ? 100 : 50 * int(1, 2)), billRateCents: baseRate.bill + (cfg.special && i === 0 ? 100 : 100 * int(1, 2)), currency: 'USD', unit: 'hour', otMultiplierBp: 15000, otThresholdMinutes: 2400 });
    for (const r of rates) rateRows.push({ id: r.id, organization_id: orgId, placement_id: plId, effective_from: r.effectiveFrom, effective_to: r.effectiveTo, pay_rate_cents: r.payRateCents, bill_rate_cents: r.billRateCents, currency: r.currency, unit: r.unit, ot_multiplier_bp: r.otMultiplierBp, ot_threshold_minutes: r.otThresholdMinutes, reason: r === rates[0] ? 'Initial rate' : 'Performance raise', created_by: pick(byRole('finance').length ? byRole('finance') : [Object.values(staff)[0]]).id, created_at: r === rates[0] ? ts(start, 10) : ts(addDays(r.effectiveFrom, -5), 15) });
    const am = pick(ams).id;
    const workerStatus = status === 'ended' ? 'available' : status === 'onboarding' ? 'pending' : status;
    workerRows.push({ id: workerId, organization_id: orgId, candidate_id: cd.id, status: workerStatus, employee_code: `W-${1000 + i}`, payout_account_label: `Wise •••• ${int(1000, 9999)}`, created_at: ts(start, 9) });
    const salesId = sales.id;
    placementRows.push({ id: plId, organization_id: orgId, worker_id: workerId, company_id: comp.id, position_id: pos.id, title: pos.title, status, start_date: start, end_date: end, end_reason: end ? pick(['Client downsized team', 'Worker resigned (new opportunity)']) : null, timezone: comp.tz, weekly_hours: 40, account_manager_id: am, recruiter_id: cd.recruiter, sales_id: salesId, monitoring_policy_id: defaultPolicy, policy_accepted_at: status === 'onboarding' ? null : ts(start, 8), equipment: JSON.stringify(['Laptop/desktop (8GB+ RAM)', '25 Mbps internet + backup', 'Noise-cancelling headset']), activated_at: status === 'onboarding' ? null : ts(start, 8), activated_by: status === 'onboarding' ? null : am, ended_at: end ? ts(end, 18) : null, created_by: am, created_at: ts(addDays(start, -10), 14) });
    pls.push({ id: plId, workerId, companyId: comp.id, candidate: cd, title: pos.title, status, start, end, tz: comp.tz, rates, am, recruiter: cd.recruiter, ot: i === 3, leaveFrom: status === 'on_leave' ? addDays(TODAY, -int(5, 12)) : null });
    // onboarding items
    const clientItems = (await c.query(`SELECT i.title, i.required, i.owner FROM onboarding_template_items i JOIN onboarding_templates t ON t.id=i.template_id WHERE t.company_id=$1`, [comp.id])).rows;
    let sort = 0;
    for (const it of onboardingItems) onbRows.push({ organization_id: orgId, placement_id: plId, title: it.title, source: 'agency', required: it.required, owner: it.owner, done_at: status === 'onboarding' ? (chance(0.4) ? daysAgoTs(int(1, 4)) : null) : ts(start, 8), done_by: status === 'onboarding' ? null : am, sort: sort++ });
    for (const it of clientItems) onbRows.push({ organization_id: orgId, placement_id: plId, title: it.title, source: 'client', required: it.required, owner: it.owner, done_at: status === 'onboarding' ? null : ts(start, 8), done_by: status === 'onboarding' ? null : am, sort: sort++ });
    // offers for recent hires
    if (status === 'onboarding' || i < 2) offerRows.push({ organization_id: orgId, candidate_id: cd.id, position_id: pos.id, submission_id: subFor[cd.id]?.id, pay_rate_cents: rates[0].payRateCents, bill_rate_cents: rates[0].billRateCents, weekly_hours: 40, start_date: start, status: 'accepted', approved_by: ownerId, approved_at: ts(addDays(start, -14)), sent_at: ts(addDays(start, -13)), viewed_at: ts(addDays(start, -13), 15), responded_at: ts(addDays(start, -12)), signature_name: `${cd.first} ${cd.last}`, signed_at: ts(addDays(start, -12)), signed_ip: '203.0.113.' + int(2, 250), placement_id: plId, terms: 'Full-time remote contractor engagement, Monday–Friday.', created_by: cd.recruiter, created_at: ts(addDays(start, -15)) });
  }
  // open offers for candidates at "offer" submission stage
  for (const sr of subRows.filter(sr => sr.status === 'offer' || sr.status === 'client_interview').slice(0, Math.max(0, cfg.nOffers - offerRows.length))) {
    const cd = cands.find(x => x.id === sr.candidate_id)!;
    const st = pick(['draft', 'approved', 'sent', 'viewed']);
    offerRows.push({ organization_id: orgId, candidate_id: cd.id, position_id: sr.position_id, submission_id: sr.id, pay_rate_cents: cd.payCents + 100, bill_rate_cents: roundTo((cd.payCents + 100) * 2.4, 50), weekly_hours: 40, start_date: addDays(TODAY, int(10, 25)), expires_at: addDays(TODAY, 10), status: st, approved_by: st !== 'draft' ? ownerId : null, approved_at: st !== 'draft' ? daysAgoTs(3) : null, sent_at: ['sent', 'viewed'].includes(st) ? daysAgoTs(2) : null, viewed_at: st === 'viewed' ? daysAgoTs(1) : null, terms: 'Full-time remote contractor engagement.', created_by: cd.recruiter, created_at: daysAgoTs(5) });
  }
  await insert('workers', workerRows);
  await insert('placements', placementRows);
  await insert('placement_rates', rateRows);
  await insert('placement_onboarding_items', onbRows);
  await insert('offers', offerRows);
  for (const p of positions) await c.query(`UPDATE positions SET filled = (SELECT count(*) FROM placements WHERE position_id=$1 AND status <> 'ended') WHERE id=$1`, [p.id]);
  await insert('seat_usage', pls.filter(p => p.status !== 'onboarding').map(p => ({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, started_at: ts(p.start, 8), ended_at: p.end ? ts(p.end, 18) : null, started_by: p.am })));

  // ── time entries, attendance, timesheets ──
  const teRows: Record<string, unknown>[] = [];
  const attRows: Record<string, unknown>[] = [];
  const dayMinutes = new Map<string, Map<string, number>>(); // placement -> date -> minutes
  const entriesByPlDay = new Map<string, { id: string; start: Date; end: Date }[]>();
  const timeOffRows: Record<string, unknown>[] = [];
  for (const p of pls) {
    if (p.status === 'onboarding') continue;
    const dm = new Map<string, number>();
    dayMinutes.set(p.id, dm);
    const from = p.start > WINDOW_START ? p.start : WINDOW_START;
    const to = p.end && p.end < TODAY ? p.end : addDays(TODAY, -1);
    if (p.leaveFrom) timeOffRows.push({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, kind: 'vacation', start_date: p.leaveFrom, end_date: addDays(TODAY, int(5, 14)), note: 'Family trip — approved by client.', status: 'approved', decided_by: p.am, decided_at: ts(addDays(p.leaveFrom, -10)) });
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (isoDow(d) > 5) continue;
      if (p.leaveFrom && d >= p.leaveFrom) continue;
      if (chance(0.025)) { attRows.push({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, work_date: d, kind: 'absent', note: 'No clock-in recorded' }); continue; }
      const late = chance(0.06) ? int(16, 40) : 0;
      const jitter = late || int(-6, 4);
      const startM = 9 * 60 + jitter;
      const lunchStart = 12 * 60 + 30 + int(-10, 15);
      const lunchEnd = lunchStart + int(30, 45);
      const endM = (p.ot ? 18 * 60 + 30 : 17 * 60) + int(-5, 20);
      const sessions: [number, number][] = [[startM, lunchStart], [lunchEnd, endM]];
      let total = 0;
      const list: { id: string; start: Date; end: Date }[] = [];
      for (const [a, b] of sessions) {
        const id = uid();
        const st = zonedToUtc(d, `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`, p.tz);
        const en = zonedToUtc(d, `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`, p.tz);
        const idle = chance(0.2) ? int(1, 6) * 60 : 0;
        teRows.push({ id, organization_id: orgId, placement_id: p.id, worker_id: p.workerId, work_date: d, started_at: st.toISOString(), ended_at: en.toISOString(), source: 'tracker', idle_seconds: idle, memo: chance(0.3) ? pick(['Inbox zero + scheduling', 'Insurance verifications', 'Weekly report', 'Patient callbacks', 'Data cleanup']) : null });
        total += b - a;
        list.push({ id, start: st, end: en });
      }
      entriesByPlDay.set(`${p.id}|${d}`, list);
      dm.set(d, total);
      if (late) attRows.push({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, work_date: d, kind: 'late', minutes: late, note: `Clocked in ${late} min after shift start` });
    }
  }
  await insert('time_entries', teRows);
  await insert('attendance_events', attRows);
  await insert('time_off_requests', timeOffRows);

  const tsRows: Record<string, unknown>[] = [];
  const tsDayRows: Record<string, unknown>[] = [];
  const tsDayIndex = new Map<string, { id: string; tsId: string }>(); // placement|date -> timesheet_day id
  const approvalRows: Record<string, unknown>[] = [];
  const clientApprover = cfg.special ? null : null;
  for (const p of pls) {
    const dm = dayMinutes.get(p.id);
    if (!dm) continue;
    const weeks = new Set([...dm.keys()].map(weekStart));
    if (p.status !== 'ended' && p.start <= TODAY) weeks.add(THIS_WEEK);
    for (const wk of [...weeks].sort()) {
      const id = uid();
      const days = [...dm.entries()].filter(([d]) => weekStart(d) === wk);
      const total = days.reduce((a, [, m]) => a + m, 0);
      let status = wk < LAST_WEEK ? 'approved' : wk === LAST_WEEK ? (chance(0.55) ? 'approved' : 'submitted') : 'open';
      if (cfg.special && p.candidate.email === 'worker@veyro.demo' && wk === LAST_WEEK) status = 'submitted';
      const approvedAt = ts(addDays(wk, 8), 16);
      tsRows.push({ id, organization_id: orgId, placement_id: p.id, worker_id: p.workerId, company_id: p.companyId, week_start: wk, status, total_minutes: total, submitted_at: status !== 'open' ? ts(addDays(wk, 5), 22) : null, client_approved_at: status === 'approved' ? approvedAt : null, client_approved_by: clientApprover, agency_approved_at: status === 'approved' ? approvedAt : null, agency_approved_by: status === 'approved' ? p.am : null, approved_at: status === 'approved' ? approvedAt : null, created_at: ts(wk, 8) });
      if (status !== 'open') approvalRows.push({ organization_id: orgId, timesheet_id: id, actor_id: null, party: 'agency', decision: 'submitted', created_at: ts(addDays(wk, 5), 22) });
      if (status === 'approved') {
        approvalRows.push({ organization_id: orgId, timesheet_id: id, actor_id: p.am, party: 'client', decision: 'approved', created_at: approvedAt });
        for (const [d, m] of days) { const did = uid(); tsDayRows.push({ id: did, organization_id: orgId, timesheet_id: id, placement_id: p.id, work_date: d, minutes: m }); tsDayIndex.set(`${p.id}|${d}`, { id: did, tsId: id }); }
      }
    }
  }
  await insert('timesheets', tsRows);
  await insert('timesheet_days', tsDayRows);
  await insert('timesheet_approvals', approvalRows);

  // ── invoices & payments ──
  const invRows: Record<string, unknown>[] = [];
  const lineRows: Record<string, unknown>[] = [];
  const payRows: Record<string, unknown>[] = [];
  const histRows: Record<string, unknown>[] = [];
  const syncRows: Record<string, unknown>[] = [];
  const tsDayInvoice: { id: string; invoiceId: string }[] = [];
  let invSeq = 1001;
  const revenueByPlMonth = new Map<string, number>();
  const monthsBack = [6, 5, 4, 3, 2, 1];
  for (const mb of monthsBack) {
    const mStart = monthStart(addMonths(TODAY, -mb));
    const mEnd = monthEnd(mStart);
    for (const cl of clientIds) {
      const clPls = pls.filter(p => p.companyId === cl.id && dayMinutes.has(p.id));
      const lines: Record<string, unknown>[] = [];
      const invId = uid();
      for (const p of clPls) {
        const days = [...dayMinutes.get(p.id)!.entries()].filter(([d]) => d >= mStart && d <= mEnd && tsDayIndex.has(`${p.id}|${d}`)).map(([date, minutes]) => ({ date, minutes }));
        if (!days.length) continue;
        for (const l of linesByRate(days, p.rates, 'bill')) {
          lines.push({ organization_id: orgId, invoice_id: invId, kind: 'time', placement_id: p.id, worker_id: p.workerId, rate_id: l.rateId, description: `${p.candidate.first} ${p.candidate.last} — ${p.title} (${l.from} to ${l.to})`, period_start: l.from, period_end: l.to, minutes: l.minutes, quantity: (l.minutes / 60).toFixed(2), unit_price_cents: l.rateCents, amount_cents: l.amountCents, timesheet_ids: [...new Set(days.filter(d => d.date >= l.from && d.date <= l.to).map(d => tsDayIndex.get(`${p.id}|${d.date}`)!.tsId))], sort: lines.length });
          revenueByPlMonth.set(`${p.id}|${mStart}`, (revenueByPlMonth.get(`${p.id}|${mStart}`) ?? 0) + l.amountCents);
        }
        for (const d of days) tsDayInvoice.push({ id: tsDayIndex.get(`${p.id}|${d.date}`)!.id, invoiceId: invId });
      }
      if (!lines.length) continue;
      const totals = invoiceTotals({ lineAmounts: lines.map(l => l.amount_cents as number), taxBp: cl.tax });
      const issue = addDays(mEnd, 1);
      const terms = 15;
      const due = addDays(issue, terms);
      let status: string; let paid = 0;
      if (mb >= 3) { status = 'paid'; paid = totals.totalCents; }
      else if (mb === 2) { status = chance(0.75) ? 'paid' : 'partially_paid'; paid = status === 'paid' ? totals.totalCents : Math.round(totals.totalCents * 0.5); }
      else { const r = rnd(); status = r < 0.45 ? 'paid' : r < 0.6 ? 'partially_paid' : due < TODAY ? 'overdue' : 'sent'; paid = status === 'paid' ? totals.totalCents : status === 'partially_paid' ? Math.round(totals.totalCents * 0.4) : 0; }
      const number = `INV-${invSeq++}`;
      invRows.push({ id: invId, organization_id: orgId, company_id: cl.id, number, period_start: mStart, period_end: mEnd, issue_date: issue, due_date: due, status, currency: 'USD', subtotal_cents: totals.subtotalCents, tax_bp: cl.tax, tax_cents: totals.taxCents, total_cents: totals.totalCents, paid_cents: paid, pay_token: token(16), approved_by: byRole('finance')[0]?.id ?? ownerId, approved_at: ts(issue, 10), sent_at: ts(issue, 11), viewed_at: ts(addDays(issue, 1), 15), paid_at: status === 'paid' ? ts(addDays(issue, int(3, terms + 3)), 14) : null, overdue_at: status === 'overdue' ? ts(addDays(due, 1), 6) : null, accounting_external_id: status === 'paid' ? `QBO-${int(10000, 99999)}` : null, created_by: byRole('finance')[0]?.id ?? ownerId, created_at: ts(issue, 9) });
      lineRows.push(...lines);
      histRows.push({ organization_id: orgId, invoice_id: invId, subtotal_cents: totals.subtotalCents, tax_cents: totals.taxCents, total_cents: totals.totalCents, reason: 'Generated from approved timesheets', created_at: ts(issue, 9) });
      if (paid > 0) {
        const pid = uid();
        payRows.push({ id: pid, organization_id: orgId, invoice_id: invId, company_id: cl.id, amount_cents: paid, currency: 'USD', method: pick(['card', 'ach', 'ach']), status: 'succeeded', card_brand: 'visa', card_last4: '4242', provider: 'stripe-sim', provider_ref: `ch_sim_${token(10)}`, idempotency_key: `seed-${invId}`, receipt_number: `RCPT-${invSeq}`, received_at: ts(addDays(issue, int(3, terms + 3)), 14) });
        syncRows.push({ organization_id: orgId, entity_type: 'payment', entity_id: pid, status: 'synced', external_id: `QBO-PMT-${int(10000, 99999)}` });
      }
      syncRows.push({ organization_id: orgId, entity_type: 'invoice', entity_id: invId, status: mb === 1 && syncRows.length % 9 === 0 ? 'failed' : 'synced', external_id: mb === 1 && syncRows.length % 9 === 0 ? null : `QBO-${int(10000, 99999)}`, error: mb === 1 && syncRows.length % 9 === 0 ? 'Customer not found in QuickBooks (mapping missing)' : null });
    }
  }
  await insert('invoices', invRows);
  await insert('invoice_lines', lineRows);
  await insert('invoice_total_history', histRows);
  await insert('payments', payRows);
  await insert('accounting_sync_log', syncRows);
  for (const t of tsDayInvoice) await c.query(`UPDATE timesheet_days SET invoice_id=$2 WHERE id=$1`, [t.id, t.invoiceId]);
  await c.query(`UPDATE timesheets t SET status='locked', locked_at=approved_at + interval '20 days' WHERE organization_id=$1 AND status='approved' AND NOT EXISTS (SELECT 1 FROM timesheet_days d WHERE d.timesheet_id=t.id AND d.invoice_id IS NULL)`, [orgId]);

  // ── payroll runs, payslips, payouts ──
  const periods: [string, string][] = [];
  for (let m = 6; m >= 0; m--) {
    const ms = monthStart(addMonths(TODAY, -m));
    periods.push([ms, addDays(ms, 14)], [addDays(ms, 15), monthEnd(ms)]);
  }
  const runPeriods = periods.filter(([, e]) => e < addDays(TODAY, -3) && e >= WINDOW_START).slice(-12);
  const costByPlMonth = new Map<string, number>();
  for (const [ri, [ps, pe]] of runPeriods.entries()) {
    const runId = uid();
    const items: Record<string, unknown>[] = [];
    const isLast = ri === runPeriods.length - 1;
    const payDate = addDays(pe, 5);
    for (const p of pls) {
      const dm = dayMinutes.get(p.id);
      if (!dm) continue;
      const days = [...dm.entries()].filter(([d]) => d >= ps && d <= pe && tsDayIndex.has(`${p.id}|${d}`)).map(([date, minutes]) => ({ date, minutes }));
      if (!days.length) continue;
      const calc = computePayroll(days, p.rates);
      const bonus = chance(0.08) ? int(2, 5) * 1000 : 0;
      const deduction = chance(0.05) ? 2000 : 0;
      const gross = calc.grossTimeCents + bonus;
      const itemId = uid();
      items.push({ id: itemId, organization_id: orgId, run_id: runId, worker_id: p.workerId, placement_id: p.id, company_id: p.companyId, regular_minutes: calc.regularMinutes, ot_minutes: calc.otMinutes, regular_cents: calc.regularCents, ot_cents: calc.otCents, earnings_cents: bonus, deductions_cents: deduction, gross_cents: gross, net_cents: gross - deduction, currency: 'USD', lines: JSON.stringify(calc.lines), timesheet_ids: [...new Set(days.map(d => tsDayIndex.get(`${p.id}|${d.date}`)!.tsId))], payslip_number: `PS-${ps.replace(/-/g, '').slice(2)}-${String(items.length + 1).padStart(3, '0')}` });
      if (bonus) await insertLater('payroll_earnings', { organization_id: orgId, payroll_item_id: itemId, kind: 'bonus', description: 'Client appreciation bonus', amount_cents: bonus });
      if (deduction) await insertLater('payroll_deductions', { organization_id: orgId, payroll_item_id: itemId, kind: 'equipment', description: 'Headset advance repayment', amount_cents: deduction });
      for (const d of days) laterUpdates.push([tsDayIndex.get(`${p.id}|${d.date}`)!.id, itemId]);
      for (const l of linesByRate(days, p.rates, 'pay')) {
        const k = `${p.id}|${monthStart(l.from)}`;
        costByPlMonth.set(k, (costByPlMonth.get(k) ?? 0) + l.amountCents);
      }
    }
    if (!items.length) continue;
    const gross = items.reduce((a, i) => a + (i.gross_cents as number), 0);
    const net = items.reduce((a, i) => a + (i.net_cents as number), 0);
    const finance = byRole('finance')[0]?.id ?? ownerId;
    await insert('payroll_runs', [{ id: runId, organization_id: orgId, period_start: ps, period_end: pe, frequency: 'semi_monthly', pay_date: payDate, status: isLast ? 'failed' : 'paid', idempotency_key: `payroll:${ps}:${pe}`, total_gross_cents: gross, total_net_cents: net, worker_count: items.length, approved_by: finance, approved_at: ts(addDays(pe, 2), 15), paid_at: isLast ? null : ts(payDate, 12), created_by: finance, created_at: ts(addDays(pe, 1), 10) }]);
    await insert('payroll_items', items);
    const payoutId = uid();
    await insert('payouts', [{ id: payoutId, organization_id: orgId, run_id: runId, status: isLast ? 'partially_failed' : 'paid', idempotency_key: `payout:${runId}`, total_cents: net, initiated_by: finance, created_at: ts(addDays(pe, 3), 10), completed_at: ts(payDate, 12) }]);
    await insert('payout_items', items.map((it, k) => ({ organization_id: orgId, payout_id: payoutId, payroll_item_id: it.id, worker_id: it.worker_id, amount_cents: it.net_cents, status: isLast && k === 1 ? 'failed' : 'paid', attempts: 1, provider_ref: isLast && k === 1 ? null : `wise_tr_${token(8)}`, failure_reason: isLast && k === 1 ? 'Recipient bank rejected transfer: account holder name mismatch' : null })));
  }
  await flushLater();
  for (const [dayId, itemId] of laterUpdates) await c.query(`UPDATE timesheet_days SET payroll_item_id=$2 WHERE id=$1`, [dayId, itemId]);
  laterUpdates.length = 0;

  // ── commissions ──
  const rules = (await c.query(`SELECT * FROM commission_rules WHERE organization_id=$1`, [orgId])).rows;
  const entRows: Record<string, unknown>[] = [];
  for (const mb of [3, 2, 1]) {
    const ms = monthStart(addMonths(TODAY, -mb));
    for (const p of pls) {
      const rev = revenueByPlMonth.get(`${p.id}|${ms}`) ?? 0;
      if (!rev) continue;
      const cost = costByPlMonth.get(`${p.id}|${ms}`) ?? 0;
      const gp = rev - cost;
      const monthsSince = Math.floor((Date.parse(ms) - Date.parse(p.start)) / (30.4 * 86400000));
      const status = mb === 3 ? 'settled' : mb === 2 ? 'approved' : 'calculated';
      for (const rule of rules) {
        const userId = rule.applies_to === 'recruiter' ? p.recruiter : rule.applies_to === 'sales' ? sales.id : p.am;
        if (!userId) continue;
        const amt = computeCommission({ kind: rule.kind, pctBp: rule.pct_bp ?? undefined, fixedCents: rule.fixed_cents ?? undefined, monthsLimit: rule.months_limit }, gp, { monthsSinceStart: monthsSince, isFirstPeriod: monthStart(p.start) === ms });
        if (!amt) continue;
        entRows.push({ organization_id: orgId, rule_id: rule.id, user_id: userId, placement_id: p.id, period_start: ms, period_end: monthEnd(ms), revenue_cents: rev, cost_cents: cost, gp_cents: gp, calculated_cents: amt, approved_cents: status !== 'calculated' ? amt : null, settled_cents: status === 'settled' ? amt : 0, status, approved_by: status !== 'calculated' ? ownerId : null, approved_at: status !== 'calculated' ? ts(addDays(monthEnd(ms), 10)) : null, settled_at: status === 'settled' ? ts(addDays(monthEnd(ms), 20)) : null });
      }
    }
  }
  await insert('commission_entitlements', entRows);

  // ── screenshots & activity (last 5 workdays) ──
  const shotRows: Record<string, unknown>[] = [];
  const actRows: Record<string, unknown>[] = [];
  for (const p of pls.filter(p => p.status === 'active')) {
    for (let back = 1; back <= 8; back++) {
      const d = addDays(TODAY, -back);
      const list = entriesByPlDay.get(`${p.id}|${d}`);
      if (!list) continue;
      for (const e of list) {
        for (let t = e.start.getTime(); t + 600000 <= e.end.getTime(); t += 600000) {
          const k = int(0, MOCK_FILE_COUNT - 1);
          const pct = int(38, 96);
          const at = new Date(t + int(30, 570) * 1000).toISOString();
          shotRows.push({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, time_entry_id: e.id, taken_at: at, file: `mock/mock-${k}.svg`, kind: 'mock', app_label: MOCK_APPS[k % MOCK_APPS.length].app, url_label: MOCK_APPS[k % MOCK_APPS.length].url, activity_pct: pct, flagged: chance(0.004) });
          actRows.push({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, time_entry_id: e.id, bucket_start: new Date(t).toISOString(), bucket_seconds: 600, key_count: int(150, 900), mouse_count: int(80, 600), active_seconds: Math.round(600 * pct / 100), idle_seconds: 600 - Math.round(600 * pct / 100), activity_pct: pct, app_label: MOCK_APPS[k % MOCK_APPS.length].app });
        }
      }
    }
  }
  await insert('screenshots', shotRows);
  await insert('activity_samples', actRows);

  // ── documents ──
  const docRows: Record<string, unknown>[] = [];
  for (const [i, p] of pls.entries()) {
    const name = `${p.candidate.first} ${p.candidate.last}`;
    docRows.push({ organization_id: orgId, entity_type: 'worker', entity_id: p.workerId, name: `Contractor Agreement — ${name}`, category: 'contract', file: writeDoc(`Independent Contractor Agreement\n\n${cfg.name} and ${name}\nEffective ${p.start}\n\nSigned electronically by ${name}.`), mime: 'text/plain', visibility: 'worker', issue_date: p.start, verification: 'verified', signature_status: p.status === 'onboarding' ? 'pending' : 'signed', created_by: p.am, created_at: ts(p.start, 7) });
    const exp = i % 9 === 0 ? addDays(TODAY, int(5, 28)) : i % 13 === 0 ? addDays(TODAY, -int(3, 20)) : addDays(TODAY, int(90, 900));
    docRows.push({ organization_id: orgId, entity_type: 'worker', entity_id: p.workerId, name: `Government ID — ${name}`, category: 'id', file: writeDoc(`Government ID scan placeholder for ${name}.`), mime: 'text/plain', visibility: 'internal', issue_date: addDays(exp, -1825), expires_at: exp, verification: i % 7 === 0 ? 'unverified' : 'verified', created_by: p.am, created_at: ts(p.start, 7) });
    if (i % 4 === 0) docRows.push({ organization_id: orgId, entity_type: 'worker', entity_id: p.workerId, name: `W-8BEN — ${name}`, category: 'compliance', file: writeDoc(`W-8BEN placeholder for ${name}.`), mime: 'text/plain', visibility: 'worker', issue_date: addDays(TODAY, -int(100, 900)), expires_at: i % 8 === 0 ? addDays(TODAY, int(10, 25)) : addDays(TODAY, int(200, 900)), verification: 'verified', created_by: p.am });
  }
  for (const cl of clientIds) docRows.push({ organization_id: orgId, entity_type: 'company', entity_id: cl.id, name: `Master Services Agreement — ${cl.name}`, category: 'contract', file: writeDoc(`Master Services Agreement between ${cfg.name} and ${cl.name}.`), mime: 'text/plain', visibility: 'client', verification: 'verified', signature_status: 'signed', created_by: sales.id });
  await insert('documents', docRows);

  // ── tasks ──
  const taskRows: Record<string, unknown>[] = [];
  const taskAssign: Record<string, unknown>[] = [];
  const taskTemplates: [string, string, () => string][] = [
    ['Follow up with {x}', 'company', () => pick(leadIds)],
    ['Send pricing deck to {x}', 'company', () => pick(leadIds)],
    ['Screen {x}', 'candidate', () => pick(cands.filter(x => ['new_applicant', 'screening'].includes(x.status))).id],
    ['Check in on {x} first week', 'placement', () => pick(pls).id],
    ['Collect W-8BEN from {x}', 'placement', () => pick(pls).id],
    ['Chase payment for {x}', 'invoice', () => (pick(invRows.filter(i => i.status === 'overdue' || i.status === 'partially_paid').length ? invRows.filter(i => i.status === 'overdue' || i.status === 'partially_paid') : invRows).id as string)],
    ['Quarterly review with {x}', 'company', () => pick(clientIds).id],
  ];
  for (let i = 0; i < cfg.nTasks; i++) {
    const [tpl, type, idf] = taskTemplates[i % taskTemplates.length];
    const relId = idf();
    const label = type === 'company' ? (companies.find(x => x.id === relId)?.name as string) : type === 'candidate' ? cands.find(x => x.id === relId)!.first + ' ' + cands.find(x => x.id === relId)!.last : type === 'placement' ? (() => { const p = pls.find(x => x.id === relId)!; return `${p.candidate.first} ${p.candidate.last}`; })() : (invRows.find(x => x.id === relId)?.number as string);
    const id = uid();
    const due = addDays(TODAY, int(-6, 14));
    const status = due < TODAY && chance(0.5) ? 'done' : pick(['open', 'open', 'in_progress']);
    const assignee = type === 'candidate' && recruiters.length ? pick(recruiters).id : type === 'invoice' ? (byRole('finance')[0]?.id ?? ownerId) : type === 'placement' ? pick(ams).id : sales.id;
    taskRows.push({ id, organization_id: orgId, title: tpl.replace('{x}', label), status, priority: pick(['low', 'medium', 'medium', 'high', 'urgent']), due_date: due, due_time: chance(0.4) ? `${int(9, 16)}:00` : null, related_type: type, related_id: relId, completed_at: status === 'done' ? daysAgoTs(int(0, 5)) : null, created_by: ownerId, created_at: daysAgoTs(int(5, 20)) });
    taskAssign.push({ task_id: id, user_id: assignee });
    if (i % 6 === 0) taskAssign.push({ task_id: id, user_id: ownerId === assignee ? sales.id : ownerId });
  }
  await insert('tasks', taskRows);
  await c.query(`INSERT INTO task_assignees (task_id, user_id) SELECT DISTINCT * FROM unnest($1::uuid[], $2::uuid[])`, [taskAssign.map(t => t.task_id), taskAssign.map(t => t.user_id)]);

  // ── activities ──
  const actv: Record<string, unknown>[] = [];
  for (const co of companies) {
    actv.push({ organization_id: orgId, entity_type: 'company', entity_id: co.id, kind: 'system', title: co.stage === 'client' || co.stage === 'inactive' ? 'Company created as lead' : 'Lead created', actor_id: co.created_by, created_at: co.created_at });
    const n = int(1, 4);
    for (let k = 0; k < n; k++) actv.push({ organization_id: orgId, entity_type: 'company', entity_id: co.id, kind: pick(['call', 'email', 'meeting', 'note']), title: pick(['Discovery call', 'Sent intro email', 'Pricing discussion', 'Follow-up call', 'Intro meeting']), body: pick(['Discussed front-desk coverage needs and budget.', 'They want 2 VAs starting next month.', 'Decision maker is the practice owner.', 'Asked for references from similar businesses.']), actor_id: sales.id, created_at: daysAgoTs(int(1, 150)) });
    if (co.lead_status === 'converted') actv.push({ organization_id: orgId, entity_type: 'company', entity_id: co.id, kind: 'status_change', title: 'Lead converted to client', meta: JSON.stringify({ from: 'qualified', to: 'client' }), actor_id: sales.id, created_at: co.converted_at });
  }
  for (const cd of cands) {
    actv.push({ organization_id: orgId, entity_type: 'candidate', entity_id: cd.id, kind: 'system', title: 'Application received', actor_id: null, created_at: candRows.find(r => r.id === cd.id)!.created_at });
    if (cd.status !== 'new_applicant') actv.push({ organization_id: orgId, entity_type: 'candidate', entity_id: cd.id, kind: 'status_change', title: `Status changed to ${cd.status.replace('_', ' ')}`, meta: JSON.stringify({ to: cd.status }), actor_id: cd.recruiter, created_at: candRows.find(r => r.id === cd.id)!.updated_at });
  }
  for (const p of pls) {
    actv.push({ organization_id: orgId, entity_type: 'placement', entity_id: p.id, kind: 'system', title: 'Placement created', actor_id: p.am, created_at: ts(addDays(p.start, -10), 14) });
    if (p.status !== 'onboarding') actv.push({ organization_id: orgId, entity_type: 'placement', entity_id: p.id, kind: 'status_change', title: 'Worker activated — placement started', actor_id: p.am, created_at: ts(p.start, 8) });
    if (p.rates.length > 1) actv.push({ organization_id: orgId, entity_type: 'placement', entity_id: p.id, kind: 'system', title: `Rate change effective ${p.rates[1].effectiveFrom}`, actor_id: p.am, created_at: ts(addDays(p.rates[1].effectiveFrom, -5), 15) });
  }
  for (const inv of invRows) {
    actv.push({ organization_id: orgId, entity_type: 'invoice', entity_id: inv.id, kind: 'system', title: `Invoice ${inv.number} sent`, actor_id: inv.created_by, created_at: inv.sent_at });
    if (inv.paid_at) actv.push({ organization_id: orgId, entity_type: 'invoice', entity_id: inv.id, kind: 'system', title: `Payment received`, actor_id: null, created_at: inv.paid_at });
  }
  await insert('activities', actv);

  // ── notifications, messages, misc ──
  const notifRows: Record<string, unknown>[] = [];
  const notifTemplates: [string, string, string][] = [
    ['application.new', 'New application', '/recruiting/candidates'],
    ['task.overdue', 'Task overdue', '/crm/tasks'],
    ['timesheet.submitted', 'Timesheet submitted', '/time/timesheets'],
    ['invoice.paid', 'Invoice paid', '/finance/invoices'],
    ['attendance.late', 'Worker late', '/time/attendance'],
    ['document.expiring', 'Document expiring soon', '/documents/compliance'],
    ['payout.failed', 'Payout failed', '/finance/payouts'],
    ['interview.upcoming', 'Interview tomorrow', '/recruiting/interviews'],
  ];
  for (const st of Object.values(staff)) for (let k = 0; k < 8; k++) {
    const [ev, title, link] = notifTemplates[(k + st.name.length) % notifTemplates.length];
    notifRows.push({ organization_id: orgId, user_id: st.id, event: ev, title, body: pick([`${pick(cands).first} ${pick(cands).last}`, pick(clientIds).name, `INV-${int(1001, invSeq - 1)}`]), link, read_at: k > 2 ? daysAgoTs(int(0, 5)) : null, created_at: daysAgoTs(int(0, 6)) });
  }
  await insert('notifications', notifRows);

  const threads: Record<string, unknown>[] = [];
  const msgs: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  const staffList = Object.values(staff);
  const threadDefs = [
    { subject: 'Coverage plan for next week', kind: 'internal', people: staffList.slice(0, 3).map(s => s.id), lines: ['Can someone cover Pinecrest on Friday?', 'I can ask one of the bench VAs.', 'Great, thanks — I will update the client.'] },
    { subject: 'Q4 hiring targets', kind: 'internal', people: staffList.slice(0, 4).map(s => s.id), lines: ['We need 10 new placements by end of quarter.', 'Pipeline looks good for dental.', 'Real estate is slower; I will push outreach.'] },
  ];
  for (const t of threadDefs) {
    const id = uid();
    threads.push({ id, organization_id: orgId, subject: t.subject, kind: t.kind, created_by: t.people[0], last_message_at: daysAgoTs(1), created_at: daysAgoTs(3) });
    t.people.forEach(p => parts.push({ thread_id: id, user_id: p }));
    t.lines.forEach((l, k) => msgs.push({ organization_id: orgId, thread_id: id, author_id: t.people[k % t.people.length], body: l, created_at: daysAgoTs(3 - k) }));
  }
  await insert('message_threads', threads);
  await insert('thread_participants', parts);
  await insert('messages', msgs);

  // issues, manual time, time off pending
  const activePls = pls.filter(p => p.status === 'active');
  await insert('issues', activePls.slice(2, 6).map((p, k) => ({ organization_id: orgId, placement_id: p.id, worker_id: p.workerId, kind: ['attendance', 'performance', 'client_complaint', 'other'][k], severity: ['medium', 'high', 'medium', 'low'][k], title: ['Repeated late clock-ins', 'Missed callback SLA', 'Client asked for faster replies', 'Internet outage last Tuesday'][k], description: 'Logged by account manager after weekly check-in.', status: k === 3 ? 'resolved' : 'open', created_by: p.am, created_at: daysAgoTs(int(2, 20)) })));
  await insert('manual_time_requests', activePls.slice(0, 4).map((p, k) => ({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, work_date: addDays(TODAY, -int(1, 6)), start_time: '17:00', end_time: k % 2 ? '18:30' : '18:00', reason: pick(['Stayed late to finish month-end report', 'Forgot to clock in after lunch', 'Client asked for extra coverage']), status: k < 3 ? 'pending' : 'approved', decided_by: k < 3 ? null : p.am, created_at: daysAgoTs(int(0, 4)) })));
  await insert('time_off_requests', activePls.slice(5, 8).map(p => ({ organization_id: orgId, worker_id: p.workerId, placement_id: p.id, kind: pick(['vacation', 'sick', 'personal']), start_date: addDays(TODAY, int(5, 20)), end_date: addDays(TODAY, int(21, 25)), note: 'Requesting leave — will hand over tasks beforehand.', status: 'pending' })));

  // automation run history
  const autos = (await c.query(`SELECT id, name FROM automations WHERE organization_id=$1`, [orgId])).rows;
  const runRows: Record<string, unknown>[] = [];
  for (const a of autos) for (let k = 0; k < int(3, 8); k++) runRows.push({ organization_id: orgId, automation_id: a.id, status: k === 0 && a.name.startsWith('Invoice') ? 'failed' : 'succeeded', trigger_payload: JSON.stringify({ seeded: true }), result: JSON.stringify(k === 0 && a.name.startsWith('Invoice') ? { error: 'Client contact has no email address' } : { actions: 2, ok: true }), dedupe_key: `seed-${k}`, created_at: daysAgoTs(int(0, 30)) });
  await insert('automation_runs', runRows);

  // webhooks (local receiver)
  const whId = uid();
  await insert('webhook_endpoints', [{ id: whId, organization_id: orgId, url: `http://localhost:4100/api/v1/dev/webhook-receiver/${cfg.slug}`, secret: `whsec_${token(18)}`, events: ['candidate.created', 'placement.started', 'timesheet.approved', 'invoice.paid', 'worker.terminated'], description: 'Local demo receiver' }]);

  // reports, custom fields
  await insert('report_definitions', [
    { organization_id: orgId, name: 'Revenue by client (last 6 months)', entity: 'invoices', fields: ['company', 'total'], group_by: 'company', metric: 'sum:total_cents', chart: 'bar', created_by: ownerId },
    { organization_id: orgId, name: 'Candidates by source', entity: 'candidates', fields: ['source'], group_by: 'source', metric: 'count', chart: 'bar', created_by: ownerId },
    { organization_id: orgId, name: 'Hours by worker this month', entity: 'time_entries', fields: ['worker', 'hours'], group_by: 'worker', metric: 'sum:minutes', chart: 'table', created_by: ownerId },
  ]);
  await insert('custom_field_definitions', [
    { organization_id: orgId, entity: 'candidate', key: 'shift_preference', label: 'Shift preference', type: 'select', options: ['Day (US)', 'Night (US)', 'Flexible'] },
    { organization_id: orgId, entity: 'company', key: 'contract_tier', label: 'Contract tier', type: 'select', options: ['Bronze', 'Silver', 'Gold'] },
  ]);

  // audit log samples
  const audit: Record<string, unknown>[] = [];
  for (const r of rateRows.filter(r => r.reason !== 'Initial rate')) audit.push({ organization_id: orgId, actor_id: r.created_by, actor_label: staffName(r.created_by as string), action: 'rate.created', entity_type: 'placement', entity_id: r.placement_id, after: JSON.stringify({ effective_from: r.effective_from, pay_rate_cents: r.pay_rate_cents, bill_rate_cents: r.bill_rate_cents }), ip: '127.0.0.1', created_at: r.created_at });
  for (const p of pls.filter(p => p.status !== 'onboarding')) audit.push({ organization_id: orgId, actor_id: p.am, actor_label: staffName(p.am), action: 'placement.activated', entity_type: 'placement', entity_id: p.id, entity_label: `${p.candidate.first} ${p.candidate.last}`, ip: '127.0.0.1', created_at: ts(p.start, 8) });
  await insert('audit_events', audit.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));

  return { orgId, roleIds, staff, clientIds, pls, cands, positions, primaryContact, recruiters };
}

// helpers that need module scope
const later: Record<string, Record<string, unknown>[]> = {};
const laterUpdates: [string, string][] = [];
async function insertLater(table: string, row: Record<string, unknown>) { (later[table] ??= []).push(row); }
async function flushLater() { for (const [t, rows] of Object.entries(later)) { await insert(t, rows); delete later[t]; } }
let insertedUsers = 0;
async function insertUsersSoFar() { const rows = userRows.slice(insertedUsers); insertedUsers = userRows.length; await insert('users', rows); }
const MOCK_FILE_COUNT = 24;
function writeDoc(content: string) {
  const rel = `uploads/seed/${uid()}.txt`;
  fs.mkdirSync(path.join(STORAGE_DIR, 'uploads/seed'), { recursive: true });
  fs.writeFileSync(path.join(STORAGE_DIR, rel), content);
  return rel;
}

// ── main ───────────────────────────────────────────────────────────
const pool = createPool(2);
c = await pool.connect();
const t0 = Date.now();
try {
  await c.query('BEGIN');
  fs.mkdirSync(path.join(STORAGE_DIR, 'mock'), { recursive: true });
  for (let i = 0; i < MOCK_FILE_COUNT; i++) fs.writeFileSync(path.join(STORAGE_DIR, `mock/mock-${i}.svg`), mockDesktopSvg(1000 + i * 7919, i % MOCK_APPS.length, { clock: `${9 + (i % 8)}:${String((i * 7) % 60).padStart(2, '0')}` }).svg);
  fs.mkdirSync(path.join(STORAGE_DIR, 'uploads/seed'), { recursive: true });

  await insert('plans', [
    { key: 'trial', name: 'Trial', price_per_seat_cents: 2900, trial_days: 14, features: JSON.stringify({ white_label: false }) },
    { key: 'standard', name: 'Standard', price_per_seat_cents: 2900, trial_days: 0, features: JSON.stringify({ white_label: false }) },
    { key: 'white_label', name: 'White Label', price_per_seat_cents: 2900, trial_days: 0, features: JSON.stringify({ white_label: true, addon_monthly_cents: 49900 }) },
  ]);

  const maga = await seedAgency({
    name: 'MAGA Hire', slug: 'maga-hire', primary: '#345CFF', accent: '#7044FF', logoText: 'MAGA Hire', plan: 'standard', comped: true, status: 'active',
    staff: [
      { email: 'owner@veyro.demo', name: 'Ava Stern', role: 'owner' },
      { email: 'recruiter@veyro.demo', name: 'Noah Kim', role: 'recruiter', scope: 'assigned', team: 'Dental & Medical' },
      { email: 'sales@veyro.demo', name: 'Lena Ortiz', role: 'sales' },
      { email: 'finance@veyro.demo', name: 'Mark Chen', role: 'finance' },
      { email: 'am@veyro.demo', name: 'Priya Shah', role: 'account_manager' },
      { email: 'sam.rivera@veyro.demo', name: 'Sam Rivera', role: 'admin' },
      { email: 'elena.petrova@veyro.demo', name: 'Elena Petrova', role: 'recruiter', scope: 'all', team: 'Finance & Legal' },
      { email: 'omar.haddad@veyro.demo', name: 'Omar Haddad', role: 'recruiter', scope: 'team', team: 'Dental & Medical' },
      { email: 'grace.liu@veyro.demo', name: 'Grace Liu', role: 'hr' },
      { email: 'tom.becker@veyro.demo', name: 'Tom Becker', role: 'management' },
      { email: 'jade.morgan@veyro.demo', name: 'Jade Morgan', role: 'support' },
      { email: 'ben.carter@veyro.demo', name: 'Ben Carter', role: 'account_manager' },
    ],
    clients: CLIENTS, leads: LEADS.slice(0, 32),
    nCandidates: 150, nPlacements: { active: 22, onboarding: 4, on_leave: 2, ended: 2 },
    nContacts: 35, nOpps: 20, nPositions: 25, nInterviews: 30, nOffers: 10, nTasks: 45, special: true,
    countries: ['PH', 'PH', 'PH', 'MX', 'CO', 'ZA', 'AR', 'KE', 'PH', 'PE'],
  });

  // demo portal identities for MAGA Hire
  const brightline = maga.clientIds[0];
  const dana = maga.primaryContact[brightline.id];
  const danaUser = user('client@veyro.demo', 'Dana Fox');
  const jose = maga.pls.find(p => p.candidate.email === 'worker@veyro.demo')!;
  const joseUser = user('worker@veyro.demo', 'Jose Ramirez');
  const maria = maga.cands.find(cd => cd.email === 'candidate@veyro.demo')!;
  const mariaUser = user('candidate@veyro.demo', 'Maria Santos');
  const platformUser = user('platform@veyro.demo', 'Veyro Platform Admin');
  await insertUsersSoFar();
  await insert('organization_memberships', [
    { organization_id: maga.orgId, user_id: danaUser.id, role_id: maga.roleIds.client_owner, company_id: brightline.id },
    { organization_id: maga.orgId, user_id: joseUser.id, role_id: maga.roleIds.worker, worker_id: jose.workerId },
    { organization_id: maga.orgId, user_id: mariaUser.id, role_id: maga.roleIds.candidate, candidate_id: maria.id },
  ]);
  await c.query(`UPDATE workers SET user_id=$1 WHERE id=$2`, [joseUser.id, jose.workerId]);
  await c.query(`UPDATE candidates SET user_id=$1 WHERE id IN ($2,$3)`, [joseUser.id, jose.candidate.id, null]);
  await c.query(`UPDATE candidates SET user_id=$1 WHERE id=$2`, [mariaUser.id, maria.id]);
  await c.query(`UPDATE timesheets SET client_approved_by=$1 WHERE company_id=$2 AND client_approved_at IS NOT NULL`, [danaUser.id, brightline.id]);
  await insert('platform_admins', [{ user_id: platformUser.id, status: 'active' }]);
  void dana;

  // Noah's recruiter link token is stable for the demo
  const noah = users.get('recruiter@veyro.demo')!;
  await c.query(`UPDATE sourcing_links SET token='noah-kim' WHERE user_id=$1 AND position_id IS NULL`, [noah.id]);

  const harbor = await seedAgency({
    name: 'Harbor Assist', slug: 'harbor-assist', primary: '#0F9D8A', accent: '#F59E0B', logoText: 'Harbor Assist', plan: 'trial', comped: false, status: 'trialing',
    staff: [
      { email: 'owner@veyro.demo', name: 'Ava Stern', role: 'owner' },
      { email: 'rosa.delgado@veyro.demo', name: 'Rosa Delgado', role: 'recruiter', scope: 'all' },
      { email: 'kwame.mensah@veyro.demo', name: 'Kwame Mensah', role: 'finance' },
      { email: 'iris.novak@veyro.demo', name: 'Iris Novak', role: 'account_manager' },
    ],
    clients: [
      { name: 'Tidewater Veterinary Clinic', domain: 'tidewatervet.example', industry: 'dental', size: '11-50', city: 'Norfolk, VA', area: '757', tz: 'America/New_York' },
      { name: 'Keystone Mortgage Group', domain: 'keystonemortgage.example', industry: 'insurance', size: '51-200', city: 'Pittsburgh, PA', area: '412', tz: 'America/New_York' },
      { name: 'Driftwood Outfitters', domain: 'driftwoodoutfitters.example', industry: 'ecommerce', size: '11-50', city: 'Boise, ID', area: '208', tz: 'America/Boise' },
    ] as typeof CLIENTS,
    leads: LEADS.slice(32, 38),
    nCandidates: 14, nPlacements: { active: 3, onboarding: 1, on_leave: 0, ended: 0 },
    nContacts: 8, nOpps: 4, nPositions: 4, nInterviews: 4, nOffers: 2, nTasks: 8,
    countries: ['ZA', 'KE', 'PH'],
  });
  void harbor;

  await insert('support_tickets', [
    { organization_id: maga.orgId, subject: 'How do I change the invoice numbering prefix?', body: 'We want INV-MH- instead of INV-.', status: 'open', priority: 'normal', created_by: users.get('finance@veyro.demo')!.id },
    { organization_id: harbor.orgId, subject: 'Trial extension request', body: 'Can we get 7 more days to evaluate payroll?', status: 'pending', priority: 'high', created_by: users.get('owner@veyro.demo')!.id },
    { organization_id: maga.orgId, subject: 'Screenshot blur question', body: 'Does blur apply to client view as well?', status: 'resolved', priority: 'low', created_by: users.get('am@veyro.demo')!.id },
  ]);
  await insert('saas_invoices', [5, 4, 3, 2, 1].flatMap(mb => {
    const ms = monthStart(addMonths(TODAY, -mb));
    return [
      { organization_id: maga.orgId, number: `VEY-${ms.slice(0, 7).replace('-', '')}-001`, period_start: ms, period_end: monthEnd(ms), seat_days: 26 * 30, avg_seats: 26, subtotal_cents: 26 * 2900, discount_cents: 26 * 2900, tax_cents: 0, total_cents: 0, status: 'comped', created_at: ts(addDays(monthEnd(ms), 1)) },
    ];
  }));
  // Ava lands on MAGA Hire by default; Harbor Assist is her second workspace.
  await c.query(`UPDATE organization_memberships SET created_at = now() WHERE organization_id=$1`, [harbor.orgId]);
  // Area seeds (packages/db/seed/areas/*.ts): each exports default async (client) => void and must be idempotent.
  const areaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'areas');
  for (const f of fs.existsSync(areaDir) ? fs.readdirSync(areaDir).filter(f => f.endsWith('.ts')).sort() : []) {
    const mod = await import(path.join(areaDir, f));
    await mod.default(c);
    console.log('area seed', f);
  }
  await c.query('COMMIT');
  const counts = (await c.query(`SELECT (SELECT count(*) FROM candidates) cand, (SELECT count(*) FROM placements) pl, (SELECT count(*) FROM time_entries) te, (SELECT count(*) FROM invoices) inv, (SELECT count(*) FROM payroll_runs) pr, (SELECT count(*) FROM screenshots) shots, (SELECT count(*) FROM companies) co`)).rows[0];
  console.log('seeded in', ((Date.now() - t0) / 1000).toFixed(1) + 's', counts);
} catch (e) {
  await c.query('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
