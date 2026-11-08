// One-question-per-screen flow engine for public pages (client sign-up, candidate application).
// Animated, keyboard-first (Enter to continue, letter keys pick choices), tenant-branded, reduced-motion aware.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, CornerDownLeft, Minus, Plus, Sparkles } from 'lucide-react';
import './flow.css';

export interface FlowBrand { name: string; logo_text?: string | null; logo_url?: string | null; primary_color: string; accent_color: string; hide_powered_by?: boolean }
export interface FlowStep {
  id: string;
  /** Big question text. */
  title: ReactNode;
  hint?: ReactNode;
  body?: ReactNode;
  /** Return an error message to block Continue. */
  validate?: () => string | null;
  optional?: boolean;
  /** Button label (default "OK"). */
  cta?: string;
  /** Screens without the numbered question chrome (welcome, AI reading, done). */
  bare?: boolean;
  /** Hide the Continue button (the body advances itself). */
  noCta?: boolean;
  /** Enter key should not advance (e.g. textarea screens use ⌘/Ctrl+Enter). */
  enterNeedsMod?: boolean;
}

/** Step index state. next/back/go always act on the latest index and count, so callbacks captured in memoized
 *  step definitions never jump to a stale position. */
export function useFlowIndex(count: number) {
  const [state, setState] = useState({ i: 0, dir: 1 as 1 | -1 });
  const countRef = useRef(count);
  countRef.current = count;
  const clamp = (n: number) => Math.max(0, Math.min(countRef.current - 1, n));
  const go = useCallback((to: number) => setState(s => ({ i: clamp(to), dir: to >= s.i ? 1 : -1 })), []);
  const next = useCallback(() => setState(s => ({ i: clamp(s.i + 1), dir: 1 })), []);
  const back = useCallback(() => setState(s => ({ i: clamp(s.i - 1), dir: -1 })), []);
  return { index: state.i, dir: state.dir, go, next, back };
}

/**
 * Renders the current step full-screen with enter/exit animations, a progress bar, and Enter-to-continue.
 * `onAdvance` is called after the current step validates (parent decides where to go, e.g. submit on the last step).
 */
export function Flow({ brand, steps, index, dir, onAdvance, onBack, busy, error, topRight, footerNote }: {
  brand: FlowBrand; steps: FlowStep[]; index: number; dir: 1 | -1; onAdvance: () => void; onBack: () => void; busy?: boolean; error?: string | null; topRight?: ReactNode; footerNote?: ReactNode;
}) {
  const step = steps[index];
  const [shown, setShown] = useState({ index, dir, leaving: false });
  const [stepError, setStepError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const timer = useRef<number | null>(null);
  // Exit animation of the previous screen, then mount the next one.
  useEffect(() => {
    if (index === shown.index) return;
    setShown(s => ({ ...s, leaving: true, dir }));
    timer.current = window.setTimeout(() => setShown({ index, dir, leaving: false }), reducedMotion() ? 0 : 220);
    setStepError(null);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  const advance = useCallback(() => {
    if (busy) return;
    const e = step?.validate?.() ?? null;
    if (e) { setStepError(e); setShake(n => n + 1); return; }
    setStepError(null);
    onAdvance();
  }, [busy, step, onAdvance]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || shown.leaving) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-flow-noenter]')) return;
      const inTextarea = t?.tagName === 'TEXTAREA';
      if ((inTextarea || step?.enterNeedsMod) && !(e.metaKey || e.ctrlKey)) return;
      // Enter continues from the question's own controls (number picker, choice cards, chips); Space still presses
      // them. Navigation-style buttons (Skip, Edit, Back/Next arrows, video/upload controls) keep native Enter.
      if (t?.tagName === 'BUTTON' && !t.classList.contains('flow-ok') && (t.classList.contains('flow-skip') || t.classList.contains('btn') || t.closest('.flow-nav, .flow-review-row, .flow-cardlet'))) return;
      if (step?.noCta) return;
      e.preventDefault();
      advance();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [advance, step, shown.leaving]);
  // Focus the first field of each new screen.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown.leaving) return;
    const t = window.setTimeout(() => { const el = stageRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([type=range]), textarea, select, [data-flow-focus]'); el?.focus({ preventScroll: true }); }, reducedMotion() ? 0 : 380);
    return () => clearTimeout(t);
  }, [shown.index, shown.leaving]);

  const cur = steps[shown.index] ?? step;
  const questionNo = steps.slice(0, shown.index + 1).filter(s => !s.bare).length;
  const totalQuestions = steps.filter(s => !s.bare).length;
  const progress = Math.round((steps.slice(0, index).filter(s => !s.bare).length / Math.max(1, totalQuestions)) * 100);
  const vars = { '--fa': brand.primary_color, '--fb': brand.accent_color } as CSSProperties;
  return (
    <div className="flow" style={vars}>
      <div className="flow-bg" aria-hidden><i /><i /><i /></div>
      <header className="flow-top">
        <span className="flow-brand">{brand.logo_url ? <img src={brand.logo_url} alt="" /> : <span className="flow-logo">{(brand.logo_text || brand.name).slice(0, 1)}</span>}<b>{brand.logo_text || brand.name}</b></span>
        {topRight}
      </header>
      <div className="flow-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progress"><i style={{ width: `${progress}%` }} /></div>
      <main className="flow-main">
        <div key={shown.index} ref={stageRef} className={`flow-stage ${shown.leaving ? 'leaving' : ''} ${shown.dir === 1 ? 'fwd' : 'back'}`}>
          {!cur.bare && <div className="flow-num" style={{ ['--i' as any]: 0 }}>{questionNo}<ArrowRightTiny /> <span>of {totalQuestions}</span></div>}
          {cur.title && <h1 className={`flow-title ${cur.bare ? 'big' : ''}`} style={{ ['--i' as any]: 1 }}>{cur.title}</h1>}
          {cur.hint && <p className="flow-hint" style={{ ['--i' as any]: 2 }}>{cur.hint}</p>}
          {cur.body && <div className="flow-body" style={{ ['--i' as any]: 3 }}>{cur.body}</div>}
          {(stepError || error) && <div key={shake} className="flow-error" role="alert">{stepError || error}</div>}
          {!cur.noCta && (
            <div className="flow-actions" style={{ ['--i' as any]: 4 }}>
              <button type="button" className="flow-ok" onClick={advance} disabled={busy}>{busy ? <span className="spinner" /> : null}{cur.cta ?? 'OK'}{!busy && <Check size={18} />}</button>
              <span className="flow-enter">press <b>{cur.enterNeedsMod ? '⌘ + Enter' : 'Enter'}</b> <CornerDownLeft size={13} /></span>
              {cur.optional && <button type="button" className="flow-skip" onClick={() => { setStepError(null); onAdvance(); }}>Skip</button>}
            </div>
          )}
        </div>
      </main>
      <footer className="flow-foot">
        <span className="flow-foot-note">{footerNote ?? (!brand.hide_powered_by && <>Powered by <b>VeyroApp</b></>)}</span>
        <div className="flow-nav">
          <button type="button" aria-label="Previous question" onClick={onBack} disabled={index === 0 || busy}><ArrowUp size={18} /></button>
          <button type="button" aria-label="Next question" onClick={advance} disabled={busy || !!step?.noCta}><ArrowDown size={18} /></button>
        </div>
      </footer>
    </div>
  );
}
const ArrowRightTiny = () => <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden style={{ margin: '0 4px' }}><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ── Inputs ── */
export function FlowInput(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const { label, ...rest } = props;
  return <label className="flow-field">{label && <span>{label}</span>}<input className="flow-input" {...rest} /></label>;
}
export function FlowTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="flow-input flow-textarea" rows={4} {...props} />;
}

