import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, X, ShieldCheck, KeyRound, ScrollText, Lock, Building2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import './landing.css';

/* Public marketing page (/home): what VeyroApp is, before you sign in. Pure CSS/canvas animation, no extra libraries;
   everything respects prefers-reduced-motion. CTAs: Get started (→ /register) and Contact us (centered dialog). */

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/** 0 → 1 as the element scrolls through the viewport (0 when its top hits the bottom of the screen). */
function useScrollProgress<T extends HTMLElement>(mode: 'through' | 'pinned' = 'through') {
  const ref = useRef<T>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0; const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect(); const vh = window.innerHeight;
      const v = mode === 'pinned' ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (vh + r.height);
      setP(prev => { const n = clamp(v); return Math.abs(n - prev) > 0.001 ? n : prev; });
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    tick(); window.addEventListener('scroll', on, { passive: true }); window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, [mode]);
  return [ref, p] as const;
}

/** Adds `.in` to every [data-reveal] element the first time it enters the viewport. */
function useReveal(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const els = root.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? [];
    if (reduced()) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
    els.forEach(e => io.observe(e)); return () => io.disconnect();
  }, [root]);
}

function useInView<T extends HTMLElement>(margin = '0px') {
  const ref = useRef<T>(null); const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: margin });
    io.observe(el); return () => io.disconnect();
  }, [margin]);
  return [ref, seen] as const;
}

/** Text that resolves out of random glyphs, left to right. */
const GLYPHS = '_]>|$<%/:*-&[=!#+0123456789';
function Scramble({ text, delay = 0, speed = 28, className }: { text: string; delay?: number; speed?: number; className?: string }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const [out, setOut] = useState(reduced() ? text : text.replace(/\S/g, ' '));
  useEffect(() => {
    if (!seen || reduced()) { if (reduced()) setOut(text); return; }
    let frame = 0; let t: any;
    const start = setTimeout(() => {
      t = setInterval(() => {
        frame++;
        const done = Math.floor(frame / 2);
        setOut(text.split('').map((c, i) => (c === ' ' || i < done ? c : i < done + 6 ? GLYPHS[(Math.random() * GLYPHS.length) | 0] : ' ')).join(''));
        if (done >= text.length) clearInterval(t);
      }, speed);
    }, delay);
    return () => { clearTimeout(start); clearInterval(t); };
  }, [seen, text, delay, speed]);
  return <span ref={ref} className={className} aria-label={text}><span aria-hidden>{out}</span></span>;
}

function CountUp({ to, from = 0, dur = 1400, prefix = '', suffix = '' }: { to: number; from?: number; dur?: number; prefix?: string; suffix?: string }) {
  const [ref, seen] = useInView<HTMLSpanElement>('-10% 0px');
  const [v, setV] = useState(from);
  useEffect(() => {
    if (!seen) return; if (reduced()) { setV(to); return; }
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const k = clamp((t - t0) / dur); const e = 1 - Math.pow(1 - k, 3); setV(Math.round(from + (to - from) * e)); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [seen, to, from, dur]);
  return <span ref={ref}>{prefix}{v.toLocaleString()}{suffix}</span>;
}

/* ───────────── Hero: a field of dashes rippling out from the center and away from the cursor ───────────── */
function HeroField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!; const ctx = cv.getContext('2d')!;
    let w = 0, h = 0, dpr = 1, raf = 0, running = true;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
    const size = () => { dpr = Math.min(2, window.devicePixelRatio || 1); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    const move = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top; };
    const leave = () => { mouse.tx = -9999; mouse.ty = -9999; };
    window.addEventListener('resize', size); window.addEventListener('pointermove', move); document.addEventListener('pointerleave', leave);
    const io = new IntersectionObserver(([e]) => { running = e.isIntersecting; if (running && !raf) raf = requestAnimationFrame(draw); });
    io.observe(cv);
    const gx = 22, gy = 30;
    const t0 = performance.now();
    function draw(now: number) {
      raf = 0; if (!running) return;
      const t = reduced() ? 2.4 : (now - t0) / 1000;
      mouse.x += (mouse.tx - mouse.x) * 0.12; mouse.y += (mouse.ty - mouse.y) * 0.12;
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.5, cy = h * 0.42; const maxR = Math.hypot(w, h) * 0.6;
      for (let x = gx / 2; x < w; x += gx) {
        for (let y = gy / 2; y < h; y += gy) {
          const d = Math.hypot(x - cx, y - cy);
          const ring = Math.sin(d / 46 - t * 1.6);                         // concentric waves
          let a = Math.pow(Math.max(0, ring), 3) * (1 - d / maxR);
          const md = Math.hypot(x - mouse.x, y - mouse.y);
          const push = Math.max(0, 1 - md / 160);                          // cursor ripple
          a = Math.max(a, push * 0.9);
          const len = 8 + a * 22;
          const fade = clamp(1.15 - y / h);                                // dim toward the bottom
          const hot = ((x * 7 + y * 13) | 0) % 97 === 0 && ring > 0.92;    // rare blue sparks
          ctx.fillStyle = hot || push > 0.55 ? `rgba(30,110,243,${clamp(a * 1.4) * fade})` : `rgba(160,170,190,${clamp(0.12 + a) * fade})`;
          ctx.fillRect(x - 1.25, y - len / 2 + Math.sin(t * 2 + x * 0.02) * push * 6, 2.5, len);
        }
      }
      if (!reduced()) raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('resize', size); window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); };
  }, []);
  return <canvas ref={ref} className="lp-field" aria-hidden />;
}

