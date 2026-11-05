// End-to-end acceptance script (brief §13, steps 1–18) against the running app.
//
// Each step is driven through the real HTTP API with one Playwright request context per demo user
// (session cookie from POST /auth/login, CSRF token from GET /auth/me), plus real browser checks where
// they are cheap and meaningful (demo login, position link page, client-safe profile, Live Now,
// worker payslips, workspace switcher). Names/emails carry a per-run tag so the test is re-runnable
// without a DB reset.
import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

const API = 'http://localhost:4100';
const WEB = 'http://localhost:3100';
const PW = 'demo1234';
const SLUG = 'maga-hire';

// Per-run identifiers. TAG is letters only so it survives name parsing (resume analysis).
const RUN = Date.now().toString(36);
const TAG = RUN.replace(/[0-9]/g, d => 'abcdefghij'[Number(d)]);
const CAP = TAG[0].toUpperCase() + TAG.slice(1);
// Public endpoints are rate-limited per IP; give each run its own client IP (API trusts x-forwarded-for).
const XFF = `10.${(Date.now() >> 16) & 255}.${(Date.now() >> 8) & 255}.${Date.now() & 255}`;
const HEADERS = { 'x-forwarded-for': XFF };

// ── Small date helpers (UTC-safe ISO dates) ──
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return addDays(iso, -dow); };
const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
// Same half-up rounding the app uses for money.
const divHalfUp = (n: number, d: number) => Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
const applyBp = (c: number, bp: number) => divHalfUp(c * bp, 10000);

type Res = { status: number; body: any };

/** One logged-in (or anonymous) API user. */
class U {
  csrf = '';
  me: any = null;
  constructor(public rc: APIRequestContext, public label: string) {}
  static async anon(label = 'anon') { return new U(await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: HEADERS }), label); }
  static async login(email: string, password = PW) {
    const u = await U.anon(email);
    const r = await u.rc.post('/api/v1/auth/login', { data: { email, password } });
    expect(r.status(), `login ${email}: ${await r.text()}`).toBe(200);
    await u.refresh();
    return u;
  }
  async refresh() { this.me = await (await this.rc.get('/api/v1/auth/me')).json(); this.csrf = this.me.csrf ?? ''; return this.me; }
  get userId(): string { return this.me.user.id; }
  async call(method: string, path: string, body?: unknown, opts: { multipart?: any } = {}): Promise<Res> {
    const headers: Record<string, string> = {};
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    const r = await this.rc.fetch(path, { method, headers, ...(opts.multipart ? { multipart: opts.multipart } : body !== undefined ? { data: body } : {}) });
    const text = await r.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: r.status(), body: json };
  }
  /** Call and assert the status (default 200); returns the parsed body. */
  async ok(method: string, path: string, body?: unknown, expected: number | number[] = 200, opts: { multipart?: any } = {}) {
    const r = await this.call(method, path, body, opts);
    const exp = Array.isArray(expected) ? expected : [expected];
    expect(exp, `${this.label} ${method} ${path} → ${r.status}: ${JSON.stringify(r.body).slice(0, 600)}`).toContain(r.status);
    return r.body;
  }
  get = (p: string, exp?: number | number[]) => this.ok('GET', p, undefined, exp);
  post = (p: string, b: unknown = {}, exp?: number | number[]) => this.ok('POST', p, b, exp);
  patch = (p: string, b: unknown, exp?: number | number[]) => this.ok('PATCH', p, b, exp);
  put = (p: string, b: unknown, exp?: number | number[]) => this.ok('PUT', p, b, exp);
  del = (p: string, exp?: number | number[]) => this.ok('DELETE', p, undefined, exp);
  async status(method: string, path: string, body?: unknown) { return (await this.call(method, path, body)).status; }
  async dispose() { await this.rc.dispose(); }
}

/** Browser context that reuses an API user's session cookie. */
async function browserAs(browser: Browser, u: U | null): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: WEB, extraHTTPHeaders: HEADERS, ...(u ? { storageState: await u.rc.storageState() } : {}) });
  return ctx;
}

/** Latest invitation link token sent to `to` in the Dev Outbox (newest first). */
async function inviteTokenFromOutbox(anon: U, to: string): Promise<string> {
  let token = '';
  await expect.poll(async () => {
    const r = await anon.get(`/api/v1/dev/outbox?to=${encodeURIComponent(to)}&pageSize=20`);
    for (const m of r.rows ?? []) { const t = String(m.body_text ?? m.body_html ?? '').match(/\/invite\/([A-Za-z0-9_-]{10,})/); if (t) { token = t[1]; return true; } }
    return false;
  }, { message: `invitation email to ${to}`, timeout: 15_000 }).toBe(true);
  return token;
}

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SIGNATURE = 'data:image/png;base64,' + PNG_1x1.toString('base64');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]);

test.describe.configure({ mode: 'serial' });