/** Choice cards with letter-key shortcuts. Single-select advances automatically after a short beat. */
export function Choices<T extends string>({ options, value, onChange, multiple, onPicked, columns }: {
  options: { value: T; label: ReactNode; desc?: ReactNode; icon?: ReactNode }[]; value: T | T[] | null | undefined; onChange: (v: any) => void; multiple?: boolean; onPicked?: () => void; columns?: number;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  const selected = (v: T) => (multiple ? ((value as T[]) ?? []).includes(v) : value === v);
  const pick = useCallback((v: T) => {
    if (multiple) { const cur = (value as T[]) ?? []; onChange(cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]); }
    else { onChange(v); setFlash(v); if (onPicked) window.setTimeout(onPicked, reducedMotion() ? 0 : 420); }
  }, [multiple, value, onChange, onPicked]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const idx = e.key.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length && idx < 26) { e.preventDefault(); pick(options[idx].value); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [options, pick]);
  return (
    <div className="flow-choices" role={multiple ? 'group' : 'radiogroup'} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role={multiple ? 'checkbox' : 'radio'} aria-checked={selected(o.value)} data-flow-focus={i === 0 ? '' : undefined}
          className={`flow-choice ${selected(o.value) ? 'on' : ''} ${flash === o.value ? 'flash' : ''}`} style={{ ['--d' as any]: `${i * 35}ms` }} onClick={() => pick(o.value)}>
          <kbd>{String.fromCharCode(65 + i)}</kbd>
          {o.icon && <span className="flow-choice-ic">{o.icon}</span>}
          <span className="flow-choice-txt"><b>{o.label}</b>{o.desc && <small>{o.desc}</small>}</span>
          <span className="flow-choice-check"><Check size={14} /></span>
        </button>
      ))}
    </div>
  );
}

/** Big animated number with −/+ and quick picks. */
export function NumberPicker({ value, onChange, min = 1, max = 100, quick = [1, 2, 3, 5, 10], unit }: { value: number; onChange: (n: number) => void; min?: number; max?: number; quick?: number[]; unit?: (n: number) => string }) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, n)));
  return (
    <div className="flow-number">
      <div className="flow-number-row">
        <button type="button" aria-label="Fewer" onClick={() => set(value - 1)} disabled={value <= min}><Minus size={22} /></button>
        <div className="flow-number-val" aria-live="polite"><span key={value} className="pop">{value}</span>{unit && <small>{unit(value)}</small>}</div>
        <button type="button" aria-label="More" onClick={() => set(value + 1)} disabled={value >= max} data-flow-focus><Plus size={22} /></button>
      </div>
      <div className="flow-quick">{quick.map(n => <button type="button" key={n} className={n === value ? 'on' : ''} onClick={() => set(n)}>{n === max ? `${n}+` : n}</button>)}</div>
    </div>
  );
}

