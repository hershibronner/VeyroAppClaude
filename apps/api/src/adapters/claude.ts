// Claude-backed AI (claude-opus-5-5). Used when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set;
// every caller falls back to the deterministic local engine in ./ai.ts when Claude is not configured or errors.
// Same contract as the local engine: only facts present in the source, a snippet for every field, uncertain flagged.
import Anthropic from '@anthropic-ai/sdk';
import type { MatchCandidate, MatchPosition, MatchScore, ResumeExtraction } from './ai';

export const CLAUDE_MODEL = 'claude-opus-5-5';
let client: Anthropic | null = null;

export function claudeConfigured() {
  return process.env.VEYRO_AI_PROVIDER !== 'local' && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() { return (client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 })); }

/** One structured-output call. Throws on refusal / unparseable output so callers can fall back. */
async function askJson<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens = 16000): Promise<T> {
  const res = await getClient().beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  } as any);
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude response was cut off');
  const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return JSON.parse(text) as T;
}

/** Friendly message for logs / UI when a Claude call fails. */
export function claudeErrorMessage(e: unknown) {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API key was rejected — check ANTHROPIC_API_KEY.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude rate limit reached — used the local engine instead.';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ''}: ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}

/* ───────────── Find Best Matches ───────────── */
export interface ClaudeMatchInput { id: string; profile: MatchCandidate & { name?: string; summary?: string | null; resume_excerpt?: string | null; country?: string | null }; local: MatchScore }
const MATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['candidate_id', 'score', 'reasons', 'missing'],
        properties: {
          candidate_id: { type: 'string' },
          score: { type: 'integer', description: '0-100 overall fit' },
          reasons: { type: 'array', items: { type: 'string' }, description: 'Short, specific strengths grounded in the profile' },
          missing: { type: 'array', items: { type: 'string' }, description: 'Gaps or risks the recruiter should check' },
        },
      },
    },
  },
};

export async function claudeRankMatches(p: MatchPosition & { description?: string | null; requirements?: string | null; client?: string | null }, cands: ClaudeMatchInput[]) {
  const position = {
    title: p.title, client: p.client ?? null, description: (p.description ?? '').slice(0, 3000) || null, requirements: (p.requirements ?? '').slice(0, 2000) || null,
    skills: p.skills, software: p.software, languages: p.languages, timezone: p.timezone, weekly_hours: p.weekly_hours, schedule: p.schedule ?? null,
    pay_range: p.pay_min_cents || p.pay_max_cents ? `${p.currency} ${(p.pay_min_cents ?? 0) / 100}–${(p.pay_max_cents ?? 0) / 100}/hr` : null,
  };
  const candidates = cands.map(({ id, profile: c, local }) => ({
    candidate_id: id, name: c.name, headline: c.headline, country: c.country ?? null, timezone: c.timezone, years_experience: c.years_experience,
    skills: c.skills, software: c.software, languages: c.languages, availability: c.availability_status, earliest_start: c.earliest_start,
    weekly_hours: c.weekly_hours, rate_expectation: c.rate_min_cents ? `${c.rate_currency} ${c.rate_min_cents / 100}${c.rate_target_cents ? `–${c.rate_target_cents / 100}` : ''}/hr` : null,
    preferred_hours: c.preferred_hours, tags: c.tags, summary: c.summary ?? null, resume_excerpt: c.resume_excerpt ?? null,
    rule_based_score: local.score,
  }));
  const system = `You are the matching engine inside a staffing agency's recruiting tool. Rank remote-staff candidates for one open position.
Score each candidate 0-100 for how well they fit the role as described — read the title and description, not just the skill tags; related experience counts (e.g. "Instagram content" fits a social media manager role even if the skill tag differs).
Ground every reason and gap in the candidate data given. Never invent experience, certifications or availability. Keep each reason under 15 words; give 2-4 reasons and 0-4 gaps.
"rule_based_score" is a keyword-overlap score from the system; use it as one signal only. Return every candidate_id exactly once.`;
  const out = await askJson<{ results: { candidate_id: string; score: number; reasons: string[]; missing: string[] }[] }>(system, JSON.stringify({ position, candidates }), MATCH_SCHEMA);
  const ids = new Set(cands.map(c => c.id));
  return new Map(out.results.filter(r => ids.has(r.candidate_id)).map(r => [r.candidate_id, { ...r, score: Math.max(0, Math.min(100, Math.round(r.score))) }]));
}

