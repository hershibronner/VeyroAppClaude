// Public client sign-up (Leads → Generate link): one question per screen; the submission becomes a Lead.
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Rocket, Clock, Users, Building2, Stethoscope, Home, ShieldCheck, ShoppingBag, Scale, Megaphone, Calculator, Sparkles, Sun, Moon, Globe2, CalendarClock, Zap, CalendarDays, Compass, Briefcase, Layers } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money } from '../../lib/format';
import { Flow, useFlowIndex, Choices, NumberPicker, RangeSlider, ChipPicker, FlowInput, FlowTextarea, Confetti, DoneMark, type FlowStep } from '../../components/Flow';

const INDUSTRY_ICON: Record<string, any> = { dental: Stethoscope, real_estate: Home, insurance: ShieldCheck, ecommerce: ShoppingBag, law: Scale, marketing: Megaphone, accounting: Calculator, other: Sparkles };
const TIMELINES = [
  { value: 'asap', label: 'As soon as possible', desc: 'We need help this week', icon: <Zap size={18} /> },
  { value: 'two_weeks', label: 'Within 2 weeks', icon: <CalendarClock size={18} /> },
  { value: 'month', label: 'Within a month', icon: <CalendarDays size={18} /> },
  { value: 'exploring', label: 'Just exploring', desc: 'Show me what is possible', icon: <Compass size={18} /> },
];
const HOURS = [
  { value: 'US Eastern business hours', label: 'US Eastern hours', icon: <Sun size={18} /> },
  { value: 'US Central business hours', label: 'US Central hours', icon: <Sun size={18} /> },
  { value: 'US Mountain/Pacific business hours', label: 'US Mountain / Pacific', icon: <Sun size={18} /> },
  { value: 'Overnight / after hours', label: 'Overnight / after hours', icon: <Moon size={18} /> },
  { value: 'Flexible', label: 'Flexible', desc: 'Any time zone works', icon: <Globe2 size={18} /> },
];
const usd = (c: number) => money(c, 'USD', { noCents: c % 100 === 0 });

