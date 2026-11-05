import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { dateTime, humanize, relTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { realtime } from '../../lib/realtime';
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, Person, StatusPill } from '../../components/ui';
import { Money, period } from './shared';
import './payroll.css';

const FINAL = ['paid', 'failed', 'partially_failed'];

export default function PayoutDetail() {
  const { id } = useParams();
  const st = useApi<any>(`/api/v1/payouts/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  useEffect(() => realtime.on('payout', (d: any) => { if (!d?.id || d.id === id) st.reload(); }), [id, st.reload]);
  const live = st.data && (!FINAL.includes(st.data.payout.status) || st.data.items.some((i: any) => ['pending', 'processing', 'retried'].includes(i.status)));
  useInterval(() => st.reload(), live ? 4000 : null);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const { payout: p, items, logs, can } = st.data;
  const failed = items.filter((i: any) => i.status === 'failed');
  const retry = async (ids?: string[]) => {
    setBusy(true);
    try { const r = await api.post(`/api/v1/payouts/${id}/retry`, ids ? { item_ids: ids } : {}); toast.success(`Retrying ${r.retried} transfer${r.retried === 1 ? '' : 's'}`); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const paid = items.filter((i: any) => i.status === 'paid').length;
  const stage = p.status === 'initiated' ? 0 : p.status === 'processing' ? 1 : 2;
  const steps = [{ label: 'Initiated' }, { label: 'Processing' }, { label: p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Failed' : p.status === 'partially_failed' ? 'Partially failed' : 'Paid' }];
  return (
    <div>
      <PageHeader back="/finance/payouts" title={<span className="row" style={{ gap: 12 }}>{p.kind === 'commission' ? 'Commission payout' : `Payroll payout ${period(p.period_start, p.period_end)}`} <StatusPill status={p.status} /></span>}
        sub={<>Submitted {dateTime(p.created_at)} by {p.initiated_by_name ?? 'System'} · {p.provider === 'wise-sim' ? 'Wise (simulated)' : p.provider} · key <span className="num">{p.idempotency_key}</span>{p.run_id && <> · <Link to={`/finance/payroll/${p.run_id}`}>Open payroll run</Link></>}</>}
        actions={failed.length > 0 && can.retry ? <Button variant="primary" icon={<RotateCcw size={16} />} loading={busy} onClick={() => retry()}>Retry {failed.length} failed</Button> : undefined} />
      {failed.length > 0 && <Banner tone="danger"><b>{failed.length} transfer{failed.length > 1 ? 's' : ''} failed.</b> Check the recipient details and retry — the same batch is reused, so nobody is paid twice.</Banner>}
      {live && <Banner>Transfers are processing. This page updates automatically.</Banner>}
      <Card pad>
        <div className="pr-steps">
          {steps.map((s, i) => <span key={i} className="row" style={{ gap: 0, flexWrap: 'nowrap' }}>
            {i > 0 && <span className="pr-step-line" />}
            <span className={`pr-step ${i < stage || (i === 2 && p.status === 'paid') ? 'done' : i === stage ? (i === 2 && p.status !== 'paid' ? 'bad' : 'on') : ''}`}><span className="dot">{i + 1}</span>{s.label}</span>
          </span>)}
        </div>
        <div className="pr-strip" style={{ marginBottom: 0 }}>
          <div><div className="lbl">Total</div><div className="val"><Money cents={p.total_cents} currency={p.currency} /></div></div>
          <div><div className="lbl">Transfers</div><div className="val">{items.length}</div></div>
          <div><div className="lbl">Paid</div><div className="val" style={{ color: 'var(--success)' }}>{paid}</div></div>
          <div><div className="lbl">Failed</div><div className="val" style={{ color: failed.length ? 'var(--danger)' : undefined }}>{failed.length}</div></div>
          <div><div className="lbl">Completed</div><div className="val" style={{ fontSize: 15 }}>{p.completed_at ? dateTime(p.completed_at) : '—'}</div></div>
        </div>
      </Card>
      <div className="grid-main-side mt-3">
        <Card>
          <CardHeader title="Transfers" />
          {items.length === 0 ? <EmptyState title="No transfers" /> : <div className="table-wrap"><table className="table">
            <thead><tr><th>Payee</th><th>Account</th><th style={{ textAlign: 'right' }}>Amount</th><th>Attempts</th><th>Status</th><th>Reference</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{items.map((i: any) => <tr key={i.id}>
              <td><Person name={i.payee_name} sub={[i.employee_code, i.payslip_number].filter(Boolean).join(' · ') || undefined} size={30} /></td>
              <td>{i.payout_account_label ?? '—'}</td>
              <td className="money"><Money cents={i.amount_cents} currency={i.currency} strong /></td>
              <td>{i.attempts}</td>
              <td><StatusPill status={i.status} />{i.failure_reason && <div className="small" style={{ color: 'var(--danger)', maxWidth: 260 }}>{i.failure_reason}</div>}</td>
              <td className="small num">{i.provider_ref ?? '—'}</td>
              <td className="act"><Menu items={[
                { label: 'Retry this transfer', icon: <RotateCcw size={15} />, hidden: i.status !== 'failed' || !can.retry, onClick: () => retry([i.id]) },
                { label: 'View payslip', hidden: !i.payroll_item_id, onClick: () => window.open(`/api/v1/payroll/items/${i.payroll_item_id}/payslip`, '_blank') },
              ]} /></td>
            </tr>)}</tbody>
          </table></div>}
        </Card>
        <Card>
          <CardHeader title="Provider events" sub="Simulated Wise webhook log" />
          <div className="card-b">{logs.length ? logs.map((l: any) => <div key={l.id} className="pr-log"><span className={`lv ${l.level}`} /><div><div>{l.message}</div><div className="small muted">{relTime(l.created_at)} · {humanize(l.level)}</div></div></div>) : <div className="muted small">No provider events recorded for this batch.</div>}</div>
        </Card>
      </div>
    </div>
  );
}
