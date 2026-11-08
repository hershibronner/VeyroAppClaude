// AIAdapter — deterministic local implementation ("veyro-local-v1"), with Claude (./claude.ts) used first when configured.
// Rule/keyword based. It only ever outputs facts found in the source text and returns the
// source snippet for every extracted field. Uncertain fields are flagged. Nothing is ever sent automatically.
import zlib from 'node:zlib';
import { one, q } from '../core/db';
import { HttpError } from '../core/errors';
import { getSetting } from '../core/settings';
import { formatMoney } from '@veyro/shared';
import { claudeAnalyzeResume, claudeConfigured, claudeErrorMessage, claudeRankMatches, CLAUDE_MODEL, type ClaudeMatchInput } from './claude';

export const AI_MODEL = 'veyro-local-v1';

/** Throws a friendly 503 when AI is disabled, simulated-failing, or the integration is not connected. */
export async function assertAiAvailable(orgId: string, feature: string) {
  const s = await getSetting<{ enabled?: boolean; simulate_failure?: boolean }>(orgId, 'ai');
  const integ = await one<any>(`SELECT status FROM integrations WHERE organization_id=$1 AND key='ai'`, [orgId]);
  let reason: string | null = null;
  if (s.enabled === false) reason = 'AI features are turned off in Settings → AI.';
  else if (s.simulate_failure) reason = 'AI provider unavailable — try again or fill fields manually.';
  else if (integ && integ.status !== 'connected') reason = `AI provider is ${integ.status} — reconnect it in Settings → Integrations, or fill fields manually.`;
  if (reason) {
    await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'ai','error',$2,$3)`, [orgId, `${feature} failed: ${reason}`, JSON.stringify({ feature })]).catch(() => {});
    await q(`UPDATE integrations SET last_error=$2, updated_at=now() WHERE organization_id=$1 AND key='ai'`, [orgId, reason]).catch(() => {});
    throw new HttpError(503, reason, { retryable: true, feature });
  }
}
export async function logAi(orgId: string, feature: string, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'ai','info',$2,$3)`, [orgId, `${feature} completed (${(meta.model as string) ?? AI_MODEL})`, JSON.stringify(meta)]).catch(() => {});
  await q(`UPDATE integrations SET last_sync_at=now() WHERE organization_id=$1 AND key='ai'`, [orgId]).catch(() => {});
}

/* ───────────── Vocabulary (used only to recognise terms that literally appear in the text) ───────────── */
export const SKILL_VOCAB = ['Patient Scheduling', 'Insurance Verification', 'Patient Intake', 'Customer Service', 'Medical Billing', 'HIPAA Compliance', 'Transaction Coordination', 'Lead Generation', 'CRM Management', 'Cold Calling', 'Listing Management', 'Calendar Management', 'Policy Servicing', 'Quoting', 'Claims Processing', 'Renewals', 'Data Entry', 'Customer Support', 'Order Processing', 'Product Listing', 'Inventory Management', 'Live Chat', 'Returns Handling', 'Legal Research', 'Document Preparation', 'Case Management', 'Client Intake', 'Bookkeeping', 'Social Media Management', 'Content Writing', 'SEO', 'Email Marketing', 'Graphic Design', 'Copywriting', 'Accounts Payable', 'Accounts Receivable', 'Payroll', 'Bank Reconciliation', 'Project Management', 'Executive Assistance', 'Email Management', 'Appointment Setting', 'Telemarketing', 'Technical Support', 'Video Editing', 'Web Research', 'Transcription', 'Recruiting', 'Sales'];
export const SOFTWARE_VOCAB = ['Dentrix', 'Eaglesoft', 'Open Dental', 'Google Workspace', 'Weave', 'Follow Up Boss', 'kvCORE', 'DocuSign', 'Zillow Premier Agent', 'Dotloop', 'Applied Epic', 'HawkSoft', 'EZLynx', 'Excel', 'QuickBooks', 'Shopify', 'Zendesk', 'Gorgias', 'Amazon Seller Central', 'Klaviyo', 'Clio', 'MyCase', 'Microsoft Word', 'Dropbox', 'Canva', 'HubSpot', 'Mailchimp', 'Hootsuite', 'Google Analytics', 'Salesforce', 'Xero', 'Slack', 'Asana', 'Trello', 'Notion', 'Zoom', 'Microsoft Office', 'Photoshop', 'WordPress', 'Freshdesk', 'Intercom', 'Gusto', 'NetSuite', 'Monday.com', 'ClickUp'];
export const LANGUAGE_VOCAB = ['English', 'Spanish', 'Tagalog', 'Filipino', 'Portuguese', 'French', 'German', 'Afrikaans', 'Swahili', 'Zulu', 'Xhosa', 'Hindi', 'Urdu', 'Arabic', 'Mandarin', 'Cebuano', 'Italian'];
export const COUNTRY_ALIASES: Record<string, string> = { ph: 'Philippines', philippines: 'Philippines', filipino: 'Philippines', mx: 'Mexico', mexico: 'Mexico', co: 'Colombia', colombia: 'Colombia', ar: 'Argentina', argentina: 'Argentina', pe: 'Peru', peru: 'Peru', za: 'South Africa', 'south africa': 'South Africa', ke: 'Kenya', kenya: 'Kenya', latam: 'LATAM', 'latin america': 'LATAM', africa: 'AFRICA' };
const LATAM = ['Mexico', 'Colombia', 'Argentina', 'Peru', 'Chile', 'Ecuador', 'Guatemala', 'Costa Rica', 'Dominican Republic', 'Brazil'];
const AFRICA = ['South Africa', 'Kenya', 'Nigeria', 'Ghana', 'Uganda', 'Egypt'];
export function expandCountry(raw: string): string[] { const c = COUNTRY_ALIASES[raw.trim().toLowerCase()] ?? raw.trim(); return c === 'LATAM' ? LATAM : c === 'AFRICA' ? AFRICA : [c]; }