/* ───────────── Analyze Resume ───────────── */
const strField = { type: 'object', additionalProperties: false, required: ['value', 'snippet', 'uncertain'], properties: { value: { type: ['string', 'null'] }, snippet: { type: ['string', 'null'] }, uncertain: { type: 'boolean' } } };
const numField = { type: 'object', additionalProperties: false, required: ['value', 'snippet', 'uncertain'], properties: { value: { type: ['number', 'null'] }, snippet: { type: ['string', 'null'] }, uncertain: { type: 'boolean' } } };
const listField = { type: 'object', additionalProperties: false, required: ['value', 'snippet', 'uncertain'], properties: { value: { type: 'array', items: { type: 'string' } }, snippet: { type: ['string', 'null'] }, uncertain: { type: 'boolean' } } };
const objList = (props: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required: ['value', 'snippet', 'uncertain'],
  properties: { value: { type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props } }, snippet: { type: ['string', 'null'] }, uncertain: { type: 'boolean' } },
});
const RESUME_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fields', 'sections_found', 'warnings'],
  properties: {
    fields: {
      type: 'object', additionalProperties: false,
      required: ['first_name', 'last_name', 'email', 'phone', 'headline', 'city', 'country', 'years_experience', 'summary', 'skills', 'software', 'languages', 'education', 'experience'],
      properties: {
        first_name: strField, last_name: strField, email: strField, phone: strField, headline: strField, city: strField, country: strField,
        years_experience: numField, summary: strField, skills: listField, software: listField, languages: listField,
        education: objList({ degree: { type: 'string' }, school: { type: ['string', 'null'] }, year: { type: ['integer', 'null'] }, evidence: { type: 'string' } }),
        experience: objList({ title: { type: 'string' }, company: { type: ['string', 'null'] }, start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] }, evidence: { type: 'string' } }),
      },
    },
    sections_found: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

export async function claudeAnalyzeResume(text: string, opts: { fileNote?: string | null } = {}): Promise<ResumeExtraction> {
  const system = `You extract structured profile data from a candidate's resume for a recruiter to review before saving.
Rules: only use facts written in the resume. For every field, "snippet" is a short verbatim quote from the resume that supports it (null when value is empty).
Set "uncertain" true when you inferred or computed the value (e.g. years_experience summed from dates, country inferred from a city) rather than reading it directly.
"skills" are job skills (e.g. Bookkeeping, Customer Support), "software" are named tools/apps, "languages" are spoken languages. Leave a field empty rather than guess.
Use title case for skills and software. Dates in experience as YYYY-MM or "Present". Add a warning for anything the recruiter should double-check.`;
  const out = await askJson<Omit<ResumeExtraction, 'model'>>(system, `<resume>\n${text.slice(0, 60_000)}\n</resume>`, RESUME_SCHEMA);
  // Guard against quotes that are not actually in the source: keep the value but flag it.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const src = norm(text);
  for (const f of Object.values(out.fields) as any[]) {
    if (f.snippet && !src.includes(norm(f.snippet).slice(0, 40))) { f.uncertain = true; f.note = 'Quote not found verbatim in the resume — please verify.'; }
  }
  if (opts.fileNote) out.warnings.unshift(opts.fileNote);
  return { model: CLAUDE_MODEL, ...out } as ResumeExtraction;
}

/* ───────────── Smart import (spreadsheets from other software) ───────────── */
export interface ImportFieldDef { key: string; label: string; type: string; required?: boolean; options?: string[] }
export interface ImportSheetPlan { sheet: string; entity: string; confidence: number; mapping: Record<string, string>; notes: string[]; needs_cleanup: boolean }