test('§13 acceptance script — full staffing lifecycle (steps 1–18)', async ({ browser }) => {
  test.setTimeout(420_000);
  const startedAt = new Date(Date.now() - 5000).toISOString();

  const opened: { close: () => Promise<void> }[] = [];

  // Owner signs in through the real login page with the one-click demo account. The same browser session
  // drives the owner's API calls (page.request shares its cookies) and the later UI steps.
  const ownerCtx = await browser.newContext({ baseURL: WEB, extraHTTPHeaders: HEADERS }); opened.push(ownerCtx);
  const ownerPage: Page = await ownerCtx.newPage();
  await test.step('UI: login page one-click demo account lands on the right page', async () => {
    await ownerPage.goto('/login');
    await ownerPage.getByRole('button', { name: /Ava Stern/ }).click();
    await ownerPage.waitForURL(url => new URL(url).pathname === '/', { timeout: 20_000 });
    await expect(ownerPage.getByRole('button', { name: 'Switch workspace' })).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Switch workspace' })).toContainText('MAGA Hire');
  });

  // ── Actors ──
  const owner = new U(ownerCtx.request, 'owner@veyro.demo');
  await owner.refresh();
  expect(owner.me.workspace.role.key).toBe('owner');
  const [sales, noah, finance, am] = await Promise.all(['sales', 'recruiter', 'finance', 'am'].map(n => U.login(`${n}@veyro.demo`)));
  const members: any[] = await owner.get('/api/v1/members');
  const idOf = (email: string) => { const m = members.find(x => x.email === email); expect(m, `member ${email}`).toBeTruthy(); return m.id as string; };
  const NOAH = idOf('recruiter@veyro.demo'), LENA = idOf('sales@veyro.demo'), PRIYA = idOf('am@veyro.demo');

  // Shared state
  const S: Record<string, any> = {};
  const clientName = `E2E Smiles ${CAP} Dental`;
  const contactEmail = `erin.${TAG}@e2e-client.test`;
  const candEmail = `ana.${TAG}@e2e-cand.test`;
  const candPhone = `+63 917 ${String(Date.now()).slice(-7, -4)} ${String(Date.now()).slice(-4)}`;
  const candPw = `E2e-${RUN}-pw!`;
  const clientPw = `E2e-${RUN}-client!`;
  let payoutFailureRate: number | null = null;

  try {
    // Pick a past Mon–Sun week for the simulated work week that no payroll run overlaps (payroll periods can't
    // overlap), so the test never collides with the demo's natural pay periods and stays re-runnable.
    await test.step('setup: choose a free payroll week', async () => {
      const runs = (await finance.get('/api/v1/payroll/runs?pageSize=5000')).rows as any[];
      const earliest = runs.map(r => r.period_start).sort()[0] ?? todayNY();
      let w = mondayOf(addDays(earliest, -7));
      for (let i = 0; i < 400; i++, w = addDays(w, -7)) {
        const end = addDays(w, 6);
        if (w.slice(0, 7) !== addDays(w, 4).slice(0, 7)) continue; // keep Mon–Fri inside one month (commission month)
        if (!runs.some(r => r.period_start <= end && r.period_end >= w)) break;
      }
      S.W = w; S.WEND = addDays(w, 6); S.RATE_CHANGE = addDays(w, 2);
      S.month = w.slice(0, 7);
    });

    // ── 1. Sales: lead → call → qualify → convert (same company id) with opportunity → won → position ──
    await test.step('1. Sales: lead → call → qualify → convert → opportunity won → position', async () => {
      const lead = await sales.post('/api/v1/leads', { name: clientName, website: `https://${TAG}-smiles.test`, industry: 'Dental', country: 'United States', est_workers: 2,
        contact: { first_name: 'Erin', last_name: `Client${CAP}`, title: 'Office Manager', email: contactEmail, phone: '+1 512 555 0142' } });
      S.companyId = lead.id;
      expect(lead.stage).toBe('lead');
      await sales.post(`/api/v1/timeline/company/${S.companyId}`, { kind: 'call', body: 'Discovery call: needs remote front-desk coverage, 40h/week.' });
      await sales.post(`/api/v1/leads/${S.companyId}/qualify`, { note: 'Budget confirmed' });
      const conv = await sales.post(`/api/v1/leads/${S.companyId}/convert`, { account_manager_id: PRIYA, opportunity: { name: `${clientName} — remote staffing`, value_cents: 480000, est_workers: 2, stage: 'proposal' } });
      expect(conv.id).toBe(S.companyId); // same Company ID throughout
      expect(conv.stage).toBe('client');
      S.oppId = conv.opportunity_id;
      expect(S.oppId).toBeTruthy();
      const won = await sales.post(`/api/v1/opportunities/${S.oppId}/stage`, { stage: 'won', position: { title: `Remote Dental Receptionist ${CAP}`, openings: 1 } });
      expect(won.stage).toBe('won');
      S.positionId = won.position_id;
      expect(S.positionId).toBeTruthy();
      S.positionTitle = `Remote Dental Receptionist ${CAP}`;
      await sales.patch(`/api/v1/positions/${S.positionId}`, { employment_type: 'full_time', timezone: 'America/New_York', weekly_hours: 40, schedule: 'Mon–Fri 9:00–17:00 ET',
        skills: ['Scheduling', 'Insurance verification', 'Customer service'], software: ['Dentrix', 'Google Workspace'], languages: ['English'], description: 'Front desk for a busy dental office.' });
      const co = await sales.get(`/api/v1/companies/${S.companyId}`);
      const company = co.company ?? co;
      expect(company.id).toBe(S.companyId);
      expect(company.stage).toBe('client');
      expect(company.lead_status).toBe('converted');
      const pos = await owner.get(`/api/v1/positions/${S.positionId}`);
      expect(pos.company_id).toBe(S.companyId);
      expect(pos.opportunity_id).toBe(S.oppId);
    });

    // ── 2. Owner assigns Noah; Noah copies his position link ──
    await test.step('2. Owner assigns Recruiter Noah; Noah gets his position link', async () => {
      await owner.post(`/api/v1/positions/${S.positionId}/recruiters`, { user_id: NOAH, is_lead: true });
      await owner.post(`/api/v1/positions/${S.positionId}/status`, { status: 'open' });
      const link = await noah.post(`/api/v1/positions/${S.positionId}/sourcing`);
      expect(link.user_id).toBe(NOAH);
      expect(link.url).toContain(`/apply/${SLUG}/p/${link.token}`);
      S.linkToken = link.token; S.linkUrl = link.url;
    });

    // ── 3. Logged-out candidate applies via the link ──
    const anon = await U.anon('candidate(anon)'); opened.push({ close: () => anon.dispose() });
    await test.step('3. Logged-out candidate applies via the position link (resume prefill, video, rate range)', async () => {
      const info = await anon.get(`/api/v1/public/apply/${SLUG}/link/p/${S.linkToken}`);
      expect(info.position.title).toBe(S.positionTitle);
      expect(info.recruiter_first_name).toBe('Noah');
      // Real browser: the public apply page renders for this link.
      const pub = await browserAs(browser, null); opened.push(pub);
      const pg = await pub.newPage();
      await pg.goto(new URL(S.linkUrl).pathname);
      await expect(pg.getByText(S.positionTitle).first()).toBeVisible();
      await pub.close();

      const resume = [`Ana Applicant${TAG}`, 'Dental Receptionist · Manila, Philippines', `${candEmail} | ${candPhone}`, '', 'SUMMARY', 'Six years of front-desk work for US dental clinics.', '',
        'SKILLS', 'Scheduling, Insurance verification, Customer service', '', 'SOFTWARE', 'Dentrix, Google Workspace', '', 'LANGUAGES', 'English, Tagalog', '',
        'EXPERIENCE', 'Front Desk Coordinator — SmileCare Clinic (2019 – 2025)', '', 'EDUCATION', 'BS Business Administration — University of Manila, 2018'].join('\n');
      const up = await anon.ok('POST', `/api/v1/public/apply/${SLUG}/upload/resume`, undefined, 200, { multipart: { file: { name: 'ana-resume.txt', mimeType: 'text/plain', buffer: Buffer.from(resume) } } });
      expect(up.upload).toBeTruthy();
      expect(up.extraction, 'AI pre-fill extraction').toBeTruthy();
      const f = up.extraction.fields;
      expect(f.email.value).toBe(candEmail);
      const vid = await anon.ok('POST', `/api/v1/public/apply/${SLUG}/upload/video`, undefined, 200, { multipart: { file: { name: 'intro.webm', mimeType: 'video/webm', buffer: WEBM } } });
      S.applyBody = {
        first_name: f.first_name.value ?? 'Ana', last_name: f.last_name.value ?? `Applicant${TAG}`, email: f.email.value, phone: candPhone, country: 'Philippines', city: 'Manila', timezone: 'Asia/Manila',
        headline: f.headline?.value ?? 'Dental Receptionist', years_experience: 6, skills: f.skills?.value?.length ? f.skills.value : ['Scheduling'], software: f.software?.value ?? [], languages: f.languages?.value ?? ['English'],
        availability_status: 'available', weekly_hours: 40, rate_min_cents: 600, rate_target_cents: 800, rate_currency: 'USD', rate_unit: 'hour',
        resume_upload: up.upload, video_upload: vid.upload, resume_prefilled: true, consent: true,
      };
      expect(S.applyBody.first_name).toBe('Ana');
      const sub = await anon.post(`/api/v1/public/apply/${SLUG}/submit`, { ...S.applyBody, link_kind: 'p', link_token: S.linkToken });
      expect(sub.returning).toBe(false);
      expect(sub.position_title).toBe(S.positionTitle);
      S.app1 = sub.application_id;
      // Candidate portal account (direct, new email + password) — signs this context in.
      const acct = await anon.post(`/api/v1/public/apply/${SLUG}/account`, { applicant_token: sub.applicant_token, password: candPw });
      expect(acct.mode).toBe('created');
      await anon.refresh();
      expect(anon.me.workspace.role.kind).toBe('candidate');
      S.candidateId = anon.me.workspace.candidateId;
      // Noah is notified and attribution is his.
      await expect.poll(async () => (await noah.get('/api/v1/notifications')).rows.some((n: any) => n.event === 'application.new' && n.link === `/recruiting/candidates/${S.candidateId}`), { timeout: 10_000 }).toBe(true);
      const cand = await owner.get(`/api/v1/candidates/${S.candidateId}`);
      expect(cand.sourced_by).toBe(NOAH);
      expect(cand.source).toBe('Position link');
      expect(cand.applications).toHaveLength(1);
      expect(cand.applications[0].recruiter_id).toBe(NOAH);
      expect(cand.video_file).toBeTruthy();
      expect(cand.rate_min_cents).toBe(600);
      expect(cand.rate_target_cents).toBe(800);
    });

    // ── 4. Same email applies again → same candidate, second application, attribution kept ──
    await test.step('4. Same email applies again → no duplicate, second application, attribution preserved', async () => {
      const anon2 = await U.anon('candidate(anon2)');
      const sub2 = await anon2.post(`/api/v1/public/apply/${SLUG}/submit`, { ...S.applyBody, resume_upload: null, video_upload: null, resume_prefilled: false });
      await anon2.dispose();
      expect(sub2.returning).toBe(true);
      const list = await owner.get(`/api/v1/candidates?search=${encodeURIComponent(candEmail)}`);
      expect(list.total).toBe(1);
      expect(list.rows[0].id).toBe(S.candidateId);
      const cand = await owner.get(`/api/v1/candidates/${S.candidateId}`);
      expect(cand.applications).toHaveLength(2);
      expect(cand.applications.every((a: any) => a.recruiter_id === NOAH)).toBe(true);
      expect(cand.sourced_by).toBe(NOAH);
      expect(cand.source).toBe('Position link');
    });

    // ── 5. Noah: Analyze Resume, Find Best Matches, Screening → Assessment → Recruiter Review → Qualified → submit ──
    await test.step('5. Noah: Analyze Resume, Find Best Matches, pipeline stages, assessment in portal, submit to client', async () => {
      const ex = await noah.post(`/api/v1/candidates/${S.candidateId}/analyze-resume`);
      expect(ex.status).toBe('pending_review');
      const data = typeof ex.data === 'string' ? JSON.parse(ex.data) : ex.data;
      const headline = data.fields.headline?.value || 'Dental Receptionist';
      const accepted = await noah.post(`/api/v1/resume-extractions/${ex.id}/accept`, { fields: { headline, years_experience: 6 } });
      expect(accepted.headline).toBe(headline);
      const matches = await noah.post(`/api/v1/positions/${S.positionId}/matches`, {});
      expect(Array.isArray(matches.results)).toBe(true);
      expect(matches.results.length).toBeGreaterThan(0);
      expect(matches.run.position_id ?? S.positionId).toBe(S.positionId);

      expect((await noah.post(`/api/v1/candidates/${S.candidateId}/status`, { status: 'screening' })).status).toBe('screening');
      const tpls = await noah.get('/api/v1/assessment-templates');
      const tpl = (Array.isArray(tpls) ? tpls : tpls.rows)[0];
      const asm = await noah.post('/api/v1/assessments', { template_id: tpl.id, candidate_id: S.candidateId, position_id: S.positionId });
      expect((await owner.get(`/api/v1/candidates/${S.candidateId}`)).status).toBe('assessment');
      // Candidate completes it in the Candidate Portal.
      const mine = (await anon.get('/api/v1/portal/candidate/assessments')) as any[];
      const a = mine.find(x => x.id === asm.id);
      expect(a).toBeTruthy();
      await anon.post(`/api/v1/portal/candidate/assessments/${a.id}/start`);
      const answers = Object.fromEntries((a.questions as any[]).map((_, i) => [String(i), `Answer ${i + 1}: I would handle it calmly and document it in Dentrix.`]));
      await anon.post(`/api/v1/portal/candidate/assessments/${a.id}/submit`, { answers });
      await noah.post(`/api/v1/assessments/${asm.id}/score`, { score: 88, notes: 'Strong answers' });
      expect((await noah.post(`/api/v1/candidates/${S.candidateId}/status`, { status: 'recruiter_review' })).status).toBe('recruiter_review');
      expect((await noah.post(`/api/v1/candidates/${S.candidateId}/status`, { status: 'qualified' })).status).toBe('qualified');
      const sub = await noah.post('/api/v1/submissions', { candidate_id: S.candidateId, position_id: S.positionId, shareable: { contact: false, rate: false, notes: false } });
      S.submissionId = sub.id;
      expect((await owner.get(`/api/v1/candidates/${S.candidateId}`)).status).toBe('submitted');
    });

    // ── 6. Client portal: client-safe profile, interview request → scheduled → feedback ──
    let client: U;
    await test.step('6. Client Portal: client-safe profile (no contact details), interview requested → scheduled → feedback', async () => {
      // The new client gets portal access through the CRM invitation flow (Dev Outbox → accept).
      const contacts = await sales.get(`/api/v1/contacts?company_id=${S.companyId}`);
      const contact = contacts.rows.find((c: any) => c.email === contactEmail);
      expect(contact).toBeTruthy();
      await sales.post(`/api/v1/companies/${S.companyId}/portal-invitations`, { contact_id: contact.id, role_key: 'client_owner' });
      const token = await inviteTokenFromOutbox(anon, contactEmail);
      client = await U.anon('client');
      await client.post(`/api/v1/auth/invitations/${token}/accept`, { name: `Erin Client${CAP}`, password: clientPw });
      await client.refresh();
      expect(client.me.workspace.role.kind).toBe('client');
      expect(client.me.workspace.companyId).toBe(S.companyId);
      opened.push({ close: () => client.dispose() });

      const list = await client.get('/api/v1/portal/client/candidates');
      const row = list.rows.find((r: any) => r.submission_id === S.submissionId);
      expect(row).toBeTruthy();
      const detail = await client.get(`/api/v1/portal/client/candidates/${S.submissionId}`);
      const json = JSON.stringify(detail);
      expect(json).not.toContain(candEmail);
      expect(json).not.toContain(candPhone);
      expect(detail.profile.email ?? null).toBeNull();
      expect(detail.profile.phone ?? null).toBeNull();
      expect(detail.status).toBe('client_review');
      // Real browser: the client portal candidate page shows the profile but no contact details.
      const cctx = await browserAs(browser, client); opened.push(cctx);
      const cp = await cctx.newPage();
      await cp.goto(`/portal/client/candidates/${S.submissionId}`);
      await expect(cp.getByText('Contact details are kept private', { exact: false })).toBeVisible();
      await expect(cp.getByText(S.positionTitle, { exact: false }).first()).toBeVisible();
      const text = await cp.locator('body').innerText();
      expect(text).not.toContain(candEmail);
      expect(text).not.toContain(candPhone);
      S.clientCtx = cctx;

      const when = new Date(Date.now() + 3 * 60_000).toISOString();
      const req = await client.post(`/api/v1/portal/client/candidates/${S.submissionId}/decision`, { decision: 'interview', preferred_time: when, timezone: 'America/New_York', duration_min: 30, feedback: 'Looks great — happy to meet.' });
      S.interviewId = req.interview_id;
      const conf = await noah.post(`/api/v1/interviews/${S.interviewId}/confirm`, {});
      expect(conf.status).toBe('scheduled');
      const subRow = await noah.get(`/api/v1/submissions/${S.submissionId}`);
      expect(subRow.status).toBe('client_interview');
      await client.post(`/api/v1/portal/client/interviews/${S.interviewId}/feedback`, { overall: 5, recommendation: 'strong_hire', notes: 'Excellent communication.' });
      const iv = await noah.get(`/api/v1/interviews/${S.interviewId}`);
      expect(iv.status).toBe('completed');
      expect(iv.feedback.length).toBeGreaterThan(0);
    });

    // ── 7. Offer created → approved → sent → accepted & signed in the Candidate Portal ──
    await test.step('7. Offer: created → approved → sent → accepted and signed by the candidate', async () => {
      const offer = await noah.post('/api/v1/offers', { candidate_id: S.candidateId, position_id: S.positionId, pay_rate_cents: 700, bill_rate_cents: 1500, currency: 'USD', rate_unit: 'hour', weekly_hours: 40, start_date: S.W, terms: 'Full-time remote, Mon–Fri 9–5 ET.' });
      S.offerId = offer.id;
      expect(offer.status).toBe('draft');
      expect((await owner.post(`/api/v1/offers/${S.offerId}/approve`)).status).toBe('approved');
      expect((await noah.post(`/api/v1/offers/${S.offerId}/send`)).status).toBe('sent');
      const offers = (await anon.get('/api/v1/portal/candidate/offers')) as any[];
      const mine = offers.find(o => o.id === S.offerId);
      expect(mine).toBeTruthy();
      expect(mine.bill_rate_cents).toBeUndefined(); // candidate never sees the client bill rate
      await anon.post(`/api/v1/portal/candidate/offers/${S.offerId}/view`);
      const acc = await anon.post(`/api/v1/portal/candidate/offers/${S.offerId}/accept`, { signature_name: `Ana Applicant${TAG}`, signature_data: SIGNATURE, agree: true });
      expect(acc.status).toBe('accepted');
      expect(acc.signed_at).toBeTruthy();
    });

    // ── 8. Placement from the offer (same person) ──
    await test.step('8. Placement created from the offer — no duplicate person, rates, schedule, monitoring policy', async () => {
      const pl = await am.post('/api/v1/placements', { offer_id: S.offerId, company_id: S.companyId, position_id: S.positionId, title: S.positionTitle, start_date: S.W,
        schedule_days: [1, 2, 3, 4, 5], schedule_start: '09:00', schedule_end: '17:00', timezone: 'America/New_York', weekly_hours: 40,
        account_manager_id: PRIYA, recruiter_id: NOAH, sales_id: LENA, pay_rate_cents: 700, bill_rate_cents: 1500, currency: 'USD', unit: 'hour' });
      S.placementId = pl.id;
      expect(pl.status).toBe('onboarding');
      expect(pl.worker_reused).toBe(false);
      const full = await am.get(`/api/v1/placements/${S.placementId}`);
      expect(full.candidate_id).toBe(S.candidateId);
      expect(full.monitoring_policy_id).toBeTruthy();
      expect(full.schedule_days).toEqual([1, 2, 3, 4, 5]);
      expect(full.current_rate.pay_rate_cents).toBe(700);
      expect(full.current_rate.bill_rate_cents).toBe(1500);
      S.workerId = full.worker_id;
      expect((await owner.get(`/api/v1/candidates?search=${encodeURIComponent(candEmail)}`)).total).toBe(1);
      const cand = await owner.get(`/api/v1/candidates/${S.candidateId}`);
      expect(cand.worker.id).toBe(S.workerId);
      expect(cand.status).toBe('hired');
      expect((await owner.get(`/api/v1/offers/${S.offerId}`)).placement_id).toBe(S.placementId);
    });

    // ── 9. Activation blocked → required items done (optional left) → activate → seat → explicit invite ──
    let worker: U;
    await test.step('9. Activation blocked with missing items → complete required → activate → seat → invite worker', async () => {
      let items = (await am.get(`/api/v1/placements/${S.placementId}/onboarding`)) as any[];
      if (!items.some(i => !i.required)) await am.post(`/api/v1/placements/${S.placementId}/onboarding`, { title: 'Optional: welcome call with the office manager', required: false, owner: 'client' });
      if (!items.some(i => i.required)) await am.post(`/api/v1/placements/${S.placementId}/onboarding`, { title: 'Signed contractor agreement', required: true });
      items = (await am.get(`/api/v1/placements/${S.placementId}/onboarding`)) as any[];
      const required = items.filter(i => i.required && !i.done_at);
      const optional = items.filter(i => !i.required);
      expect(required.length).toBeGreaterThan(0);
      expect(optional.length).toBeGreaterThan(0);
      const blocked = await am.call('POST', `/api/v1/placements/${S.placementId}/activate`, {});
      expect(blocked.status).toBe(409);
      expect([...blocked.body.details.missing].sort()).toEqual(required.map(i => i.title).sort());
      for (const t of required) expect(blocked.body.error).toContain(t.title);
      for (const it of required) await am.patch(`/api/v1/onboarding/items/${it.id}`, { done: true });
      const act = await am.post(`/api/v1/placements/${S.placementId}/activate`, {});
      expect(act.status).toBe('active');
      const full = await am.get(`/api/v1/placements/${S.placementId}`);
      expect(full.seat?.started_at).toBeTruthy();
      expect(full.seat?.ended_at ?? null).toBeNull();
      expect(full.worker_status).toBe('active');
      const after = (await am.get(`/api/v1/placements/${S.placementId}/onboarding`)) as any[];
      expect(after.filter(i => !i.required).every(i => !i.done_at)).toBe(true); // optional ones left open
      // Activation does not email the worker; the invite is explicit.
      const inv = await am.post(`/api/v1/placements/${S.placementId}/invite`);
      expect(inv.email).toBe(candEmail);
      const token = await inviteTokenFromOutbox(anon, candEmail);
      worker = await U.anon('worker');
      await worker.post(`/api/v1/auth/invitations/${token}/accept`, { password: candPw }); // same person → same login
      await worker.refresh();
      expect(worker.me.workspace.role.kind).toBe('worker');
      expect(worker.me.workspace.workerId).toBe(S.workerId);
      opened.push({ close: () => worker.dispose() });
    });

    // ── 10. Worker: policy → clock in → screenshot → break → clock out; manager sees Live Now & screenshots ──
    await test.step('10. Worker accepts policy, clocks in, screenshot captured, break, clock out; manager sees Live Now + Screenshots', async () => {
      await worker.post('/api/v1/portal/worker/tracker/accept-policy', { placement_id: S.placementId });
      await worker.post('/api/v1/portal/worker/tracker/clock-in', { placement_id: S.placementId, memo: 'Morning inbox + scheduling' });
      await worker.post('/api/v1/portal/worker/tracker/heartbeat', { key_count: 420, mouse_count: 260, active_seconds: 540, idle_seconds: 60, app_label: 'Dentrix' });
      const shot = await worker.ok('POST', '/api/v1/portal/worker/tracker/screenshot', undefined, 200, { multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1x1 }, app_label: 'Dentrix', activity_pct: '88' } });
      S.shotId = shot.id;
      const live = await am.get('/api/v1/time/live');
      const me = live.rows.find((r: any) => r.worker_id === S.workerId);
      expect(me, 'worker on Live Now').toBeTruthy();
      expect(me.status).toBe('working');
      // Real browser: Live Now shows the worker.
      await ownerPage.goto('/time/live');
      await expect(ownerPage.getByText(`Ana Applicant${TAG}`).first()).toBeVisible();
      await worker.post('/api/v1/portal/worker/tracker/break');
      const live2 = await am.get('/api/v1/time/live');
      expect(live2.rows.find((r: any) => r.worker_id === S.workerId).status).toBe('on_break');
      await worker.post('/api/v1/portal/worker/tracker/resume');
      await worker.post('/api/v1/portal/worker/tracker/clock-out', { memo: 'Done for now' });
      const shots = await am.get(`/api/v1/time/screenshots?worker_id=${S.workerId}`);
      expect(shots.rows.some((s: any) => s.id === S.shotId)).toBe(true);
      const act = await am.get(`/api/v1/time/activity?worker_id=${S.workerId}&date=${todayNY()}`, [200]);
      expect(act).toBeTruthy();
    });

    // ── 11. Simulate the week → submitted → client approves in the portal ──
    await test.step('11. Simulate the work week → timesheet submitted → client approves in the portal', async () => {
      const sim = await am.post(`/api/v1/placements/${S.placementId}/simulate-week`, { week_start: S.W, submit: true });
      expect(sim.days).toHaveLength(5);
      expect(sim.submitted).toBe(true);
      S.timesheetId = sim.timesheet.id;
      const pending = await client.get('/api/v1/portal/client/timesheets?awaiting=true');
      expect(pending.rows.some((t: any) => t.id === S.timesheetId)).toBe(true);
      const ap = await client.post(`/api/v1/portal/client/timesheets/${S.timesheetId}/approve`, {});
      expect(ap.final).toBe(true);
      expect(ap.status).toBe('approved');
      const ts = await am.get(`/api/v1/timesheets/${S.timesheetId}`);
      expect(ts.status).toBe('approved');
      S.minutesByDay = Object.fromEntries((ts.days as any[]).filter(d => d.approved_minutes).map(d => [d.date, d.approved_minutes]));
      S.totalMinutes = ap.total_minutes;
      expect(Object.keys(S.minutesByDay)).toHaveLength(5);
    });

    // ── 12. Mid-period rate change → invoice with two rate-period lines → sent → client pays with test card ──
    await test.step('12. Rate change → invoice (two rate-period lines) → sent → paid with test card → AR updated', async () => {
      await finance.post(`/api/v1/placements/${S.placementId}/rates`, { effective_from: S.RATE_CHANGE, pay_rate_cents: 800, bill_rate_cents: 1700, reason: 'Mid-period raise (e2e)' });
      const inv = (await finance.post('/api/v1/invoices', { company_id: S.companyId, period_start: S.W, period_end: S.WEND, placement_ids: [S.placementId] })).invoice;
      S.invoiceId = inv.id;
      const det = await finance.get(`/api/v1/invoices/${S.invoiceId}`);
      const lines = (det.lines as any[]).filter(l => l.placement_id === S.placementId);
      expect(lines).toHaveLength(2);
      const days = Object.entries(S.minutesByDay as Record<string, number>);
      const before = days.filter(([d]) => d < S.RATE_CHANGE).reduce((a, [, m]) => a + m, 0);
      const afterM = days.filter(([d]) => d >= S.RATE_CHANGE).reduce((a, [, m]) => a + m, 0);
      const l1 = lines.find(l => Number(l.unit_price_cents) === 1500), l2 = lines.find(l => Number(l.unit_price_cents) === 1700);
      expect(l1 && l2, 'one line per rate period').toBeTruthy();
      expect(Number(l1.minutes)).toBe(before);
      expect(Number(l2.minutes)).toBe(afterM);
      expect(Number(l1.amount_cents)).toBe(divHalfUp(1500 * before, 60));
      expect(Number(l2.amount_cents)).toBe(divHalfUp(1700 * afterM, 60));
      S.revenueCents = Number(l1.amount_cents) + Number(l2.amount_cents);
      await finance.post(`/api/v1/invoices/${S.invoiceId}/approve`);
      const sent = await finance.post(`/api/v1/invoices/${S.invoiceId}/send`);
      expect(sent.sent_to).toBe(contactEmail);
      S.totalCents = Number(sent.invoice.total_cents);
      const arBefore = await finance.get('/api/v1/finance/ar');
      expect(arBefore.clients.find((c: any) => c.company_id === S.companyId)?.total_cents).toBe(S.totalCents);
      // Client sees it in the portal and pays on the public pay page with the test card.
      const cinv = await client.get('/api/v1/portal/client/invoices?status=open');
      const mine = cinv.rows.find((r: any) => r.id === S.invoiceId);
      expect(mine?.pay_url).toMatch(/^\/pay\//);
      const token = mine.pay_url.split('/').pop();
      const pubPay = await U.anon('payer');
      const page = await pubPay.get(`/api/v1/public/pay/${token}`);
      expect(page.payable).toBe(true);
      expect(Number(page.invoice.balance_cents)).toBe(S.totalCents);
      const paid = await pubPay.post(`/api/v1/public/pay/${token}`, { card_number: '4242 4242 4242 4242', exp: '12/30', cvc: '123', name: `Erin Client${CAP}`, email: contactEmail });
      await pubPay.dispose();
      expect(paid.status).toBe('succeeded');
      expect(paid.invoice.status).toBe('paid');
      expect(Number(paid.invoice.balance_cents)).toBe(0);
      const after = await finance.get(`/api/v1/invoices/${S.invoiceId}`);
      const a = after.invoice ?? after;
      expect(a.status).toBe('paid');
      expect(Number(a.paid_cents)).toBe(S.totalCents);
      const arAfter = await finance.get('/api/v1/finance/ar');
      expect(arAfter.clients.find((c: any) => c.company_id === S.companyId)).toBeUndefined();
    });

    // ── 13. Payroll → approve → payout batch completes → worker sees the payslip ──
    await test.step('13. Payroll run → approve → payout completes → worker sees payslip', async () => {
      payoutFailureRate = (await finance.get('/api/v1/payouts/simulation')).failure_rate;
      await finance.put('/api/v1/payouts/simulation', { failure_rate: 0 });
      const created = await finance.post('/api/v1/payroll/runs', { period_start: S.W, period_end: S.WEND, notes: `e2e ${RUN}` });
      expect(created.existing).toBe(false);
      S.runId = created.run.id;
      let det = await finance.get(`/api/v1/payroll/runs/${S.runId}`);
      const item = det.items.find((i: any) => i.placement_id === S.placementId);
      expect(item, 'payroll item for the worker').toBeTruthy();
      expect(item.regular_minutes + item.ot_minutes).toBe(S.totalMinutes);
      S.costCents = Number(item.regular_cents) + Number(item.ot_cents);
      S.payrollItemId = item.id; S.payslipNumber = item.payslip_number;
      await finance.post(`/api/v1/payroll/runs/${S.runId}/submit`);
      expect((await finance.post(`/api/v1/payroll/runs/${S.runId}/approve`)).run.status).toBe('approved');
      const po = await finance.post(`/api/v1/payroll/runs/${S.runId}/payout`);
      expect(po.duplicate).toBe(false);
      await expect.poll(async () => (await finance.get(`/api/v1/payroll/runs/${S.runId}`)).run.status, { timeout: 90_000, intervals: [2000] }).toBe('paid');
      det = await finance.get(`/api/v1/payroll/runs/${S.runId}`);
      expect(det.items.find((i: any) => i.id === S.payrollItemId).pay_status).toBe('paid');
      const pay = await worker.get('/api/v1/portal/worker/pay');
      const slip = pay.payslips.find((p: any) => p.id === S.payrollItemId);
      expect(slip?.status).toBe('paid');
      const pdf = await worker.rc.get(`/api/v1/portal/worker/pay/payslips/${S.payrollItemId}/pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('pdf');
      // Real browser: the worker's Pay page lists the payslip.
      const wctx = await browserAs(browser, worker); opened.push(wctx);
      const wp = await wctx.newPage();
      await wp.goto('/portal/worker/pay');
      await expect(wp.getByText(S.payslipNumber).first()).toBeVisible();
      await wctx.close();
    });

    // ── 14. Margin + commissions match the formula; entitlements approved ──
    await test.step('14. Margin and commissions match the formula; entitlements approved', async () => {
      const gp = S.revenueCents - S.costCents;
      expect(gp).toBeGreaterThan(0);
      const m = await finance.get(`/api/v1/margin?from=${S.W}&to=${S.WEND}&group_by=placement&basis=billed&pageSize=500`);
      const row = m.rows.find((r: any) => r.id === S.placementId);
      expect(row, 'margin row for placement').toBeTruthy();
      expect(row.revenue_cents).toBe(S.revenueCents); // = invoice time lines
      expect(row.cost_cents).toBe(S.costCents); // = payroll time pay
      expect(row.gp_cents).toBe(gp);
      await finance.post('/api/v1/commissions/compute', { month: S.month });
      const rules = (await finance.get('/api/v1/commissions/rules')).rows.filter((r: any) => r.active);
      const ents = (await finance.get(`/api/v1/commissions?month=${S.month}&pageSize=1000`)).rows.filter((e: any) => e.placement_id === S.placementId);
      // Formula (brief §8): commission = rule applied to GP (billed revenue − worker cost of the same approved days).
      // The placement starts in this month → monthsSinceStart = 0 and it is the first period (fixed bonuses apply).
      const holder: Record<string, string> = { recruiter: NOAH, sales: LENA, account_manager: PRIYA };
      const formula = (r: any): number => {
        if (r.kind === 'fixed') return Number(r.fixed_cents ?? 0);
        if (r.kind === 'pct_gp') return applyBp(gp, r.pct_bp ?? 0);
        let remaining = gp, prev = 0, total = 0; // tiered (marginal)
        for (const t of r.tiers ?? []) { const cap = t.upToCents ?? Infinity; const slice = Math.max(0, Math.min(remaining, cap - prev)); total += applyBp(slice, t.pctBp); remaining -= slice; prev = cap; if (remaining <= 0) break; }
        return total;
      };
      const expected = rules.flatMap((r: any) => {
        const user = holder[r.applies_to];
        if (!user || (r.user_id && r.user_id !== user)) return [];
        const amount = formula(r);
        return amount ? [{ rule_id: r.id, user_id: user, amount }] : [];
      });
      expect(expected.length).toBeGreaterThan(0);
      expect(ents).toHaveLength(expected.length);
      for (const e of expected) {
        const got = ents.find((x: any) => x.rule_id === e.rule_id);
        expect(got, `entitlement for rule ${e.rule_id}`).toBeTruthy();
        expect(got.user_id).toBe(e.user_id);
        expect(Number(got.calculated_cents)).toBe(e.amount);
        expect(Number(got.gp_cents)).toBe(gp);
        expect(Number(got.revenue_cents)).toBe(S.revenueCents);
        expect(Number(got.cost_cents)).toBe(S.costCents);
      }
      expect(ents.map((e: any) => e.user_id).sort()).toEqual([NOAH, LENA, PRIYA].sort()); // recruiter, sales and AM all earn
      for (const e of ents.filter((x: any) => x.status === 'calculated')) {
        const r = await finance.post(`/api/v1/commissions/${e.id}/approve`, {});
        expect(r.entitlement.status).toBe('approved');
      }
      S.entitlementIds = ents.map((e: any) => e.id);
    });

    // ── 15. Replacement started, original offboarded; history stays visible ──
    await test.step('15. Replacement placement started, original offboarded; all history still visible', async () => {
      const repl = await owner.post('/api/v1/candidates', { first_name: 'Rafael', last_name: `Replacement${CAP}`, email: `rafa.${TAG}@e2e-cand.test`, phone: `+52 55 ${String(Date.now()).slice(-8, -4)} ${String(Date.now()).slice(-4)}`, country: 'Mexico', skills: ['Scheduling'] });
      const today = todayNY();
      const rp = await am.post('/api/v1/placements', { candidate_id: repl.id, company_id: S.companyId, position_id: S.positionId, title: S.positionTitle, start_date: today, replaces_placement_id: S.placementId,
        schedule_days: [1, 2, 3, 4, 5], schedule_start: '09:00', schedule_end: '17:00', timezone: 'America/New_York', weekly_hours: 40, account_manager_id: PRIYA, recruiter_id: NOAH, sales_id: LENA, pay_rate_cents: 800, bill_rate_cents: 1700, currency: 'USD', unit: 'hour' });
      expect(rp.replaces_placement_id).toBe(S.placementId);
      S.replacementId = rp.id;
      const off = await am.post(`/api/v1/placements/${S.placementId}/offboard`, { end_date: today, reason: 'Replaced at client request (e2e)', final_timesheet: true });
      expect(off.scheduled ?? false).toBe(false);
      const pl = await am.get(`/api/v1/placements/${S.placementId}`);
      expect(pl.status).toBe('ended');
      expect(pl.seat?.ended_at).toBeTruthy();
      expect(pl.related.some((r: any) => r.id === S.replacementId)).toBe(true);
      // History remains: timesheets, invoice, payroll, rates, timeline.
      const ts = await am.get(`/api/v1/timesheets?placement_id=${S.placementId}`);
      expect(ts.rows.some((t: any) => t.id === S.timesheetId)).toBe(true);
      expect((await finance.get(`/api/v1/invoices/${S.invoiceId}`)).lines.length).toBeGreaterThan(0);
      expect((await finance.get(`/api/v1/payroll/runs/${S.runId}`)).items.some((i: any) => i.id === S.payrollItemId)).toBe(true);
      expect((await finance.get(`/api/v1/placements/${S.placementId}/rates`)).rates).toHaveLength(2);
      const tl = await am.get(`/api/v1/timeline/placement/${S.placementId}`);
      const titles = (Array.isArray(tl) ? tl : tl.rows).map((a: any) => a.title).join(' | ');
      expect(titles).toContain('Offboarded');
      expect(titles).toContain('Worker activated');
      expect((await worker.get('/api/v1/portal/worker/pay')).payslips.some((p: any) => p.id === S.payrollItemId)).toBe(true);
      expect((await am.get(`/api/v1/placements/${S.replacementId}`)).related.some((r: any) => r.id === S.placementId)).toBe(true);
    });

    // ── 16. Owner switches to Harbor Assist and back in the sidebar switcher ──
    await test.step('16. Owner switches workspace to Harbor Assist and back (no MAGA Hire data visible)', async () => {
      await ownerPage.goto('/');
      await ownerPage.getByRole('button', { name: 'Switch workspace' }).click();
      await ownerPage.getByRole('menuitem', { name: /Harbor Assist/ }).click();
      await expect(ownerPage.getByRole('button', { name: 'Switch workspace' })).toContainText('Harbor Assist');
      const r = ownerPage.request;
      const me = await (await r.get('/api/v1/auth/me')).json();
      expect(me.workspace.org.slug).toBe('harbor-assist');
      expect((await r.get(`/api/v1/placements/${S.placementId}`)).status()).toBe(404);
      expect((await r.get(`/api/v1/candidates/${S.candidateId}`)).status()).toBe(404);
      expect((await r.get(`/api/v1/invoices/${S.invoiceId}`)).status()).toBe(404);
      expect((await (await r.get(`/api/v1/candidates?search=${encodeURIComponent(candEmail)}`)).json()).total).toBe(0);
      expect((await (await r.get(`/api/v1/placements?search=${encodeURIComponent(`Applicant${TAG}`)}`)).json()).total).toBe(0);
      expect((await (await r.get(`/api/v1/time/live`)).json()).rows.some((x: any) => x.worker_id === S.workerId)).toBe(false);
      // UI: the MAGA Hire placement URL shows nothing from MAGA Hire inside Harbor Assist.
      await ownerPage.goto(`/workforce/placements/${S.placementId}`);
      await ownerPage.waitForLoadState('networkidle');
      expect(await ownerPage.locator('body').innerText()).not.toContain(`Applicant${TAG}`);
      await ownerPage.goto('/workforce/placements');
      await ownerPage.waitForLoadState('networkidle');
      expect(await ownerPage.locator('body').innerText()).not.toContain(clientName);
      // Switch back without logging out.
      await ownerPage.getByRole('button', { name: 'Switch workspace' }).click();
      await ownerPage.getByRole('menuitem', { name: /MAGA Hire/ }).click();
      await expect(ownerPage.getByRole('button', { name: 'Switch workspace' })).toContainText('MAGA Hire');
      expect((await (await r.get('/api/v1/auth/me')).json()).workspace.org.slug).toBe(SLUG);
      expect((await r.get(`/api/v1/placements/${S.placementId}`)).status()).toBe(200);
    });

    // ── 17. Negative tests ──
    await test.step('17. Negative tests (scope, comp, portals, tenants, screenshots)', async () => {
      // Recruiter (Assigned scope) cannot edit an unassigned position.
      const open = (await owner.get('/api/v1/positions?status=open&pageSize=200')).rows as any[];
      const unassigned = open.find(p => !(p.recruiters ?? []).some((r: any) => r.id === NOAH));
      expect(unassigned, 'an open position not assigned to Noah').toBeTruthy();
      expect([403, 404]).toContain(await noah.status('PATCH', `/api/v1/positions/${unassigned.id}`, { title: `${unassigned.title} (hacked)` }));
      expect([403, 404]).toContain(await noah.status('POST', `/api/v1/positions/${unassigned.id}/status`, { status: 'on_hold' }));
      expect((await owner.get(`/api/v1/positions/${unassigned.id}`)).title).toBe(unassigned.title);
      // Recruiter cannot see pay rates.
      expect([403, 404]).toContain(await noah.status('GET', `/api/v1/placements/${S.replacementId}/rates`));
      expect([403, 404]).toContain(await noah.status('GET', '/api/v1/rates'));
      const npl = await noah.get(`/api/v1/placements/${S.replacementId}`);
      expect(npl.current_rate?.pay_rate_cents).toBeUndefined();
      expect(npl.current_rate?.bill_rate_cents).toBeUndefined();
      expect(JSON.stringify(npl)).not.toMatch(/"pay_rate_cents":\s*\d/);
      // Client cannot call internal APIs.
      for (const p of ['/api/v1/leads', '/api/v1/placements', `/api/v1/candidates/${S.candidateId}`, '/api/v1/invoices', '/api/v1/payroll/runs', '/api/v1/time/live']) expect(await client.status('GET', p), `client GET ${p}`).toBe(404);
      expect(await client.status('POST', `/api/v1/placements/${S.replacementId}/activate`, {})).toBe(404);
      // Harbor Assist user gets 404 on MAGA Hire record URLs.
      const harbor = await U.login('rosa.delgado@veyro.demo'); opened.push({ close: () => harbor.dispose() });
      expect(harbor.me.workspace.org.slug).toBe('harbor-assist');
      for (const p of [`/api/v1/placements/${S.placementId}`, `/api/v1/candidates/${S.candidateId}`, `/api/v1/invoices/${S.invoiceId}`, `/api/v1/positions/${S.positionId}`, `/api/v1/payroll/runs/${S.runId}`, `/api/v1/workers/${S.workerId}`])
        expect(await harbor.status('GET', p), `harbor GET ${p}`).toBe(404);
      // A worker cannot see another worker's screenshots.
      const jose = await U.login('worker@veyro.demo'); opened.push({ close: () => jose.dispose() });
      expect(await jose.status('GET', `/api/v1/time/screenshots?worker_id=${S.workerId}`)).toBe(404);
      const joseShots = await jose.get('/api/v1/portal/worker/screenshots');
      expect(joseShots.rows.some((s: any) => s.id === S.shotId)).toBe(false);
      expect(await jose.status('DELETE', `/api/v1/portal/worker/screenshots/${S.shotId}`)).toBe(404);
      const joseWorkerId = jose.me.workspace.workerId;
      expect(await worker.status('GET', `/api/v1/time/screenshots?worker_id=${joseWorkerId}`)).toBe(404);
    });

    // ── 18. Audit log ──
    await test.step('18. Audit log has rate change, approvals, activation, payroll approval and workspace actions', async () => {
      const find = async (action: string, pred: (a: any) => boolean = () => true) => {
        const r = await owner.get(`/api/v1/audit?action=${encodeURIComponent(action)}&from=${startedAt.slice(0, 10)}&pageSize=200`);
        return (r.rows as any[]).filter(a => a.action === action && new Date(a.created_at) >= new Date(startedAt) && pred(a));
      };
      expect(await find('rate.created', a => a.entity_id === S.placementId)).toHaveLength(1);
      expect((await find('offer.approved', a => a.entity_id === S.offerId)).length).toBe(1);
      expect((await find('timesheet.approved', a => a.entity_id === S.timesheetId)).length).toBe(1);
      expect((await find('commission.approved', a => S.entitlementIds.includes(a.entity_id))).length).toBeGreaterThan(0);
      expect((await find('placement.activated', a => a.entity_id === S.placementId)).length).toBe(1);
      expect((await find('seat.started', a => a.entity_id === S.placementId)).length).toBe(1);
      expect((await find('payroll.approved', a => a.entity_id === S.runId)).length).toBe(1);
      const ownerId = owner.userId;
      expect((await find('workspace.switched_out', a => a.actor_id === ownerId)).length).toBeGreaterThanOrEqual(1);
      expect((await find('workspace.switched_in', a => a.actor_id === ownerId)).length).toBeGreaterThanOrEqual(1);
    });
  } finally {
    if (payoutFailureRate !== null) await finance.put('/api/v1/payouts/simulation', { failure_rate: payoutFailureRate }).catch(() => null);
    for (const o of opened.reverse()) await o.close().catch(() => null);
    for (const u of [sales, noah, finance, am]) await u.dispose().catch(() => null);
  }
});
