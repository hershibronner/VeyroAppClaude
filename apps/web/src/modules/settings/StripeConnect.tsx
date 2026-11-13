// "Connect Stripe": opens Stripe's connect page in a new tab and shows a centered waiting window here, checking every
// few seconds until the workspace's Stripe account is linked (the new tab lands back on Settings → Integrations).
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Drawer } from '../../components/ui';

type Phase = 'idle' | 'opening' | 'waiting' | 'closed' | 'done';

export function useStripeConnect(onConnected?: () => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState('');
  const tab = useRef<Window | null>(null);

  const start = async () => {
    // Open the tab inside the click so pop-up blockers allow it, then point it at Stripe once we have the link.
    const w = window.open('', '_blank');
    if (w) { try { w.document.title = 'Connecting to Stripe…'; w.document.body.innerHTML = '<p style="font:16px system-ui;margin:40px;color:#555">Opening Stripe…</p>'; } catch { /* cross-origin */ } }
    tab.current = w;
    setPhase('opening');
    try {
      const r = await api.post('/api/v1/integrations/payments/stripe/connect');
      setUrl(r.url);
      if (w && !w.closed) w.location.href = r.url;
      setPhase('waiting');
    } catch (e) { w?.close(); setPhase('idle'); toast.error(e); }
  };

  // While waiting: poll the connection; notice if the Stripe tab was closed without finishing.
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'closed') return;
    let stop = false;
    const tick = async () => {
      const d = await api.get('/api/v1/integrations').catch(() => null);
      if (stop) return;
      if (d?.rows?.find((r: any) => r.key === 'payments')?.account) { setPhase('done'); onConnected?.(); return; }
      if (phase === 'waiting' && tab.current?.closed) setPhase('closed');
    };
    const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setPhase('idle'); tab.current = null; };
  const modal = (
    <Drawer open={phase !== 'idle'} onClose={close} title={phase === 'done' ? 'Stripe connected' : 'Connecting to Stripe'}
      footer={phase === 'done' ? <Button variant="primary" onClick={close}>Done</Button> : <Button onClick={close}>Cancel</Button>}>
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: '18px 8px' }}>
        {phase === 'done' ? <>
          <CheckCircle2 size={44} color="var(--success, #16a34a)" />
          <div><b>Your Stripe account is connected.</b><div className="muted mt-1">Clients can now pay your invoices by card. You can close the Stripe tab.</div></div>
        </> : <>
          <span className="spinner" style={{ width: 36, height: 36 }} />
          <div>
            <b>{phase === 'opening' ? 'Opening Stripe in a new tab…' : phase === 'closed' ? 'Did you finish in Stripe?' : 'Finish connecting in the Stripe tab'}</b>
            <div className="muted mt-1">{phase === 'closed' ? 'The Stripe tab was closed before your account was linked. Still checking — or open it again.' : 'Log in to Stripe (or create an account) and approve the connection. This window updates by itself when it’s done.'}</div>
          </div>
          {url && <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => { tab.current = window.open(url, '_blank'); setPhase('waiting'); }}>{phase === 'closed' ? 'Open Stripe again' : 'Don’t see the tab? Open Stripe'}</Button>}
        </>}
      </div>
    </Drawer>
  );
  return { start, busy: phase === 'opening', modal };
}