/* ───────────── File → text (best effort) ───────────── */
export function extractTextFromFile(buf: Buffer, filename: string, mime?: string): { text: string; uncertain: boolean; note: string | null } {
  const name = filename.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md') || (mime ?? '').startsWith('text/')) return { text: buf.toString('utf8').replace(/\r\n/g, '\n'), uncertain: false, note: null };
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const text = pdfText(buf);
    if (text.replace(/\s/g, '').length > 40) return { text, uncertain: true, note: 'Text was extracted from the PDF on a best-effort basis — check the fields carefully.' };
    return { text: '', uncertain: true, note: 'Could not read text from this PDF (it may be scanned). The file is attached; please fill the fields manually.' };
  }
  return { text: '', uncertain: true, note: 'This file type cannot be read automatically. The file is attached; please fill the fields manually.' };
}
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const chunks: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const data = Buffer.from(m[1], 'latin1');
    let s: string;
    try { s = zlib.inflateSync(data).toString('latin1'); } catch { s = m[1]; }
    const lines: string[] = [];
    let cur = '';
    const tok = /\((?:\\.|[^\\)])*\)\s*Tj|<[0-9a-fA-F\s]*>\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD|Tm|ET|'/g;
    const str = (x: string) => x.startsWith('<') ? hexStr(x.slice(1, -1)) : unescapePdf(x.slice(1, -1));
    let t: RegExpExecArray | null;
    while ((t = tok.exec(s))) {
      const v = t[0];
      if (v.endsWith('Tj')) cur += str(v.slice(0, v.search(/\s*Tj$/)));
      else if (v.endsWith('TJ')) cur += (v.match(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]+>/g) ?? []).map(str).join('');
      else { if (cur.trim()) lines.push(cur); cur = ''; }
    }
    if (cur.trim()) lines.push(cur);
    if (lines.length) chunks.push(lines.join('\n'));
  }
  return chunks.join('\n').replace(/[^\S\n]+/g, ' ').trim();
}
function hexStr(h: string) { const c = h.replace(/\s/g, ''); const b = Buffer.from(c.length % 2 ? c + '0' : c, 'hex'); const utf16 = b.length >= 2 && b.length % 2 === 0 && b.filter((x, i) => i % 2 === 0 && x === 0).length >= b.length / 4; return utf16 ? b.swap16().toString('utf16le') : b.toString('latin1'); }
function unescapePdf(s: string) { return s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as any)[c]).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))); }

