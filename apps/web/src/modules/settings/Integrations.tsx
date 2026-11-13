// Settings → Integrations: a card grid of every provider adapter (logo, what it does, status, Configure + on/off switch).
// Configure opens a centered window with the account, scopes, sync/test actions and the provider's log.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot, Briefcase, CalendarDays, CreditCard, ExternalLink, FileSignature, HardDrive, KeyRound, Landmark, Mail, MessageCircle, MessageSquare, Plug, PlugZap, RefreshCw, Search, Settings2, ShieldCheck, Unplug, Wallet, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, relTime } from '../../lib/format';
import { Banner, Button, Card, Drawer, ErrorState, LoadingBlock, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { Gate, ReadOnlyNote } from './common';
import { useStripeConnect } from './StripeConnect';
import './integrations.css';

/** Look and copy per adapter key: brand tile, filter group and a one-line description. */
const META: Record<string, { icon: ReactNode; bg: string; group: Group; text: string }> = {
  payments: { icon: <span className="ig-letter">S</span>, bg: 'linear-gradient(135deg,#635BFF,#8F6BFF)', group: 'finance', text: 'Let clients pay invoices by card and bank transfer. Payments land in your own Stripe account.' },
  payouts: { icon: <Wallet size={22} />, bg: 'linear-gradient(135deg,#163300,#2F6A00)', group: 'finance', text: 'Send worker payouts in local currency at the real exchange rate.' },
  accounting: { icon: <Landmark size={22} />, bg: 'linear-gradient(135deg,#108000,#2CA01C)', group: 'finance', text: 'Sync invoices, payments and customers to your books automatically.' },
  email: { icon: <Mail size={22} />, bg: 'linear-gradient(135deg,#0B0D17,#2A2F45)', group: 'comms', text: 'Branded emails for invites, sign-in codes, invoices and reminders.' },
  sms: { icon: <MessageSquare size={22} />, bg: 'linear-gradient(135deg,#F22F46,#FF6A7A)', group: 'comms', text: 'Text reminders for interviews, timesheets and shift changes.' },
  whatsapp: { icon: <MessageCircle size={22} />, bg: 'linear-gradient(135deg,#128C4B,#25D366)', group: 'comms', text: 'Reach candidates and workers on WhatsApp from their profile.' },
  calendar: { icon: <CalendarDays size={22} />, bg: 'linear-gradient(135deg,#1A73E8,#34A0FF)', group: 'workspace', text: 'Book interviews with video links straight into your calendar.' },
  esign: { icon: <FileSignature size={22} />, bg: 'linear-gradient(135deg,#3D5AFE,#7C4DFF)', group: 'workspace', text: 'Send contracts and offers for legally binding e-signature.' },
  ai: { icon: <Bot size={22} />, bg: 'linear-gradient(135deg,#C15F3C,#E08A5F)', group: 'recruiting', text: 'Resume parsing, candidate matching and smart drafting.' },
  job_boards: { icon: <Briefcase size={22} />, bg: 'linear-gradient(135deg,#2557A7,#4B7BE5)', group: 'recruiting', text: 'Post open positions to job boards and pull applicants back in.' },
  background_checks: { icon: <ShieldCheck size={22} />, bg: 'linear-gradient(135deg,#0A2540,#1D4E89)', group: 'recruiting', text: 'Order background checks and see results on the candidate.' },
  storage: { icon: <HardDrive size={22} />, bg: 'linear-gradient(135deg,#475467,#667085)', group: 'workspace', text: 'Where resumes, contracts and documents are kept.' },
};
type Group = 'finance' | 'comms' | 'recruiting' | 'workspace';
const GROUPS: { key: 'all' | Group; label: string }[] = [
  { key: 'all', label: 'All integrations' }, { key: 'finance', label: 'Payments & finance' }, { key: 'comms', label: 'Communication' }, { key: 'recruiting', label: 'Recruiting' }, { key: 'workspace', label: 'Workspace' },
];
const fallback = { icon: <Plug size={22} />, bg: 'linear-gradient(135deg,#475467,#667085)', group: 'workspace' as Group, text: '' };

export default function IntegrationsSettings() {
  return <Gate resource="integrations">{editable => <Inner editable={editable} />}</Gate>;
}

/** Status label + tone for a card. */
function statusOf(it: any): { label: string; tone: 'on' | 'off' | 'err' | 'soon' | 'built' } {
  if (it.mode === 'unavailable') return { label: it.note === 'Coming soon' ? 'Coming soon' : 'Not available', tone: 'soon' };
  if (it.key === 'payments' && it.mode === 'live') return it.account ? { label: it.note === 'Stripe test mode' ? 'Connected · test mode' : 'Connected', tone: 'on' } : { label: 'Not connected', tone: 'off' };
  if (it.status === 'error') return { label: 'Error', tone: 'err' };
  if (it.status === 'disconnected') return { label: 'Off', tone: 'off' };
  if (it.mode === 'built_in') return { label: 'Built in', tone: 'built' };
  if (it.mode === 'simulated') return { label: 'Simulated', tone: 'on' };
  return { label: 'Connected', tone: 'on' };
}

function Inner({ editable }: { editable: boolean }) {
  const st = useApi<{ rows: any[]; editable: boolean; env: 'production' | 'local' }>('/api/v1/integrations');
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | Group>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const stripe = useStripeConnect(() => { toast.success('Stripe connected — clients can now pay invoices by card'); st.reload(); });
  // Back from Stripe Connect (this is the new tab Stripe returned to).
  useEffect(() => {
    const s = params.get('stripe'); if (!s) return;
    const m = params.get('message');
    if (s === 'connected') toast.success('Stripe connected — clients can now pay invoices by card. You can close this tab.'); else if (s === 'cancelled') toast.info(m ?? 'Stripe connection cancelled'); else toast.error(m ?? 'Stripe connection failed');
    params.delete('stripe'); params.delete('message'); setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = st.data?.rows ?? [];
  const shown = useMemo(() => {
    const ql = query.trim().toLowerCase();
    return rows.filter(r => (tab === 'all' || (META[r.key] ?? fallback).group === tab) && (!ql || `${r.provider} ${r.category} ${(META[r.key] ?? fallback).text}`.toLowerCase().includes(ql)))
      // Live and connected first, coming-soon last.
      .sort((a, b) => Number(a.mode === 'unavailable') - Number(b.mode === 'unavailable'));
  }, [rows, tab, query]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Integrations" /><Card><LoadingBlock rows={8} /></Card></div>;
  const local = st.data.env !== 'production';

  const run = async (it: any, action: string) => {
    if (action === 'disconnect') { const c = await confirm({ title: `Disconnect ${it.provider}?`, body: it.key === 'payments' && it.mode === 'live' ? 'Clients will no longer be able to pay invoices by card until you connect Stripe again. Payments already received stay in your Stripe account.' : `${it.category} features that depend on it will show a "disconnected" error until you reconnect.`, danger: true, confirmLabel: 'Disconnect' }); if (!c.ok) return; }
    setBusy(`${it.key}:${action}`);
    try { const r = await api.post(`/api/v1/integrations/${it.key}/${action}`); r.ok ? toast.success(r.message) : toast.error(r.message); st.reload(); }
    catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  /** The card switch: on = connected. Stripe connects through Stripe; everything else reconnects / disconnects. */
  const toggle = (it: any, on: boolean) => {
    if (it.key === 'payments' && it.mode === 'live') return on ? stripe.start() : run(it, 'disconnect');
    return run(it, on ? 'reconnect' : 'disconnect');
  };

  const available = rows.filter(r => r.mode !== 'unavailable');
  const errors = available.filter(r => r.status === 'error');
  const connected = available.filter(r => statusOf(r).tone === 'on' || statusOf(r).tone === 'built').length;
  const events = rows.reduce((a, r) => a + (r.events_7d ?? 0), 0);
  const testable = available.filter(r => r.status === 'connected' && !(r.key === 'payments' && r.mode === 'live' && !r.account));
  const cur = rows.find(r => r.key === open);

  return (
    <div className="stack ig">
      <section className="ig-hero">
        <i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="grain" />
        <div className="ig-hero-top">
          <div>
            <span className="ig-kicker">// Connected services</span>
            <h1>Integrations</h1>
            <p>{local ? 'Every provider is a replaceable adapter. In this local build, Simulated ones are stand-ins that log everything they do.' : 'Connect your agency\'s own accounts — payments, messaging, calendars and more.'}</p>
          </div>
          <div className="ig-hero-actions">
            <button type="button" className="ig-glass" onClick={() => nav('/settings/api')}><KeyRound size={15} /> API & Webhooks</button>
            {editable && testable.length > 0 && <button type="button" className="ig-glass solid" disabled={busy === 'all'} onClick={async () => { setBusy('all'); let ok = 0; for (const r of testable) { const x = await api.post(`/api/v1/integrations/${r.key}/test`).catch(() => null); if (x?.ok) ok++; } toast.success(`${ok} of ${testable.length} connected integrations passed their test`); setBusy(''); st.reload(); }}>{busy === 'all' ? <span className="spinner" /> : <Zap size={15} />} Test all</button>}
          </div>
        </div>
        <div className="ig-stats">
          <div><b>{connected}</b><span>active</span></div>
          <div><b>{available.length}</b><span>available</span></div>
          <div className={errors.length ? 'bad' : ''}><b>{errors.length}</b><span>{errors.length ? 'need attention' : 'errors'}</span></div>
          <div><b>{events}</b><span>events · 7 days</span></div>
        </div>
      </section>

      <ReadOnlyNote show={!editable} />
      {errors.length > 0 && <Banner tone="danger">{errors.length} integration{errors.length === 1 ? ' is' : 's are'} reporting errors: {errors.map(r => r.provider).join(', ')}. Open Configure to test or reconnect.</Banner>}

      <div className="ig-bar">
        <div className="ig-tabs" role="tablist">{GROUPS.map(g => {
          const n = g.key === 'all' ? rows.length : rows.filter(r => (META[r.key] ?? fallback).group === g.key).length;
          return <button key={g.key} type="button" role="tab" aria-selected={tab === g.key} className={tab === g.key ? 'on' : ''} onClick={() => setTab(g.key)}>{g.label}<em>{n}</em></button>;
        })}</div>
        <label className="ig-search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search integrations" aria-label="Search integrations" /></label>
      </div>

      {shown.length === 0 ? <div className="ig-empty">No integrations match “{query}”.</div> : (
        <div className="ig-grid">{shown.map((it, i) => {
          const m = META[it.key] ?? fallback;
          const s = statusOf(it);
          const off = it.mode === 'unavailable';
          const isOn = s.tone === 'on' || s.tone === 'built' || s.tone === 'err';
          const switchable = editable && !off && it.mode !== 'built_in';
          const pending = busy.startsWith(`${it.key}:`) || (it.key === 'payments' && stripe.busy);
          return (
            <article key={it.key} className={`ig-card ${off ? 'soon' : ''} ${s.tone === 'err' ? 'err' : ''}`} style={{ ['--d' as any]: `${i * 40}ms` }}>
              <div className="ig-card-body">
                <div className="ig-card-top">
                  <span className="ig-logo" style={{ background: m.bg }}>{m.icon}</span>
                  <span className={`ig-status ${s.tone}`}><i />{s.label}</span>
                </div>
                <h3>{it.provider}</h3>
                <p>{m.text || it.category}</p>
                {it.account && <small className="ig-acct">{it.account.name ?? it.account.id}</small>}
                {!off && it.last_error && <small className="ig-error"><AlertTriangle size={13} /> {it.last_error}</small>}
              </div>
              <div className="ig-card-foot">
                <button type="button" className="ig-config" onClick={() => setOpen(it.key)} disabled={off}><Settings2 size={15} /> Configure</button>
                <button type="button" role="switch" aria-checked={isOn} aria-label={`${it.provider} ${isOn ? 'on' : 'off'}`} className={`ig-switch ${isOn ? 'on' : ''} ${pending ? 'busy' : ''}`}
                  disabled={!switchable || pending} title={off ? 'Coming soon' : it.mode === 'built_in' ? 'Always on' : !editable ? 'You can view but not change integrations' : undefined}
                  onClick={() => toggle(it, !isOn)}><i /></button>
              </div>
            </article>
          );
        })}</div>
      )}

      <Drawer open={!!cur} onClose={() => setOpen(null)} title={cur ? <span className="row" style={{ gap: 10 }}><span className="ig-logo sm" style={{ background: (META[cur.key] ?? fallback).bg }}>{(META[cur.key] ?? fallback).icon}</span>{cur.provider}</span> : ''} wide>
        {cur && <ConfigBody it={cur} editable={editable} local={local} busy={busy} run={run} stripe={stripe} />}
      </Drawer>
      {stripe.modal}
    </div>
  );
}

function ConfigBody({ it, editable, local, busy, run, stripe }: { it: any; editable: boolean; local: boolean; busy: string; run: (it: any, a: string) => void; stripe: ReturnType<typeof useStripeConnect> }) {
  const s = statusOf(it);
  const stripeLive = it.key === 'payments' && it.mode === 'live';
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="ig-facts">
        <div><span>Status</span><b className={`ig-status ${s.tone}`}><i />{s.label}</b></div>
        <div><span>Category</span><b>{it.category}</b></div>
        <div><span>Last sync</span><b title={dateTime(it.last_sync_at)}>{it.last_sync_at ? relTime(it.last_sync_at) : '—'}</b></div>
        <div><span>Errors · 7 days</span><b>{it.errors_7d || 0}</b></div>
      </div>
      {it.account && <div className="ig-acctbox"><CreditCard size={16} /><div><b>{it.account.name ?? 'Connected account'}</b><small>{it.account.id}{it.account.livemode ? '' : ' · test data'}</small></div></div>}
      {it.last_error && <Banner tone="danger">{it.last_error}</Banner>}
      <div><div className="ig-label">Permissions</div><div className="chips">{it.scopes.map((x: string) => <span key={x} className="chip">{x}</span>)}</div></div>
      {editable && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {stripeLive && !it.account
          ? <Button variant="primary" icon={<Plug size={15} />} loading={stripe.busy} onClick={stripe.start}>Connect Stripe</Button>
          : it.status === 'connected' || stripeLive
            ? <Button icon={<PlugZap size={15} />} loading={busy === `${it.key}:test`} onClick={() => run(it, 'test')}>Test connection</Button>
            : <Button variant="primary" icon={<Plug size={15} />} loading={busy === `${it.key}:reconnect`} onClick={() => run(it, 'reconnect')}>Reconnect</Button>}
        {(stripeLive ? !!it.account : it.status === 'connected') && it.mode !== 'built_in' && <Button icon={<RefreshCw size={15} />} loading={busy === `${it.key}:sync`} onClick={() => run(it, 'sync')}>{stripeLive ? 'Sync payments' : 'Sync now'}</Button>}
        {stripeLive && it.account && <Button icon={<ExternalLink size={15} />} onClick={() => window.open('https://dashboard.stripe.com/', '_blank', 'noopener')}>Stripe dashboard</Button>}
        {local && it.mode === 'simulated' && it.status !== 'error' && <Button icon={<AlertTriangle size={15} />} onClick={() => run(it, 'simulate-error')}>Simulate error</Button>}
        {(stripeLive ? !!it.account : it.status !== 'disconnected' && it.mode !== 'built_in') && <Button variant="danger" icon={<Unplug size={15} />} onClick={() => run(it, 'disconnect')}>Disconnect</Button>}
      </div>}
      <div>
        <div className="ig-label">Activity log</div>
        <DataTable<any> noCard urlState={false} endpoint={`/api/v1/integrations/${it.key}/logs`} exportName={`integration-${it.key}-log`} filters={[{ key: 'level', label: 'Level', options: opts(['info', 'warn', 'error']) }]}
          emptyTitle="No log entries" emptyText="Payments, tests, syncs, connections and errors are recorded here."
          columns={[{ key: 'created_at', label: 'When', render: r => dateTime(r.created_at), mobile: 'subtitle' }, { key: 'level', label: 'Level', render: r => <StatusPill status={r.level === 'info' ? 'connected' : r.level} label={r.level} /> }, { key: 'message', label: 'Message', mobile: 'title' }, { key: 'by', label: 'By', render: r => r.meta?.by ?? 'System' }]} />
      </div>
    </div>
  );
}