/** Dual-handle range slider for min–max values (cents). */
export function RangeSlider({ min, max, step, low, high, onChange, format, labels = ['Min', 'Max'] }: { min: number; max: number; step: number; low: number; high: number; onChange: (low: number, high: number) => void; format: (v: number) => string; labels?: [string, string] }) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  return (
    <div className="flow-range">
      <div className="flow-range-vals">
        <div><small>{labels[0]}</small><b key={low} className="pop">{format(low)}</b></div>
        <span className="flow-range-dash" />
        <div><small>{labels[1]}</small><b key={high} className="pop">{format(high)}</b></div>
      </div>
      <div className="flow-range-track">
        <i style={{ left: `${pct(low)}%`, right: `${100 - pct(high)}%` }} />
        <input type="range" aria-label={labels[0]} min={min} max={max} step={step} value={low} onChange={e => onChange(Math.min(Number(e.target.value), high), high)} />
        <input type="range" aria-label={labels[1]} min={min} max={max} step={step} value={high} onChange={e => onChange(low, Math.max(Number(e.target.value), low))} />
      </div>
      <div className="flow-range-scale"><span>{format(min)}</span><span>{format(max)}+</span></div>
    </div>
  );
}

/** Selectable chips (multi). Suggestions plus free entry. */
export function ChipPicker({ options, value, onChange, placeholder = 'Type and press Enter to add your own' }: { options: string[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [t, setT] = useState('');
  const all = [...new Set([...value, ...options])];
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter(x => x !== s) : [...value, s]);
  const add = () => { const v = t.trim(); if (v && !value.includes(v)) onChange([...value, v]); setT(''); };
  return (
    <div>
      <div className="flow-chips">{all.map((s, i) => <button type="button" key={s} className={`flow-chip ${value.includes(s) ? 'on' : ''}`} style={{ ['--d' as any]: `${Math.min(i, 20) * 25}ms` }} onClick={() => toggle(s)} aria-pressed={value.includes(s)}>{value.includes(s) && <Check size={13} />}{s}</button>)}</div>
      <input className="flow-input flow-input-sm" data-flow-noenter={t ? "" : undefined} value={t} placeholder={placeholder} onChange={e => setT(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={() => t && add()} aria-label="Add your own" />
    </div>
  );
}

/** "AI is reading your resume" reveal: scanning document + extracted facts ticking in one by one. */
export function AiReveal({ items, onDone, error }: { items: { label: string; value: string }[]; onDone: () => void; error?: string | null }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (error) return;
    if (n >= items.length) { const t = window.setTimeout(onDone, reducedMotion() ? 200 : 1100); return () => clearTimeout(t); }
    const t = window.setTimeout(() => setN(x => x + 1), reducedMotion() ? 0 : n === 0 ? 700 : 260);
    return () => clearTimeout(t);
  }, [n, items.length, onDone, error]);
  return (
    <div className="flow-ai">
      <div className={`flow-ai-doc ${n >= items.length ? 'done' : ''}`} aria-hidden>
        <i /><i /><i /><i /><i /><i />
        <span className="flow-ai-scan" />
        <span className="flow-ai-badge"><Sparkles size={16} /></span>
      </div>
      <ul className="flow-ai-list" aria-live="polite">
        {items.slice(0, n).map(it => <li key={it.label}><Check size={15} /><span>{it.label}</span><b>{it.value}</b></li>)}
        {n < items.length && !error && <li className="pending"><span className="spinner" /> Reading…</li>}
      </ul>
      {error && <div className="flow-error">{error}</div>}
    </div>
  );
}

/** Small "from your resume" tag shown on prefilled questions. */
export const FromResume = () => <span className="flow-tag"><Sparkles size={12} /> Filled from your resume — check it</span>;

/** Celebration burst (canvas confetti in brand colors). */
export function Confetti({ colors }: { colors: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (c.width = window.innerWidth * dpr), H = (c.height = window.innerHeight * dpr);
    const parts = Array.from({ length: 160 }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.42, vx: (Math.random() - 0.5) * 22 * dpr, vy: (-Math.random() * 20 - 6) * dpr, r: (Math.random() * 5 + 3) * dpr, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3, col: colors[Math.floor(Math.random() * colors.length)] }));
    let raf = 0; const start = performance.now();
    const tick = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) { p.vy += 0.55 * dpr; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); }
      if (t - start < 3200) raf = requestAnimationFrame(tick); else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [colors]);
  return <canvas ref={ref} className="flow-confetti" aria-hidden />;
}

/** Animated check mark for finish screens. */
export const DoneMark = () => <svg className="flow-donemark" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="29" /><path d="M19 33l9 9 18-19" /></svg>;