/* ───────────── Isometric module stack (the "all in one" story) ───────────── */
const LAYERS = [
  { key: 'crm', label: 'CRM & Leads', top: '#FFFFFF', left: '#D9DEE8', right: '#B9C1D1' },
  { key: 'rec', label: 'Recruiting + AI', top: '#1E6EF3', left: '#1558C7', right: '#0F449C' },
  { key: 'wf', label: 'Placements', top: '#1B1F27', left: '#0E1116', right: '#06080B' },
  { key: 'time', label: 'Time tracking', top: '#FFFFFF', left: '#D9DEE8', right: '#B9C1D1' },
  { key: 'pay', label: 'Payroll & Billing', top: '#1E6EF3', left: '#1558C7', right: '#0F449C' },
];
function Slab({ y, c, studs, w = 130, t = 26 }: { y: number; c: typeof LAYERS[number]; studs: boolean; w?: number; t?: number }) {
  const cx = 200, hh = w / 2;
  const top = `${cx},${y - hh} ${cx + w},${y} ${cx},${y + hh} ${cx - w},${y}`;
  const left = `${cx - w},${y} ${cx},${y + hh} ${cx},${y + hh + t} ${cx - w},${y + t}`;
  const right = `${cx + w},${y} ${cx},${y + hh} ${cx},${y + hh + t} ${cx + w},${y + t}`;
  const dots: [number, number][] = [];
  if (studs) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) dots.push([cx + (i - j) * w * 0.33, y + (i + j) * hh * 0.33]);
  return <g stroke="#0B0D12" strokeWidth="1.3" strokeLinejoin="round">
    <polygon points={left} fill={c.left} /><polygon points={right} fill={c.right} /><polygon points={top} fill={c.top} />
    {dots.map(([x, yy], i) => <g key={i}><ellipse cx={x} cy={yy + 4} rx="12" ry="6" fill={c.left} /><rect x={x - 12} y={yy - 2} width="24" height="6" fill={c.left} stroke="none" /><ellipse cx={x} cy={yy - 2} rx="12" ry="6" fill={c.top} /></g>)}
  </g>;
}
function ModuleStack({ step }: { step: number }) {
  return (
    <svg viewBox="0 0 400 420" className="lp-stack" role="img" aria-label="VeyroApp modules stacked into one platform">
      <ellipse cx="200" cy="372" rx="150" ry="40" fill="#0B0D12" opacity=".08" />
      {LAYERS.map((c, i) => {
        const on = i <= step; const y = 330 - i * 44;
        return <g key={c.key} className={`lp-layer${on ? ' on' : ''}`} style={{ transitionDelay: on ? `${i === step ? 0 : 0}ms` : '0ms' }}>
          <Slab y={y} c={c} studs={i === Math.min(step, LAYERS.length - 1)} />
          <g className="lp-tag" transform={`translate(${i % 2 ? 6 : 334} ${y + 8})`}>
            <line x1={i % 2 ? 54 : 0} y1="0" x2={i % 2 ? 66 : -12} y2="0" stroke="#0B0D12" strokeDasharray="2 3" />
            <text x={i % 2 ? 0 : 6} y="4" textAnchor={i % 2 ? 'start' : 'start'} className="lp-tagtext">{String(i + 1).padStart(2, '0')}</text>
          </g>
        </g>;
      })}
    </svg>
  );
}