/* ───────────── Analyze Resume ───────────── */
export interface Field<T> { value: T; snippet: string | null; uncertain: boolean; note?: string }
export interface ResumeExtraction {
  model: string;
  fields: {
    first_name: Field<string | null>; last_name: Field<string | null>; email: Field<string | null>; phone: Field<string | null>;
    headline: Field<string | null>; city: Field<string | null>; country: Field<string | null>; years_experience: Field<number | null>;
    summary: Field<string | null>; skills: Field<string[]>; software: Field<string[]>; languages: Field<string[]>;
    education: Field<{ degree: string; school: string | null; year: number | null; evidence: string }[]>;
    experience: Field<{ title: string; company: string | null; start: string | null; end: string | null; evidence: string }[]>;
  };
  sections_found: string[];
  warnings: string[];
}
const SECTION_NAMES: Record<string, string> = { SUMMARY: 'summary', PROFILE: 'summary', OBJECTIVE: 'summary', 'PROFESSIONAL SUMMARY': 'summary', EXPERIENCE: 'experience', 'WORK EXPERIENCE': 'experience', 'EMPLOYMENT HISTORY': 'experience', 'PROFESSIONAL EXPERIENCE': 'experience', EDUCATION: 'education', SKILLS: 'skills', 'KEY SKILLS': 'skills', 'CORE SKILLS': 'skills', SOFTWARE: 'software', TOOLS: 'software', 'SOFTWARE & TOOLS': 'software', 'TOOLS & SOFTWARE': 'software', LANGUAGES: 'languages' };
const empty = <T,>(v: T): Field<T> => ({ value: v, snippet: null, uncertain: false });
const has = (text: string, term: string) => new RegExp(`(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text);
function lineWith(text: string, term: string) { return text.split('\n').find(l => has(l, term))?.trim() ?? null; }
function splitList(s: string) { return s.split(/[,;•|·]|\s-\s/).map(x => x.replace(/\(.*?\)/g, '').trim()).filter(x => x && x.length < 60); }

export function analyzeResume(textIn: string, opts: { fileNote?: string | null; fileUncertain?: boolean } = {}): ResumeExtraction {
  const text = (textIn ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map(l => l.trim());
  const warnings: string[] = [];
  if (opts.fileNote) warnings.push(opts.fileNote);
  const sections: Record<string, string[]> = {};
  const found: string[] = [];
  let cur: string | null = null;
  const header: string[] = [];
  for (const l of lines) {
    const key = l.replace(/[:\s]+$/, '').toUpperCase();
    if (SECTION_NAMES[key] && l.length < 40) { cur = SECTION_NAMES[key]; if (!found.includes(cur)) found.push(cur); sections[cur] = sections[cur] ?? []; continue; }
    if (cur) { if (l) sections[cur].push(l); } else if (l) header.push(l);
  }
  const fu = !!opts.fileUncertain;
  const f: ResumeExtraction['fields'] = {
    first_name: empty(null), last_name: empty(null), email: empty(null), phone: empty(null), headline: empty(null), city: empty(null), country: empty(null),
    years_experience: empty(null), summary: empty(null), skills: empty([]), software: empty([]), languages: empty([]), education: empty([]), experience: empty([]),
  };
  // Name: first header line that looks like a person's name.
  const nameLine = header.find(l => /^[A-Za-zÀ-ÿ'.-]+(\s+[A-Za-zÀ-ÿ'.-]+){1,3}$/.test(l) && !/@/.test(l) && !SECTION_NAMES[l.toUpperCase()]);
  if (nameLine) {
    const parts = nameLine.split(/\s+/);
    f.first_name = { value: parts.length > 2 && /^[a-z]/.test(parts[1]) ? parts[0] : parts.slice(0, parts.length > 2 ? parts.length - 1 : 1).join(' '), snippet: nameLine, uncertain: fu || parts.length > 2 };
    f.last_name = { value: parts.slice(parts.length > 2 ? (f.first_name.value!.split(' ').length) : 1).join(' '), snippet: nameLine, uncertain: fu || parts.length > 2 };
  } else warnings.push('No name line found — please enter the name.');
  const em = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (em) f.email = { value: em[0].toLowerCase(), snippet: lineWith(text, em[0]) ?? em[0], uncertain: false };
  const ph = text.match(/(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/);
  if (ph) f.phone = { value: ph[0].replace(/[^\d+\s]/g, ' ').replace(/\s+/g, ' ').trim(), snippet: lineWith(text, ph[0]) ?? ph[0], uncertain: !ph[0].startsWith('+') };
  // Headline + location: "Role · City, Country" line right after the name.
  const hl = header.find(l => l !== nameLine && /[·|]|\s[-–]\s/.test(l) && !/@/.test(l)) ?? header.find(l => l !== nameLine && !/@|\d{3}/.test(l));
  if (hl) {
    const [role, loc] = hl.split(/\s*[·|]\s*|\s+[-–]\s+/);
    if (role) f.headline = { value: role.trim(), snippet: hl, uncertain: fu || !loc };
    if (loc) {
      const lp = loc.split(',').map(s => s.trim());
      if (lp.length >= 2) { f.city = { value: lp[0], snippet: hl, uncertain: fu }; f.country = { value: lp[lp.length - 1], snippet: hl, uncertain: fu }; }
      else f.country = { value: lp[0], snippet: hl, uncertain: true };
    }
  }
  if (!f.country.value) {
    const c = Object.entries(COUNTRY_ALIASES).find(([k, v]) => k.length > 3 && v.length > 5 && has(text, v));
    if (c) f.country = { value: c[1], snippet: lineWith(text, c[1]), uncertain: true, note: 'Country inferred from a mention in the text.' };
  }
  const summary = (sections.summary ?? []).join(' ');
  if (summary) f.summary = { value: summary, snippet: summary.slice(0, 240), uncertain: false };
  const yrs = (summary || text).match(/(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience|exp)/i);
  if (yrs) f.years_experience = { value: Number(yrs[1]), snippet: lineWith(text, yrs[0]) ?? yrs[0], uncertain: false };
  // Experience lines: "Title — Company (2019–Present)"
  const expLines = sections.experience ?? [];
  const exps: ResumeExtraction['fields']['experience']['value'] = [];
  for (const l of expLines) {
    if (/^[-•*]/.test(l)) continue;
    const m = l.match(/^(.+?)\s+[—–-]\s+(.+?)(?:\s*\((\d{4})\s*[–-]\s*(\d{4}|Present|Current)\))?$/i);
    if (m) exps.push({ title: m[1].trim(), company: m[2].trim(), start: m[3] ?? null, end: m[4] ?? null, evidence: l });
  }
  if (exps.length) f.experience = { value: exps, snippet: exps.map(e => e.evidence).join('\n'), uncertain: fu || exps.some(e => !e.start) };
  if (!f.years_experience.value && exps.some(e => e.start)) {
    const start = Math.min(...exps.filter(e => e.start).map(e => Number(e.start)));
    const yrsCalc = new Date().getFullYear() - start;
    if (yrsCalc > 0 && yrsCalc < 50) f.years_experience = { value: yrsCalc, snippet: exps.find(e => Number(e.start) === start)!.evidence, uncertain: true, note: 'Calculated from the earliest job start year — no explicit "years of experience" statement found.' };
  }
  // Education
  const edu: ResumeExtraction['fields']['education']['value'] = [];
  for (const l of sections.education ?? []) {
    const m = l.match(/^(.+?)\s+[—–-]\s+(.+?)(?:,\s*(\d{4}))?$/);
    if (m) edu.push({ degree: m[1].trim(), school: m[2].trim(), year: m[3] ? Number(m[3]) : null, evidence: l });
    else if (l.length > 4) edu.push({ degree: l, school: null, year: null, evidence: l });
  }
  if (edu.length) f.education = { value: edu, snippet: edu.map(e => e.evidence).join('\n'), uncertain: fu || edu.some(e => !e.school) };
  else warnings.push('No education section found. Education was left empty (never guessed).');
  // Skills / software / languages: explicit sections first, else vocabulary terms literally present in the text.
  const listField = (key: 'skills' | 'software' | 'languages', vocab: string[]): Field<string[]> => {
    const sec = sections[key];
    if (sec?.length) { const vals = [...new Set(splitList(sec.join(', ')))]; return { value: vals, snippet: sec.join(' '), uncertain: fu }; }
    const hits = vocab.filter(v => has(text, v));
    if (hits.length) return { value: hits, snippet: hits.map(h => lineWith(text, h)).filter(Boolean).slice(0, 3).join(' … '), uncertain: true, note: `No ${key} section — found these terms mentioned in the text.` };
    return empty([]);
  };
  f.skills = listField('skills', SKILL_VOCAB);
  f.software = listField('software', SOFTWARE_VOCAB);
  f.languages = listField('languages', LANGUAGE_VOCAB);
  if (!text.trim()) warnings.push('No readable text — nothing was extracted.');
  return { model: AI_MODEL, fields: f, sections_found: found, warnings };
}

/* ───────────── Find Best Matches ───────────── */
export interface MatchPosition { title: string; skills: string[]; software: string[]; languages: string[]; timezone: string | null; weekly_hours: number | null; pay_min_cents: number | null; pay_max_cents: number | null; bill_budget_cents: number | null; currency: string; schedule?: string | null }
export interface MatchCandidate { id: string; skills: string[]; software: string[]; languages: string[]; years_experience: number | null; timezone: string | null; availability_status: string; earliest_start: string | null; weekly_hours: number | null; rate_min_cents: number | null; rate_target_cents: number | null; rate_currency: string; headline: string | null; tags: string[]; preferred_hours: string | null }
export interface MatchScore { score: number; breakdown: Record<string, { score: number; max: number; detail: string }>; reasons: string[]; missing: string[] }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function overlap(req: string[], have: string[]) { const h = new Set(have.map(norm)); return { hit: req.filter(r => h.has(norm(r))), miss: req.filter(r => !h.has(norm(r))) }; }
function tzOffsetHours(tz: string | null): number | null {
  if (!tz) return null;
  try {
    const d = new Date();
    const s = d.toLocaleString('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [md, hm] = s.split(', ');
    const [mo, da, yr] = md.split('/').map(Number);
    const [h, mi] = hm.split(':').map(Number);
    return Math.round(((Date.UTC(yr, mo - 1, da, h % 24, mi) - d.getTime()) / 3600000) * 2) / 2;
  } catch { return null; }
}
/** Weights: skills 35, software 15, experience 15, timezone 10, availability 10, language 5, pay vs budget 10. */
export function scoreMatch(p: MatchPosition, c: MatchCandidate): MatchScore {
  const breakdown: MatchScore['breakdown'] = {};
  const reasons: string[] = []; const missing: string[] = [];
  const sk = overlap(p.skills, c.skills);
  const skScore = p.skills.length ? Math.round((sk.hit.length / p.skills.length) * 35) : 20;
  breakdown.skills = { score: skScore, max: 35, detail: p.skills.length ? `${sk.hit.length}/${p.skills.length} required skills` : 'Position lists no skills' };
  if (sk.hit.length) reasons.push(`Has ${sk.hit.join(', ')}`);
  if (sk.miss.length) missing.push(`Skills not on profile: ${sk.miss.join(', ')}`);
  const sw = overlap(p.software, c.software);
  const swScore = p.software.length ? Math.round((sw.hit.length / p.software.length) * 15) : 10;
  breakdown.software = { score: swScore, max: 15, detail: p.software.length ? `${sw.hit.length}/${p.software.length} tools` : 'Position lists no software' };
  if (sw.hit.length) reasons.push(`Uses ${sw.hit.join(', ')}`);
  if (sw.miss.length) missing.push(`Software not on profile: ${sw.miss.join(', ')}`);
  const yrs = c.years_experience ?? 0;
  const exScore = c.years_experience === null ? 0 : Math.min(15, Math.round((Math.min(yrs, 6) / 6) * 15));
  breakdown.experience = { score: exScore, max: 15, detail: c.years_experience === null ? 'Years of experience unknown' : `${yrs} year${yrs === 1 ? '' : 's'}` };
  if (yrs >= 3) reasons.push(`${yrs} years of experience`); else if (c.years_experience === null) missing.push('Years of experience not recorded'); else missing.push(`Only ${yrs} year${yrs === 1 ? '' : 's'} of experience`);
  // Timezone: share of a 9–17 shift in the position's timezone that falls in the candidate's 07:00–23:00 local window.
  const po = tzOffsetHours(p.timezone ?? 'America/New_York'), co = tzOffsetHours(c.timezone);
  const nightOk = (c.tags ?? []).some(t => /night/i.test(t)) || /(us|eastern|pacific|central|night|flexible)/i.test(c.preferred_hours ?? '');
  let tzScore = 5, tzDetail = 'Candidate timezone unknown';
  if (po !== null && co !== null) {
    let inWindow = 0;
    for (let h = 9; h < 17; h++) { const local = (((h - po + co) % 24) + 24) % 24; if (local >= 7 && local < 23) inWindow++; }
    const share = inWindow / 8;
    tzScore = nightOk ? 10 : Math.round(share * 10);
    const diff = co - po;
    tzDetail = `${diff >= 0 ? '+' : ''}${diff}h vs position; ${Math.round(share * 100)}% of shift in daytime hours${nightOk ? ' (open to US hours)' : ''}`;
    if (tzScore >= 8) reasons.push(nightOk && share < 1 ? 'Open to working US hours' : 'Good timezone overlap'); else missing.push(`Shift falls outside candidate's daytime hours (${tzDetail})`);
  } else missing.push('Candidate timezone not recorded');
  breakdown.timezone = { score: tzScore, max: 10, detail: tzDetail };
  const avail = c.availability_status === 'available' ? 10 : c.availability_status === 'employed' ? 5 : 0;
  breakdown.availability = { score: avail, max: 10, detail: `${c.availability_status.replace('_', ' ')}${c.earliest_start ? `, can start ${c.earliest_start}` : ''}` };
  if (avail === 10) reasons.push('Available now'); else missing.push(c.availability_status === 'employed' ? 'Currently employed (may need notice)' : 'Not currently available');
  const lg = overlap(p.languages.length ? p.languages : ['English'], c.languages);
  const lgScore = Math.round((lg.hit.length / Math.max(1, lg.hit.length + lg.miss.length)) * 5);
  breakdown.language = { score: lgScore, max: 5, detail: `${lg.hit.length}/${lg.hit.length + lg.miss.length} languages` };
  if (lg.miss.length) missing.push(`Language not on profile: ${lg.miss.join(', ')}`);
  else if (c.languages.length > 1) reasons.push(`Speaks ${c.languages.join(', ')}`);
  let payScore = 5, payDetail = 'No rate expectation recorded';
  const ceiling = p.pay_max_cents ?? (p.bill_budget_cents ? Math.round(p.bill_budget_cents / 2) : null);
  if (c.rate_min_cents !== null && ceiling) {
    if (c.rate_currency !== p.currency) { payScore = 4; payDetail = `Expectation in ${c.rate_currency}, position in ${p.currency}`; }
    else if (c.rate_min_cents <= ceiling) { payScore = (c.rate_target_cents ?? c.rate_min_cents) <= ceiling ? 10 : 7; payDetail = 'Expectation fits the target range'; reasons.push('Rate expectation fits the budget'); }
    else { payScore = 0; payDetail = 'Minimum expectation is above the target range'; missing.push('Rate expectation is above the budget'); }
  } else if (!ceiling) payDetail = 'Position has no pay range';
  breakdown.pay = { score: payScore, max: 10, detail: payDetail };
  const score = Math.max(0, Math.min(100, Object.values(breakdown).reduce((a, b) => a + b.score, 0)));
  return { score, breakdown, reasons, missing };
}