/** Decides what each sheet holds (positions / candidates / clients / leads / contacts / skip) and maps its columns. */
export async function claudePlanImport(sheets: { name: string; headers: string[]; sample: string[][]; rows: number }[], entities: Record<string, { label: string; fields: ImportFieldDef[] }>) {
  const schema = {
    type: 'object', additionalProperties: false, required: ['sheets'],
    properties: {
      sheets: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['sheet', 'entity', 'confidence', 'mapping', 'notes', 'needs_cleanup'],
          properties: {
            sheet: { type: 'string' },
            entity: { type: 'string', enum: [...Object.keys(entities), 'skip'] },
            confidence: { type: 'number', description: '0-1' },
            mapping: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'column'], properties: { field: { type: 'string' }, column: { type: 'string' } } } },
            notes: { type: 'array', items: { type: 'string' }, description: 'Short, plain-English notes for the recruiter (what was detected, what will be cleaned up)' },
            needs_cleanup: { type: 'boolean', description: 'True when values need reshaping that a column mapping cannot do (full name in one column, rates like "$5-7/hr", skills in prose, mixed date formats, combined client/position cells)' },
          },
        },
      },
    },
  };
  const system = `You help a staffing agency move its data into VeyroApp from spreadsheets exported from other recruiting software (Bullhorn, Recruit CRM, Zoho Recruit, Google Sheets, etc.).
For each sheet, decide which VeyroApp record type it contains, or "skip" for summaries, instructions, pivot tables or empty sheets. Then map target fields to the sheet's exact column headers.
Only map a column when you are confident; each column maps to at most one field. Use the sample rows, not just the header text.
"clients" are companies the agency already serves; "leads" are prospects; "contacts" are people at client companies; "positions" are open jobs/roles to fill; "candidates" are job seekers / VAs.`;
  const out = await askJson<{ sheets: (Omit<ImportSheetPlan, 'mapping'> & { mapping: { field: string; column: string }[] })[] }>(system, JSON.stringify({
    target_types: Object.fromEntries(Object.entries(entities).map(([k, e]) => [k, { label: e.label, fields: e.fields.map(f => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, options: f.options })) }])),
    sheets: sheets.map(s => ({ sheet: s.name, total_rows: s.rows, headers: s.headers, sample_rows: s.sample.slice(0, 8) })),
  }), schema);
  return out.sheets.map(s => {
    const def = entities[s.entity]; const headers = sheets.find(x => x.name === s.sheet)?.headers ?? [];
    const mapping: Record<string, string> = {};
    for (const m of s.mapping) if (def?.fields.some(f => f.key === m.field) && headers.includes(m.column) && !Object.values(mapping).includes(m.column)) mapping[m.field] = m.column;
    return { ...s, mapping, confidence: Math.max(0, Math.min(1, s.confidence)) } as ImportSheetPlan;
  });
}

/** Rewrites raw rows into clean values for the target fields (split names, parse rates, normalise lists/dates/enums). */
export async function claudeCleanRows(entityLabel: string, fields: ImportFieldDef[], headers: string[], rows: string[][]): Promise<Record<string, string>[]> {
  const props = Object.fromEntries(fields.map(f => [f.key, { type: 'string', description: `${f.label}${f.options ? ` — one of: ${f.options.join(', ')}` : ''}${f.type === 'money' ? ' — plain number in dollars per hour, e.g. 6.5' : ''}${f.type === 'list' ? ' — items separated by "; "' : ''}${f.type === 'date' ? ' — YYYY-MM-DD' : ''}${f.type === 'number' ? ' — plain number' : ''}. Empty string when unknown.` }]));
  const schema = {
    type: 'object', additionalProperties: false, required: ['rows'],
    properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['row', ...fields.map(f => f.key)], properties: { row: { type: 'integer' }, ...props } } } },
  };
  const system = `You clean spreadsheet rows for import into a staffing agency system as ${entityLabel}. Return one object per input row, same "row" number, in the same order.
Copy facts only from that row — never invent emails, phones, rates or names. Split full names into first/last. Turn "$5-7/hr" into min 5 and max 7. Keep enum values exactly as listed or leave them empty.`;
  const out = await askJson<{ rows: ({ row: number } & Record<string, string>)[] }>(system, JSON.stringify({ headers, rows: rows.map((r, i) => ({ row: i + 1, values: Object.fromEntries(headers.map((h, ci) => [h, r[ci] ?? ''])) })) }), schema);
  const byRow = new Map(out.rows.map(r => [r.row, r]));
  return rows.map((_, i) => { const r = byRow.get(i + 1); const o: Record<string, string> = {}; for (const f of fields) o[f.key] = String(r?.[f.key] ?? '').trim(); return o; });
}