const STORY = [
  { kicker: 'Win the client', title: 'Leads, deals and clients in one pipeline.', body: 'Capture leads, track every call and email, move opportunities to won, and turn them into clients with contracts and rates attached.' },
  { kicker: 'Find the talent', title: 'Recruiting with AI matching built in.', body: 'Open positions, collect applications on your own branded page, and let AI rank the best candidates for each role — with the reasons why.' },
  { kicker: 'Place and manage', title: 'Every placement, worker and seat tracked.', body: 'Offers become placements with bill and pay rates, start dates and onboarding. Clients and workers each get their own portal.' },
  { kicker: 'Track the time', title: 'Hours that are right the first time.', body: 'Workers clock in from the portal, timesheets route to clients for approval, and overtime and exceptions surface on their own.' },
  { kicker: 'Pay and get paid', title: 'Payroll and invoices from the same hours.', body: 'Approved time flows straight into payroll runs and client invoices. Charge cards, chase what is overdue, see margin per placement.' },
];

function Story() {
  const [ref, p] = useScrollProgress<HTMLElement>('pinned');
  const step = Math.min(STORY.length - 1, Math.floor(p * STORY.length * 0.9999));
  const local = clamp(p * STORY.length - step);
  return (
    <section ref={ref} className="lp-story" id="platform">
      <div className="lp-story-pin">
        <div className="lp-story-grid">
          <div className="lp-story-left">
            <i className="lp-plus tl" /><i className="lp-plus tr" /><i className="lp-plus bl" /><i className="lp-plus br" />
            <div className="lp-story-kicker">The all-in-one staffing stack</div>
            <div className="lp-story-copy">
              {STORY.map((s, i) => (
                <div key={i} className={`lp-story-item${i === step ? ' on' : i < step ? ' past' : ''}`} aria-hidden={i !== step}>
                  <div className="lp-mono lp-story-n">{String(i + 1).padStart(2, '0')} — {s.kicker}</div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
            <div className="lp-story-dots" aria-hidden>
              {STORY.map((_, i) => <span key={i} className={i === step ? 'on' : ''}><b style={{ transform: `scaleX(${i < step ? 1 : i === step ? local : 0})` }} /></span>)}
            </div>
          </div>
          <div className="lp-story-right">
            <div className="lp-dotgrid" aria-hidden />
            <div className="lp-story-card"><ModuleStack step={step} /></div>
            <div className="lp-story-legend lp-mono" aria-hidden>{LAYERS.map((l, i) => <span key={l.key} className={i <= step ? 'on' : ''}>{String(i + 1).padStart(2, '0')} {l.label}</span>)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────── Statement that lights up word by word as you scroll ───────────── */
function Statement() {
  const [ref, p] = useScrollProgress<HTMLElement>('through');
  const words = useMemo(() => 'Most agencies run on seven tools that never talk to each other. A CRM here, an ATS there, spreadsheets for hours, another app for payroll. VeyroApp is one workspace for all of it.'.split(' '), []);
  const lit = Math.floor(clamp((p - 0.18) / 0.5) * words.length);
  return (
    <section ref={ref} className="lp-statement">
      <div className="lp-wrap lp-statement-grid">
        <div className="lp-eyebrow lp-blue" data-reveal>Why VeyroApp</div>
        <p className="lp-statement-text">{words.map((w, i) => <span key={i} className={i < lit ? 'lit' : ''}>{w} </span>)}</p>
      </div>
    </section>
  );
}

/* ───────────── Module bento with tiny live UIs ───────────── */
function Clock() {
  const [s, setS] = useState(7 * 3600 + 42 * 60 + 15);
  useEffect(() => { if (reduced()) return; const t = setInterval(() => setS(x => x + 1), 1000); return () => clearInterval(t); }, []);
  const f = (n: number) => String(n).padStart(2, '0');
  return <span className="lp-mono">{f(Math.floor(s / 3600))}:{f(Math.floor(s / 60) % 60)}:{f(s % 60)}</span>;
}
function Bento() {
  return (
    <section className="lp-modules" id="modules">
      <div className="lp-wrap">
        <div className="lp-sechead">
          <div className="lp-eyebrow lp-blue" data-reveal>Everything included</div>
          <h2 data-reveal>One platform.<br /><span className="lp-dim">Every part of the agency.</span></h2>
        </div>
        <div className="lp-bento">
          <article className="lp-card c-crm" data-reveal>
            <header><span className="lp-mono">01</span><h4>CRM &amp; lead tracking</h4></header>
            <p>Leads, contacts, calls, emails and deals, with a pipeline you can actually see.</p>
            <div className="ui-pipe" aria-hidden>
              {['New', 'Qualified', 'Proposal', 'Won'].map((c, i) => <div key={c} className="col"><small>{c}</small>{Array.from({ length: 3 - (i % 2) }).map((_, j) => <i key={j} style={{ animationDelay: `${(i * 3 + j) * 0.35}s` }} />)}</div>)}
            </div>
          </article>
          <article className="lp-card c-ai" data-reveal>
            <header><span className="lp-mono">02</span><h4>Recruiting + AI matching</h4></header>
            <p>Branded job pages, resume parsing, and a ranked shortlist for every position.</p>
            <div className="ui-match" aria-hidden>
              {[['Maria S.', 94], ['Jose R.', 88], ['Priya K.', 81], ['Dan W.', 67]].map(([n, v], i) => <div key={n as string} className="row"><span>{n}</span><b><i style={{ width: `${v}%`, animationDelay: `${i * 0.15}s` }} /></b><em className="lp-mono">{v}%</em></div>)}
            </div>
          </article>
          <article className="lp-card c-time" data-reveal>
            <header><span className="lp-mono">03</span><h4>Time tracking</h4></header>
            <p>Clock in from any device. Timesheets go to clients for one-click approval.</p>
            <div className="ui-time" aria-hidden>
              <div className="clock"><span className="live" />On shift <Clock /></div>
              <div className="bars">{[62, 80, 74, 90, 56, 30, 12].map((v, i) => <i key={i} style={{ height: `${v}%`, animationDelay: `${i * 0.08}s` }}><small>{'MTWTFSS'[i]}</small></i>)}</div>
            </div>
          </article>
          <article className="lp-card c-pay lp-card-blue" data-reveal>
            <header><span className="lp-mono">04</span><h4>Payroll</h4></header>
            <p>Approved hours become a payroll run. Rates, overtime and deductions applied for you.</p>
            <div className="ui-pay" aria-hidden>
              {['Hours approved', 'Rates applied', 'Overtime calculated', 'Payroll run ready'].map((t, i) => <div key={t} style={{ animationDelay: `${0.3 + i * 0.45}s` }}><Check size={14} />{t}</div>)}
            </div>
          </article>
          <article className="lp-card c-inv" data-reveal>
            <header><span className="lp-mono">05</span><h4>Invoicing &amp; billing</h4></header>
            <p>Invoices built from the same timesheets. Card payments, reminders, margin per placement.</p>
            <div className="ui-inv" aria-hidden>
              <div className="doc"><small className="lp-mono">INV-2041 · Brightline Dental</small><b><CountUp prefix="$" to={18640} /></b><span className="stamp">Paid</span>
                <div className="lines"><i /><i /><i /></div></div>
            </div>
          </article>
          <article className="lp-card c-portal" data-reveal>
            <header><span className="lp-mono">06</span><h4>Client, worker &amp; candidate portals</h4></header>
            <p>Everyone gets their own login. Clients approve, workers clock in, candidates apply.</p>
            <div className="ui-portal" aria-hidden>{[['C', 'Client'], ['W', 'Worker'], ['A', 'Candidate']].map(([l, n], i) => <div key={n} style={{ animationDelay: `${i * 0.6}s` }}><span>{l}</span>{n}</div>)}</div>
          </article>
          <article className="lp-card c-ana" data-reveal>
            <header><span className="lp-mono">07</span><h4>Analytics</h4></header>
            <p>Revenue, margin, fill rate and recruiter performance, live.</p>
            <svg className="ui-spark" viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden><path d="M0 78 C30 70 45 72 70 60 S110 62 130 48 S170 40 190 44 S235 22 260 20 S290 10 300 6" /><path className="area" d="M0 78 C30 70 45 72 70 60 S110 62 130 48 S170 40 190 44 S235 22 260 20 S290 10 300 6 L300 90 L0 90Z" /></svg>
          </article>
          <article className="lp-card c-docs" data-reveal>
            <header><span className="lp-mono">08</span><h4>Documents, e-sign &amp; messaging</h4></header>
            <p>Contracts out for signature, every email and text logged on the record.</p>
            <div className="ui-chat" aria-hidden><span>Contract sent for signature</span><span className="me">Signed ✓</span></div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ───────────── Lead → cash flow, drawn as you scroll ───────────── */
const FLOW = ['Lead', 'Deal won', 'Position', 'Candidate', 'Placement', 'Timesheet', 'Payroll', 'Invoice', 'Paid'];
function Flow() {
  const [ref, p] = useScrollProgress<HTMLElement>('through');
  const k = clamp((p - 0.22) / 0.42);
  const active = Math.round(k * (FLOW.length - 1));
  return (
    <section ref={ref} className="lp-flow" id="how">
      <div className="lp-wrap">
        <div className="lp-sechead">
          <div className="lp-eyebrow lp-blue" data-reveal>How it works</div>
          <h2 data-reveal>From first call<br /><span className="lp-dim">to paid invoice.</span></h2>
          <p className="lp-lead" data-reveal>Every step hands its data to the next. Nothing is retyped, nothing falls through a crack between two apps.</p>
        </div>
        <div className="lp-track" style={{ ['--k' as any]: k }}>
          <div className="lp-track-line"><b /></div>
          {FLOW.map((s, i) => <div key={s} className={`lp-node${i <= active && k > 0 ? ' on' : ''}`}><i /><span className="lp-mono">{String(i + 1).padStart(2, '0')}</span><b>{s}</b></div>)}
        </div>
      </div>
    </section>
  );
}

function Numbers() {
  return (
    <section className="lp-numbers">
      <div className="lp-wrap lp-numgrid">
        <div data-reveal><b><CountUp to={10} /></b><span>modules in one workspace</span></div>
        <div data-reveal><b><CountUp to={4} /></b><span>portals: agency, client, worker, candidate</span></div>
        <div data-reveal><b><CountUp to={1} /></b><span>login for the whole team</span></div>
        <div data-reveal><b><CountUp from={7} to={0} dur={1800} /></b><span>tools left to juggle</span></div>
      </div>
    </section>
  );
}

/* ───────────── Trust (light section) ───────────── */
function Shield() {
  return (
    <svg viewBox="0 0 420 360" className="lp-shield" aria-hidden>
      {[0, 1, 2].map(i => <g key={i} className="lp-shield-slab" style={{ animationDelay: `${i * 0.18}s` }}><Slab y={250 - i * 30} c={i === 2 ? { ...LAYERS[1], top: '#9CC0FF', left: '#6E9BEA', right: '#4E7FD6' } : LAYERS[2]} studs={false} w={150} t={18} /></g>)}
      <g className="lp-shield-badge">
        <path d="M210 70 l58 22 v40 c0 38 -26 62 -58 76 c-32 -14 -58 -38 -58 -76 v-40z" fill="#1E6EF3" stroke="#0B0D12" strokeWidth="1.4" />
        <path d="M188 136 l16 16 l30 -34" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
function Trust() {
  const items: [ReactNode, string, string][] = [
    [<KeyRound size={18} />, 'Roles & permissions', 'Recruiters, sales, finance and clients see exactly what they should — nothing more.'],
    [<ScrollText size={18} />, 'Full audit log', 'Every change is recorded with who, what and when.'],
    [<ShieldCheck size={18} />, 'Two-factor sign-in', 'Protect every account with a second step.'],
    [<Building2 size={18} />, 'Isolated workspaces', 'Each agency’s data is kept separate from every other agency.'],
    [<Lock size={18} />, 'Private files', 'Resumes and contracts are shared through signed links that expire.'],
  ];
  return (
    <section className="lp-trust">
      <div className="lp-wrap lp-trust-grid">
        <div>
          <h2 data-reveal>Built to be<br /><span className="lp-dim2">trusted with payroll.</span></h2>
          <p className="lp-lead dark" data-reveal>Your clients’ rates, your workers’ pay and your candidates’ details live here. We treat them that way.</p>
          <ul className="lp-trust-list">{items.map(([ic, t, d]) => <li key={t} data-reveal><span>{ic}</span><div><b>{t}</b><p>{d}</p></div></li>)}</ul>
        </div>
        <div className="lp-trust-art" data-reveal><Shield /></div>
      </div>
    </section>
  );
}

/* ───────────── Contact dialog (centered) ───────────── */
function ContactDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', company: '', team_size: '', interest: '', message: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus(); const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', k); return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [onClose]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(v => ({ ...v, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post('/api/v1/public/contact', f); setDone(true); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="lp-modal" onMouseDown={onClose}>
      <div className="lp-dialog" role="dialog" aria-modal="true" aria-labelledby="lp-contact-title" onMouseDown={e => e.stopPropagation()}>
        <button className="lp-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        {done ? (
          <div className="lp-done">
            <div className="lp-done-ic"><Check size={26} /></div>
            <h3 id="lp-contact-title">Thanks, {f.name.split(' ')[0] || 'there'}.</h3>
            <p>Your message is with our team. We’ll reply to <b>{f.email}</b> soon.</p>
            <div className="lp-row"><button className="lp-btn lp-btn-blue" onClick={onClose}>Done</button><Link to="/register" className="lp-btn lp-btn-ghost">Create your agency <ArrowRight size={16} /></Link></div>
          </div>
        ) : (<>
          <div className="lp-eyebrow lp-blue">Contact us</div>
          <h3 id="lp-contact-title">Talk to the VeyroApp team</h3>
          <p className="lp-dsub">Tell us about your agency and we’ll show you how VeyroApp fits.</p>
          <form onSubmit={submit} className="lp-form">
            <div className="lp-two">
              <label>Full name<input ref={first} required value={f.name} onChange={set('name')} autoComplete="name" placeholder="Jane Smith" /></label>
              <label>Work email<input required type="email" value={f.email} onChange={set('email')} autoComplete="email" placeholder="jane@agency.com" /></label>
            </div>
            <div className="lp-two">
              <label>Agency name<input value={f.company} onChange={set('company')} autoComplete="organization" placeholder="Brightline Staffing" /></label>
              <label>Team size<select value={f.team_size} onChange={set('team_size')}><option value="">Select…</option>{['Just me', '2–10', '11–50', '51–200', '200+'].map(o => <option key={o}>{o}</option>)}</select></label>
            </div>
            <label>Most interested in<select value={f.interest} onChange={set('interest')}><option value="">Everything</option>{['CRM & leads', 'Recruiting & AI matching', 'Time tracking', 'Payroll', 'Invoicing & billing', 'Client & worker portals', 'Switching from another system'].map(o => <option key={o}>{o}</option>)}</select></label>
            <label>Message<textarea rows={4} value={f.message} onChange={set('message')} placeholder="How do you run things today? What should we know?" /></label>
            {err && <div className="lp-err" role="alert">{err}</div>}
            <button type="submit" className="lp-btn lp-btn-blue lp-btn-block" disabled={busy}>{busy ? 'Sending…' : <>Send message <ArrowRight size={16} /></>}</button>
          </form>
        </>)}
      </div>
    </div>, document.body);
}

/* ───────────── Page ───────────── */
export default function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  const { me } = useAuth();
  const [contact, setContact] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [bar, setBar] = useState(true);
  const [menu, setMenu] = useState(false);
  useReveal(root);
  useEffect(() => {
    document.title = 'VeyroApp — The all-in-one platform for staffing agencies';
    const id = 'lp-fonts';
    if (!document.getElementById(id)) {
      const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
      document.head.appendChild(l);
    }
    const on = () => setScrolled(window.scrollY > 40);
    on(); window.addEventListener('scroll', on, { passive: true }); return () => window.removeEventListener('scroll', on);
  }, []);
  const [footRef, footP] = useScrollProgress<HTMLElement>('through');
  const openContact = () => { setMenu(false); setContact(true); };
  const appLink = me ? (me.workspace ? '/' : me.isPlatformAdmin ? '/platform' : '/login') : null;

  return (
    <div className="lp" ref={root}>
      {bar && <div className="lp-bar"><Link to="/register">New: AI candidate matching, built into recruiting <ArrowRight size={13} /></Link><button onClick={() => setBar(false)} aria-label="Dismiss"><X size={16} /></button></div>}

      <header className={`lp-nav${scrolled ? ' scrolled' : ''}${bar ? ' with-bar' : ''}`}>
        <Link to="/home" className="lp-logo" aria-label="VeyroApp home"><span className="lp-mark" aria-hidden><i /><i /></span>VeyroApp</Link>
        <nav className={menu ? 'open' : ''}>
          <a href="#platform" onClick={() => setMenu(false)}>Platform</a>
          <a href="#modules" onClick={() => setMenu(false)}>Modules</a>
          <a href="#how" onClick={() => setMenu(false)}>How it works</a>
          <button onClick={openContact}>Contact</button>
          {appLink ? <Link to={appLink}>Open app</Link> : <Link to="/login">Sign in</Link>}
        </nav>
        <Link to="/register" className="lp-btn lp-btn-blue lp-nav-cta">Get started</Link>
        <button className="lp-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}><i /><i /></button>
      </header>

      <section className="lp-hero">
        <HeroField />
        <div className="lp-hero-inner">
          <div className="lp-hero-kicker lp-mono"><Scramble text="CRM · RECRUITING · TIME · PAYROLL · BILLING" speed={22} /></div>
          <h1><span className="lp-line"><span>The all-in-one</span></span><span className="lp-line"><span>staffing platform.</span></span></h1>
          <p className="lp-hero-sub">Leads, recruiting, placements, time tracking, payroll and invoicing — one workspace, one source of truth, one login.</p>
          <div className="lp-row lp-hero-cta">
            <Link to="/register" className="lp-btn lp-btn-blue lp-btn-lg">Get started <ArrowRight size={18} /></Link>
            <button onClick={openContact} className="lp-btn lp-btn-white lp-btn-lg">Contact us</button>
          </div>
        </div>
        <div className="lp-scrollcue lp-mono" aria-hidden><i />Scroll</div>
      </section>

      <div className="lp-marquee" aria-hidden>
        <div>{Array.from({ length: 2 }).map((_, k) => <span key={k}>{['CRM', 'Lead tracking', 'Recruiting', 'AI matching', 'Placements', 'Time tracking', 'Timesheets', 'Payroll', 'Invoicing', 'Card payments', 'Client portal', 'Worker portal', 'E-sign', 'Analytics'].map(t => <em key={t}>{t}<b>■</b></em>)}</span>)}</div>
      </div>

      <Story />
      <Statement />
      <Bento />
      <Flow />
      <Numbers />
      <Trust />

      <section className="lp-cta">
        <div className="lp-cta-bars" aria-hidden>{Array.from({ length: 48 }).map((_, i) => <i key={i} style={{ animationDelay: `${(i * 137) % 2400}ms`, left: `${(i / 48) * 100}%` }} />)}</div>
        <div className="lp-wrap lp-cta-inner">
          <div className="lp-eyebrow lp-blue" data-reveal><Scramble text="READY WHEN YOU ARE" /></div>
          <h2 data-reveal>Run your whole agency<br />from one place.</h2>
          <p className="lp-lead" data-reveal>Create your workspace in a few minutes, or talk to us first. Every agency is reviewed by our team before going live.</p>
          <div className="lp-row" data-reveal>
            <Link to="/register" className="lp-btn lp-btn-blue lp-btn-lg">Create your agency <ArrowRight size={18} /></Link>
            <button onClick={openContact} className="lp-btn lp-btn-white lp-btn-lg">Contact us <ArrowUpRight size={18} /></button>
          </div>
        </div>
      </section>

      <footer ref={footRef} className="lp-foot">
        <div className="lp-wrap lp-foot-grid">
          <span className="lp-mark big" aria-hidden><i /><i /></span>
          <div className="lp-foot-cols">
            <div><h5>Product</h5><a href="#platform">Platform</a><a href="#modules">Modules</a><a href="#how">How it works</a></div>
            <div><h5>Get started</h5><Link to="/register">Create an agency</Link><Link to="/login">Sign in</Link><button onClick={openContact}>Contact us</button></div>
            <div><h5>Company</h5><span>© {new Date().getFullYear()} VeyroApp</span></div>
          </div>
        </div>
        <div className="lp-wordmark" aria-hidden style={{ transform: `translateY(${(1 - clamp(footP * 1.6)) * 40}%)` }}>VeyroApp</div>
      </footer>

      {contact && <ContactDialog onClose={() => setContact(false)} />}
    </div>
  );
}