export default function IntakeFlow() {
  const { slug, token } = useParams();
  const cfg = useApi<any>(`/api/v1/public/intake/${slug}${token ? `?token=${encodeURIComponent(token)}` : ''}`, [slug, token]);
  const [v, setV] = useState<Record<string, any>>({ first_name: '', last_name: '', email: '', company: '', website: '', title: '', industry: null, vas: 2, roles: [], roles_other: '', tasks: [], employment: 'full_time', hours: '', rate_min_cents: 600, rate_max_cents: 1200, timeline: null, phone: '', notes: '', consent: false });
  const set = (k: string, val: any) => setV(s => ({ ...s, [k]: val }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  const d = cfg.data;
  const roleOptions = useMemo(() => {
    if (!d) return [];
    const specific = (v.industry && d.roles_by_industry[v.industry]) || [];
    return [...new Set([...specific, ...d.general_roles])];
  }, [d, v.industry]);

  const steps: FlowStep[] = !d ? [] : [
    { id: 'welcome', bare: true, cta: "Let's go", title: <>Let's build your <span className="grad">remote team</span>.</>,
      hint: <>Tell {d.org.name} what you need — it takes about two minutes. {d.link?.owner_first_name ? `${d.link.owner_first_name} will personally follow up.` : 'A specialist will follow up within one business day.'}</>,
      body: <div className="flow-welcome-meta"><span><Clock size={15} /> 2 minutes</span><span><Users size={15} /> Vetted remote staff</span><span><Rocket size={15} /> Start in days</span></div> },
    { id: 'name', title: "First things first — what's your name?", validate: () => (v.first_name.trim() ? null : 'Please tell us your first name'),
      body: <div className="flow-row2"><FlowInput label="First name" autoComplete="given-name" value={v.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" /><FlowInput label="Last name" autoComplete="family-name" value={v.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" /></div> },
    { id: 'email', title: <>Nice to meet you{v.first_name ? `, ${v.first_name}` : ''}! What's your work email?</>, hint: "We'll send a copy of your answers here.", validate: () => (/^\S+@\S+\.\S+$/.test(v.email.trim()) ? null : 'Enter a valid email address'),
      body: <FlowInput type="email" autoComplete="email" inputMode="email" value={v.email} onChange={e => set('email', e.target.value)} placeholder="jane@company.com" /> },
    { id: 'company', title: 'Which company are you hiring for?', validate: () => (v.company.trim().length >= 2 ? null : 'Tell us your company name'),
      body: <><FlowInput label="Company name" autoComplete="organization" value={v.company} onChange={e => set('company', e.target.value)} placeholder="Acme Dental" /><div className="flow-row2"><FlowInput label="Website (optional)" value={v.website} onChange={e => set('website', e.target.value)} placeholder="acmedental.com" /><FlowInput label="Your role (optional)" autoComplete="organization-title" value={v.title} onChange={e => set('title', e.target.value)} placeholder="Practice manager" /></div></> },
    { id: 'industry', title: <>What does {v.company || 'your company'} do?</>, hint: 'Press a letter key or click.', validate: () => (v.industry ? null : 'Pick the closest match'), noCta: false,
      body: <Choices value={v.industry} onChange={x => set('industry', x)} onPicked={() => flow.next()} options={d.industries.map((i: any) => { const Ic = INDUSTRY_ICON[i.key] ?? Building2; return { value: i.key, label: i.label, icon: <Ic size={18} /> }; })} /> },
    { id: 'vas', title: 'How many virtual assistants do you need?', hint: 'A rough number is fine — you can always add more later.',
      body: <NumberPicker value={v.vas} onChange={n => set('vas', n)} min={1} max={50} quick={[1, 2, 3, 5, 10, 50]} unit={n => (n === 1 ? 'assistant' : 'assistants')} /> },
    { id: 'roles', title: 'Which roles should we fill?', hint: 'Choose all that apply.', validate: () => (v.roles.length || v.roles_other.trim() ? null : 'Pick at least one role'),
      body: <><Choices multiple value={v.roles} onChange={x => set('roles', x)} options={roleOptions.map((r: string) => ({ value: r, label: r, icon: <Briefcase size={17} /> }))} /><FlowInput label="Something else?" value={v.roles_other} onChange={e => set('roles_other', e.target.value)} placeholder="e.g. Spanish-speaking receptionist" /></> },
    { id: 'tasks', title: 'What kind of work will they do day to day?', hint: 'Tap everything that fits, or add your own.', optional: true,
      body: <ChipPicker options={d.tasks} value={v.tasks} onChange={x => set('tasks', x)} /> },
    { id: 'schedule', title: 'When should they work?', validate: () => (v.hours ? null : 'Pick the hours that suit you'),
      body: <><Choices columns={3} value={v.employment} onChange={x => set('employment', x)} options={[{ value: 'full_time', label: 'Full-time', desc: '~40 h/week', icon: <Clock size={17} /> }, { value: 'part_time', label: 'Part-time', desc: '~20 h/week', icon: <Clock size={17} /> }, { value: 'mixed', label: 'A mix', icon: <Layers size={17} /> }]} />
        <div style={{ height: 14 }} /><select className="flow-select" aria-label="Working hours" value={v.hours} onChange={e => set('hours', e.target.value)}><option value="">Which hours?</option>{HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}</select></> },
    { id: 'budget', title: "What's your budget per assistant, per hour?", hint: 'Drag both handles. Rates depend on skills and experience — we will match you to people in this range.',
      validate: () => (v.rate_max_cents >= v.rate_min_cents ? null : 'Max must be at least your min'),
      body: <><RangeSlider min={300} max={4000} step={50} low={v.rate_min_cents} high={v.rate_max_cents} onChange={(lo, hi) => setV(s => ({ ...s, rate_min_cents: lo, rate_max_cents: hi }))} format={usd} labels={['Min per hour', 'Max per hour']} />
        <p className="flow-hint" style={{ fontSize: 15 }}>≈ {money(Math.round(((v.rate_min_cents + v.rate_max_cents) / 2) * (v.employment === 'part_time' ? 80 : 160) * v.vas), 'USD', { noCents: true })} per month for {v.vas} {v.vas === 1 ? 'assistant' : 'assistants'}</p></> },
    { id: 'timeline', title: 'When would you like them to start?', validate: () => (v.timeline ? null : 'Pick a timeline'),
      body: <Choices value={v.timeline} onChange={x => set('timeline', x)} onPicked={() => flow.next()} options={TIMELINES as any} /> },
    { id: 'phone', title: "What's the best number to reach you?", hint: 'Optional — for a quick 15-minute call.', optional: true,
      body: <FlowInput type="tel" autoComplete="tel" inputMode="tel" value={v.phone} onChange={e => set('phone', e.target.value)} placeholder="+1 555 123 4567" /> },
    { id: 'notes', title: 'Anything else we should know?', hint: 'Tools you use, languages, must-haves… (optional)', optional: true, enterNeedsMod: true,
      body: <FlowTextarea value={v.notes} onChange={e => set('notes', e.target.value)} placeholder="We use Dentrix and need someone comfortable on the phone with patients." /> },
    { id: 'review', title: 'Looks great — anything to change?', cta: 'Send my request', validate: () => (v.consent ? null : 'Please agree so we can contact you'),
      body: <>
        <div className="flow-review">
          {[['Name', `${v.first_name} ${v.last_name}`.trim(), 1], ['Email', v.email, 2], ['Company', [v.company, v.website].filter(Boolean).join(' · '), 3], ['Industry', d.industries.find((i: any) => i.key === v.industry)?.label, 4],
            ['Assistants', String(v.vas), 5], ['Roles', [...v.roles, v.roles_other].filter(Boolean).join(', '), 6], ['Work', v.tasks.join(', ') || '—', 7], ['Schedule', `${v.employment.replace('_', '-')} · ${v.hours || '—'}`, 8],
            ['Budget', `${usd(v.rate_min_cents)} – ${usd(v.rate_max_cents)} / hour`, 9], ['Start', TIMELINES.find(t => t.value === v.timeline)?.label, 10], ['Phone', v.phone || '—', 11]].map(([k, val, idx], i) =>
            <div key={k as string} className="flow-review-row" style={{ ['--d' as any]: `${i * 40 + 200}ms` }}><span>{k}</span><b>{val || '—'}</b><button type="button" onClick={() => flow.go(idx as number)}>Edit</button></div>)}
        </div>
        <label className="flow-consent"><input type="checkbox" checked={v.consent} onChange={e => set('consent', e.target.checked)} /> I agree that {d.org.name} may contact me about my request.</label>
      </> },
    { id: 'done', bare: true, noCta: true, title: <>Thank you, {done?.first_name ?? v.first_name}! 🎉</>,
      hint: <>{done?.owner_first_name ? `${done.owner_first_name} from ${d.org.name}` : `A ${d.org.name} specialist`} will reach out within one business day about your {v.vas} {v.vas === 1 ? 'assistant' : 'assistants'}. We emailed a copy of your answers to {v.email}.</>,
      body: <><Confetti colors={[d.org.primary_color, d.org.accent_color, '#1FAE5B', '#F59E0B']} /><DoneMark /><div className="flow-cardlet"><b>What happens next</b><ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8, color: 'var(--soft)' }}><li>A quick call to understand the role</li><li>We shortlist vetted candidates in your budget</li><li>You interview your favourites — and start</li></ol></div></> },
  ];
  const flow = useFlowIndex(steps.length || 1);

  if (cfg.error) return <FlowMessage title="This sign-up page doesn't exist" text="Check the link you were given." />;
  if (!d) return <FlowMessage title="Loading…" />;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/api/v1/public/intake/${slug}/submit`, { ...v, token: token ?? null, industry: v.industry ?? 'other', timeline: v.timeline ?? 'exploring' });
      setDone(r); flow.next();
    } catch (e) {
      if (e instanceof ApiError && e.fields) { const k = Object.keys(e.fields)[0]; setErr(e.fields[k]); const map: Record<string, string> = { first_name: 'name', email: 'email', company: 'company', roles: 'roles', rate_max_cents: 'budget', consent: 'review' }; const to = steps.findIndex(s => s.id === map[k]); if (to >= 0) flow.go(to); }
      else setErr(e instanceof ApiError ? e.message : 'Something went wrong — please try again.');
    } finally { setBusy(false); }
  };
  const onAdvance = () => { setErr(null); if (steps[flow.index].id === 'review') submit(); else flow.next(); };
  return (
    <Flow brand={d.org} steps={steps} index={flow.index} dir={flow.dir} onAdvance={onAdvance} onBack={() => { setErr(null); flow.back(); }} busy={busy} error={err}
      topRight={d.link_inactive ? <span className="small" style={{ color: 'var(--soft)' }}>This link has expired — your request still reaches the team.</span> : undefined} />
  );
}

export function FlowMessage({ title, text }: { title: string; text?: string }) {
  return <div className="flow" style={{ alignItems: 'center', justifyContent: 'center' }}><div style={{ textAlign: 'center', padding: 24 }}><h1 className="flow-title">{title}</h1>{text && <p className="flow-hint">{text}</p>}</div></div>;
}