/* ───────────── Natural-language search → filters ───────────── */
export interface ParsedSearch { filters: { skills: string[]; software: string[]; languages: string[]; countries: string[]; max_rate_cents: number | null; min_years: number | null; available: boolean | null; bilingual: boolean; keywords: string[]; status: string | null }; chips: string[] }
const ROLE_SKILL: Record<string, string> = { bookkeeper: 'Bookkeeping', bookkeeping: 'Bookkeeping', paralegal: 'Legal Research', 'legal assistant': 'Document Preparation', 'customer support': 'Customer Support', 'customer service': 'Customer Service', 'social media': 'Social Media Management', 'content writer': 'Content Writing', copywriter: 'Copywriting', 'transaction coordinator': 'Transaction Coordination', 'cold caller': 'Cold Calling', 'data entry': 'Data Entry', 'insurance verification': 'Insurance Verification', scheduler: 'Patient Scheduling', 'lead gen': 'Lead Generation', 'email marketing': 'Email Marketing', seo: 'SEO', 'graphic designer': 'Graphic Design' };
export function parseSearch(input: string): ParsedSearch {
  let s = ` ${input.toLowerCase()} `;
  const f: ParsedSearch['filters'] = { skills: [], software: [], languages: [], countries: [], max_rate_cents: null, min_years: null, available: null, bilingual: false, keywords: [], status: null };
  const chips: string[] = [];
  const rate = s.match(/(?:under|below|less than|max|<|up to)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*h(?:ou)?r|per hour|an hour|\/hr|usd)?/);
  if (rate) { f.max_rate_cents = Math.round(Number(rate[1]) * 100); chips.push(`Rate ≤ ${formatMoney(f.max_rate_cents)}/hr`); s = s.replace(rate[0], ' '); }
  const yrs = s.match(/(\d+)\+?\s*(?:years?|yrs?)/);
  if (yrs) { f.min_years = Number(yrs[1]); chips.push(`${f.min_years}+ years`); s = s.replace(yrs[0], ' '); }
  if (/\bbilingual\b/.test(s)) { f.bilingual = true; chips.push('Bilingual (2+ languages)'); s = s.replace(/\bbilingual\b/, ' '); }
  if (/\b(available|available now|immediately)\b/.test(s)) { f.available = true; chips.push('Available'); s = s.replace(/\b(available now|available|immediately)\b/, ' '); }
  for (const sw of SOFTWARE_VOCAB) if (has(s, sw)) { f.software.push(sw); chips.push(`Software: ${sw}`); s = s.replace(new RegExp(sw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); }
  for (const sk of SKILL_VOCAB) if (has(s, sk)) { f.skills.push(sk); chips.push(`Skill: ${sk}`); s = s.replace(new RegExp(sk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); }
  for (const [k, v] of Object.entries(ROLE_SKILL)) if (new RegExp(`\\b${k}s?\\b`).test(s) && !f.skills.includes(v)) { f.skills.push(v); chips.push(`Skill: ${v}`); s = s.replace(new RegExp(`\\b${k}s?\\b`), ' '); }
  for (const l of LANGUAGE_VOCAB) if (has(s, l) || (l === 'Spanish' && /\bspanish[- ]speaking\b/.test(s))) { f.languages.push(l); chips.push(`Speaks ${l}`); s = s.replace(new RegExp(l, 'i'), ' '); }
  for (const [k, v] of Object.entries(COUNTRY_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`\\b(?:in|from)?\\s*${k}\\b`);
    if (re.test(s) && !f.countries.includes(v)) { if (k.length === 2 && !new RegExp(`\\b(in|from)\\s+${k}\\b`).test(s)) continue; f.countries.push(v); chips.push(`Country: ${v === 'LATAM' ? 'Latin America' : v === 'AFRICA' ? 'Africa' : v}`); s = s.replace(re, ' '); }
  }
  const stop = new Set(['in', 'from', 'with', 'and', 'or', 'the', 'a', 'an', 'who', 'that', 'can', 'for', 'of', 'va', 'vas', 'candidates', 'candidate', 'people', 'speakers', 'speaking', 'experience', 'experienced', 'hr', 'hour', 'per', 'usd', 'skills', 'using', 'knows', 'know', 'virtual', 'assistant', 'assistants']);
  f.keywords = s.split(/[^a-z0-9+#.]+/).filter(w => w.length > 2 && !stop.has(w));
  for (const k of f.keywords) chips.push(`Keyword: ${k}`);
  return { filters: f, chips };
}

/* ───────────── Drafts (template-based, never sent automatically) ───────────── */
export type DraftKind = 'candidate_summary' | 'client_presentation' | 'outreach_email' | 'interview_questions' | 'job_description';
const list = (a: string[] | null | undefined, n = 4) => (a ?? []).slice(0, n).join(', ');
export function draft(kind: DraftKind, d: { candidate?: any; position?: any; company?: any; org?: any; sender?: any; includeRate?: boolean }): { subject?: string; body: string } {
  const c = d.candidate, p = d.position;
  const first = c?.first_name ?? 'there';
  switch (kind) {
    case 'candidate_summary':
      return { body: [
        `${c.first_name} ${c.last_name ?? ''}`.trim() + (c.headline ? ` — ${c.headline}` : ''),
        c.years_experience !== null && c.years_experience !== undefined ? `${c.years_experience} years of experience${c.country ? `, based in ${c.city ? c.city + ', ' : ''}${c.country}` : ''}.` : c.country ? `Based in ${c.country}.` : '',
        c.skills?.length ? `Skills: ${list(c.skills, 6)}.` : '',
        c.software?.length ? `Software: ${list(c.software, 6)}.` : '',
        c.languages?.length ? `Languages: ${list(c.languages)}.` : '',
        (c.experience ?? []).length ? `Most recent: ${c.experience[0].title}${c.experience[0].company ? ' at ' + c.experience[0].company : ''}.` : '',
        `Availability: ${String(c.availability_status ?? 'unknown').replace('_', ' ')}${c.earliest_start ? `, earliest start ${c.earliest_start}` : ''}${c.weekly_hours ? `, ${c.weekly_hours} h/week` : ''}.`,
      ].filter(Boolean).join('\n') };
    case 'client_presentation':
      return { body: [
        `${c.first_name} ${(c.last_name ?? '').slice(0, 1)}${c.last_name ? '.' : ''}${p ? ` for ${p.title}` : ''}`,
        '',
        `${c.first_name} is a ${c.headline ?? 'remote professional'}${c.years_experience ? ` with ${c.years_experience} years of experience` : ''}${c.country ? ` based in ${c.country}` : ''}.`,
        c.skills?.length ? `Strengths: ${list(c.skills, 5)}.` : '',
        c.software?.length ? `Tools: ${list(c.software, 5)}.` : '',
        c.languages?.length ? `Languages: ${list(c.languages)}.` : '',
        (c.experience ?? []).length ? `Recent experience: ${(c.experience as any[]).slice(0, 2).map(e => `${e.title}${e.company ? ' (' + e.company + ')' : ''}`).join('; ')}.` : '',
        d.includeRate && c.rate_target_cents ? `Rate expectation: ${formatMoney(c.rate_target_cents, c.rate_currency)}/${c.rate_unit}.` : '',
      ].filter(x => x !== '').join('\n') };
    case 'outreach_email':
      return { subject: p ? `${p.title} opportunity with ${d.org?.name ?? 'our team'}` : `Remote opportunities with ${d.org?.name ?? 'our team'}`, body: [
        `Hi ${first},`, '',
        `I'm ${d.sender?.name ?? 'a recruiter'} with ${d.org?.name ?? 'our agency'}. I came across your profile${c?.headline ? ` as a ${c.headline.toLowerCase()}` : ''}${c?.skills?.length ? ` and your experience with ${list(c.skills, 2).toLowerCase()}` : ''} stood out.`,
        p ? `We're hiring a ${p.title}${p.schedule ? ` (${p.schedule}${p.timezone ? ', ' + p.timezone : ''})` : ''}${p.skills?.length ? ` — key skills: ${list(p.skills, 3)}` : ''}.` : `We regularly place remote professionals with US-based businesses.`,
        '', 'Would you be open to a short call this week?', '', d.sender?.name ?? '',
      ].join('\n') };
    case 'interview_questions': {
      const qs = [
        ...(p?.skills ?? []).slice(0, 3).map((s: string) => `Tell me about a time you handled ${s.toLowerCase()} end to end. What was the outcome?`),
        ...(p?.software ?? []).slice(0, 2).map((s: string) => `How have you used ${s}? Walk me through a typical task.`),
        ...(c && p ? overlap(p.skills ?? [], c.skills ?? []).miss.slice(0, 2).map((s: string) => `This role needs ${s.toLowerCase()} — how would you get up to speed?`) : []),
        p?.timezone ? `The role works ${p.schedule ?? 'business hours'} (${p.timezone}). How does that fit your schedule?` : 'What hours are you able to work?',
        'How do you keep a client updated when you are blocked on a task?',
      ];
      return { body: qs.map((x, i) => `${i + 1}. ${x}`).join('\n') };
    }
    case 'job_description':
      return { body: [
        `${p.title}${d.company?.name ? ` — ${d.company.name}` : ''}`, '',
        `About the role`,
        `We are hiring a ${p.title} to join ${d.company?.name ?? 'a growing US-based team'} on a ${String(p.employment_type ?? 'full_time').replace('_', '-')} basis${p.weekly_hours ? ` (${p.weekly_hours} hours/week)` : ''}.${p.schedule ? ` Schedule: ${p.schedule}${p.timezone ? ` (${p.timezone})` : ''}.` : ''}`,
        '', 'What you will do',
        ...((p.skills ?? []).length ? (p.skills as string[]).map(s => `- ${s}`) : ['- Support the team with day-to-day operations']),
        '', 'What you bring',
        ...((p.software ?? []).length ? [`- Hands-on experience with ${list(p.software, 5)}`] : []),
        ...((p.languages ?? []).length ? [`- Professional ${list(p.languages)}`] : []),
        '- Reliable internet and a quiet workspace',
        ...(p.equipment ? [`- Equipment: ${p.equipment}`] : []),
        '', 'Draft generated by Veyro Local AI from the position fields — review and edit before publishing.',
      ].join('\n') };
  }
}

/* ───────────── Claude-first entry points (fall back to the local engine) ───────────── */
export function aiModelName() { return claudeConfigured() ? CLAUDE_MODEL : AI_MODEL; }
async function logFallback(orgId: string, feature: string, e: unknown) {
  const msg = claudeErrorMessage(e);
  console.warn(`[ai] ${feature}: Claude failed, using local engine — ${msg}`);
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'ai','warn',$2,$3)`, [orgId, `${feature}: Claude unavailable, used local engine — ${msg}`, JSON.stringify({ feature })]).catch(() => {});
  return msg;
}

export async function analyzeResumeAI(orgId: string, text: string, opts: { fileNote?: string | null; fileUncertain?: boolean } = {}): Promise<ResumeExtraction> {
  if (claudeConfigured() && text?.trim()) {
    try { return await claudeAnalyzeResume(text, opts); } catch (e) {
      const msg = await logFallback(orgId, 'Analyze Resume', e);
      const local = analyzeResume(text, opts);
      local.warnings.unshift(`Claude was unavailable (${msg}) — used the built-in reader.`);
      return local;
    }
  }
  return analyzeResume(text, opts);
}

/** Scores locally, then (when Claude is configured) has Claude re-rank the strongest candidates by reading the full role. */
export async function rankMatchesAI(orgId: string, p: MatchPosition & { description?: string | null; client?: string | null }, pool: any[], limit: number) {
  const local = pool.map(c => ({ c, m: scoreMatch(p, c) })).sort((a, b) => b.m.score - a.m.score);
  if (!claudeConfigured() || !local.length) return { model: AI_MODEL, scored: local.slice(0, limit), note: null as string | null };
  const top = local.slice(0, Math.min(40, Math.max(limit, 15)));
  try {
    const input: ClaudeMatchInput[] = top.map(({ c, m }) => ({
      id: c.id, local: m,
      profile: { ...c, name: [c.first_name, c.last_name].filter(Boolean).join(' '), summary: Array.isArray(c.experience) && c.experience.length ? JSON.stringify(c.experience).slice(0, 1500) : null, resume_excerpt: c.resume_text ? String(c.resume_text).slice(0, 1500) : null },
    }));
    const ranked = await claudeRankMatches(p, input);
    const scored = top.map(({ c, m }) => {
      const r = ranked.get(c.id);
      return { c, m: r ? { ...m, score: r.score, reasons: r.reasons, missing: r.missing, breakdown: { ...m.breakdown, claude: { score: r.score, max: 100, detail: 'Overall fit judged by Claude from the full role and profile' } } } : m };
    }).sort((a, b) => b.m.score - a.m.score).slice(0, limit);
    return { model: CLAUDE_MODEL, scored, note: null };
  } catch (e) {
    const msg = await logFallback(orgId, 'Find Best Matches', e);
    return { model: AI_MODEL, scored: local.slice(0, limit), note: `Claude was unavailable (${msg}) — ranked with the built-in scorer.` };
  }
}
