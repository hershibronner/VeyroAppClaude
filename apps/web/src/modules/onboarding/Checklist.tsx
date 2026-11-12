// First-login to-do popup for newly approved agencies: 1) invite your team, 2) import your data with AI.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, PartyPopper, UserPlus, FileSpreadsheet, X, ArrowRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { Button, toBody } from '../../components/ui';
import '../../pages/signup.css';

const HIDE_KEY = 'veyro.onboarding.later';
const ICON: Record<string, any> = { team: UserPlus, import: FileSpreadsheet };

export function OnboardingChecklist() {
  const loc = useLocation();
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/onboarding/checklist', [loc.pathname === '/']);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') later(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); });
  const d = st.data;
  if (!d?.show || hidden || loc.pathname.startsWith('/onboarding/')) return null;
  const done = d.tasks.filter((t: any) => t.done).length;
  function later() { try { sessionStorage.setItem(HIDE_KEY, '1'); } catch { /* private mode */ } setHidden(true); }
  const dismiss = async () => { await api.post('/api/v1/onboarding/checklist/dismiss').catch(() => {}); setHidden(true); };
  const open = (t: any) => { later(); nav(t.link); };
  return toBody(
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-labelledby="onb-title" onMouseDown={e => { if (e.target === e.currentTarget) later(); }}>
      <div className="onb-card">
        <button type="button" className="onb-close" aria-label="Close" onClick={later}><X size={18} /></button>
        <div className="onb-hero"><PartyPopper size={26} /></div>
        <h2 id="onb-title">Welcome to VeyroApp! You're approved 🎉</h2>
        <p>Two quick steps and your agency is ready to run here.</p>
        <div className="onb-progress"><i><b style={{ width: `${(done / d.tasks.length) * 100}%` }} /></i><span>{done} of {d.tasks.length} done</span></div>
        {d.tasks.map((t: any, i: number) => { const Ic = ICON[t.key] ?? Check; return (
          <div key={t.key} className={`onb-task ${t.done ? 'done' : ''}`} style={{ ['--d' as any]: `${150 + i * 90}ms` }}>
            <span className="num">{t.done ? <Check size={20} /> : <Ic size={20} />}</span>
            <div><b>{i + 1}. {t.title}</b><small>{t.text}</small>{t.stat && <small className="stat">{t.stat}</small>}</div>
            <Button variant={t.done ? 'outline' : 'primary'} size="sm" onClick={() => open(t)}>{t.done ? 'Open' : 'Start'} <ArrowRight size={14} /></Button>
          </div>); })}
        <div className="onb-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Don't show this again</button>
          <Button onClick={later}>I'll do it later</Button>
        </div>
      </div>
    </div>,
  );
}
