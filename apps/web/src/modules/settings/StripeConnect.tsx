// Stripe pages (Connect Stripe, add a billing card) open in a new tab while a centered waiting window shows here,
// checking every few seconds until the step is finished (the new tab lands back on the matching settings page).
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Drawer } from '../../components/ui';

type Phase = 'idle' | 'opening' | 'waiting' | 'closed' | 'done';
interface Copy { title: string; waiting: string; hint: string; doneTitle: string; doneBody: string }

export function useStripeTab(o: { getUrl: () => Promise<string>; isDone: () => Promise<boolean>; onDone?: () => void; copy: Copy }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState('');
  const tab = useRef<Window | null>(null);

  const start = async () => {
    // Open the tab inside the click so pop-up blockers allow it, then point it at Stripe once we have the link.
    const w = window.open('', '_blank');
    if (w) { try { w.document.title = 'Opening Stripe…'; w.document.body.innerHTML = '<p style="font:16px system-ui;margin:40px;color:#555">Opening Stripe…</p>'; } catch { /* cross-origin */ } }
    tab.current = w;
    setPhase('opening');
    try {
      const u = await o.getUrl();
      setUrl(u);
      if (w && !w.closed) w.location.href = u;
      setPhase('waiting');
    } catch (e) { w?.close(); setPhase('idle'); toast.error(e); }
  };

  // While waiting: poll for completion; notice if the Stripe tab was closed without finishing.
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'closed') return;
    let stop = false;
    const t = setInterval(async () => {
      const done = await o.isDone().catch(() => false);
      if (stop) return;
      if (done) { setPhase('done'); o.onDone?.(); return; }
      if (phase === 'waiting' && tab.current?.closed) setPhase('closed');
    }, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setPhase('idle'); tab.current = null; };
  const c = o.copy;
  const modal = (
    <Drawer open={phase !== 'idle'} onClose={close} title={phase === 'done' ? c.doneTitle : c.title}
      footer={phase === 'done' ? <Button variant="primary" onClick={close}>Done</Button> : <Button onClick={close}>Cancel</Button>}>
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: '18px 8px' }}>
        {phase === 'done' ? <>
          <CheckCircle2 size={44} color="var(--success, #16a34a)" />
          <div><b>{c.doneTitle}</b><div className="muted mt-1">{c.doneBody} You can close the Stripe tab.</div></div>
        </> : <>
          <span className="spinner" style={{ width: 36, height: 36 }} />
          <div>
            <b>{phase === 'opening' ? 'Opening Stripe in a new tab…' : phase === 'closed' ? 'Did you finish in Stripe?' : c.waiting}</b>
            <div className="muted mt-1">{phase === 'closed' ? 'The Stripe tab was closed before this was finished. Still checking — or open it again.' : `${c.hint} This window updates by itself when it’s done.`}</div>
          </div>
          {url && <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => { tab.current = window.open(url, '_blank'); setPhase('waiting'); }}>{phase === 'closed' ? 'Open Stripe again' : 'Don’t see the tab? Open Stripe'}</Button>}
        </>}
      </div>
    </Drawer>
  );
  return { start, busy: phase === 'opening', modal };
}

export function useStripeConnect(onConnected?: () => void) {
  return useStripeTab({
    getUrl: async () => (await api.post('/api/v1/integrations/payments/stripe/connect')).url,
    isDone: async () => !!(await api.get('/api/v1/integrations'))?.rows?.find((r: any) => r.key === 'payments')?.account,
    onDone: onConnected,
    copy: { title: 'Connecting to Stripe', waiting: 'Finish connecting in the Stripe tab', hint: 'Log in to Stripe (or create an account) and approve the connection.', doneTitle: 'Stripe connected', doneBody: 'Your Stripe account is connected. Clients can now pay your invoices by card.' },
  });
}
