// First-login to-do popup for newly approved agencies: 1) invite your team, 2) import your data with AI, 3) connect Stripe (when the server has it).
// Closing it (or starting a step) shrinks it to a floating "Finish setup" button on every page, so the other step is
// always one click away — until both steps are done or someone marks setup complete.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, PartyPopper, UserPlus, FileSpreadsheet, X, ArrowRight, Rocket, CreditCard } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { Button, toBody } from '../../components/ui';
import { useStripeConnect } from '../settings/StripeConnect';
import '../../pages/signup.css';

const HIDE_KEY = 'veyro.onboarding.later';
const ICON: Record<string, any> = { team: UserPlus, import: FileSpreadsheet, stripe: CreditCard };

export function OnboardingChecklist() {
  const loc = useLocation();
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/onboarding/checklist', [loc.pathname]);
  // "later" = collapsed to the floating button for this browser session; the popup itself opens once per session.
  const [collapsed, setCollapsed] = useState(() => { try { return sessionStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (collapsed) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') later(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); });
  const stripe = useStripeConnect(() => st.reload());
  const d = st.data;
  if (!d?.show || dismissed) return stripe.modal;
  const done = d.tasks.filter((t: any) => t.done).length;
  function later() { try { sessionStorage.setItem(HIDE_KEY, '1'); } catch { /* private mode */ } setCollapsed(true); }
  const reopen = () => { try { sessionStorage.removeItem(HIDE_KEY); } catch { /* private mode */ } setCollapsed(false); };
  const dismiss = async () => { await api.post('/api/v1/onboarding/checklist/dismiss').catch(() => {}); setDismissed(true); };
  const open = async (t: any) => {
    // Not connected yet → Stripe opens in a new tab while a waiting window shows here.
    if (t.key === 'stripe' && !t.done) { later(); await stripe.start(); return; }
    later(); nav(t.link);
  };
  if (collapsed || loc.pathname.startsWith('/onboarding/')) return <>{stripe.modal}{toBody(
    <button type="button" className="onb-pill" onClick={reopen} aria-label={`Finish setup: ${done} of ${d.tasks.length} done`}>
      <Rocket size={16} /><span>Finish setup</span><em>{done}/{d.tasks.length}</em>
    </button>,
  )}</>;
  return toBody(
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-labelledby="onb-title" onMouseDown={e => { if (e.target === e.currentTarget) later(); }}>
      <div className="onb-card">
        <button type="button" className="onb-close" aria-label="Close" onClick={later}><X size={18} /></button>
        <div className="onb-hero"><PartyPopper size={26} /></div>
        <h2 id="onb-title">Welcome to VeyroApp! You're approved 🎉</h2>
        <p>{d.tasks.length === 2 ? 'Two' : 'A few'} quick steps and your agency is ready to run here.</p>
        <div className="onb-progress"><i><b style={{ width: `${(done / d.tasks.length) * 100}%` }} /></i><span>{done} of {d.tasks.length} done</span></div>
        {d.tasks.map((t: any, i: number) => { const Ic = ICON[t.key] ?? Check; return (
          <div key={t.key} className={`onb-task ${t.done ? 'done' : ''}`} style={{ ['--d' as any]: `${150 + i * 90}ms` }}>
            <span className="num">{t.done ? <Check size={20} /> : <Ic size={20} />}</span>
            <div><b>{i + 1}. {t.title}</b><small>{t.text}</small>{t.stat && <small className="stat">{t.stat}</small>}</div>
            <Button variant={t.done ? 'outline' : 'primary'} size="sm" onClick={() => open(t)}>{t.done ? 'Open' : 'Start'} <ArrowRight size={14} /></Button>
          </div>); })}
        <div className="onb-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Mark setup as complete</button>
          <Button onClick={later}>I'll do it later</Button>
        </div>
      </div>
    </div>,
  );
}
