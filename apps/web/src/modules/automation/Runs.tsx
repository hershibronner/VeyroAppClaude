import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, X, RotateCcw, Zap } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { dateTime, relTime, humanize } from '../../lib/format';
import { Button, Drawer, KV, PageHeader, StatusPill, useConfirm, Banner } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { triggerLabel, type Catalog } from './Workflows';

const STATUSES = ['succeeded', 'failed', 'pending_approval', 'approved', 'rejected', 'skipped', 'test'];

function resultSummary(r: any): string {
  const res = r.result ?? {};
  if (r.status === 'pending_approval') return (res.planned ?? []).map((p: any) => p.summary).join(' · ') || 'Waiting for approval';
  if (r.status === 'test') return `Dry run — ${res.wouldRun ? 'would run' : 'would be skipped'}`;
  if (r.status === 'skipped') return res.reason ?? 'Conditions not met';
  if (res.error) return res.error;
  if (Array.isArray(res.actions)) return res.actions.map((a: any) => a.detail).join(' · ');
  if (typeof res.actions === 'number') return `${res.actions} action${res.actions === 1 ? '' : 's'} executed`;
  return '—';
}
function subjectOf(r: any): string {
  const p = r.trigger_payload ?? {};
  if (r.result?.subject) return [r.result.subject, p.minutes !== undefined ? `${p.minutes} min late` : null, p.days_overdue !== undefined ? `${p.days_overdue} days overdue` : null, p.days_until_expiry !== undefined ? `expires in ${p.days_until_expiry} days` : null, p.hours_since !== undefined ? `${p.hours_since}h waiting` : null, p.simulated ? 'sample event' : null].filter(Boolean).join(' · ');
  return [p.worker_name, p.company_name, p.candidate_name, p.days_overdue !== undefined ? `${p.days_overdue} days overdue` : null, p.days_until_expiry !== undefined ? `expires in ${p.days_until_expiry} days` : null, p.hours_since !== undefined ? `${p.hours_since}h waiting` : null, p.minutes !== undefined ? `${p.minutes} min late` : null, p.simulated ? 'sample event' : null].filter(Boolean).join(' · ') || (p.seeded ? 'Historical run' : '—');
}

export default function Runs() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const cat = useApi<Catalog>('/api/v1/automations/catalog');
  const autos = useApi<{ rows: any[] }>('/api/v1/automations?pageSize=200');
  const [open, setOpen] = useState<any>(null);
  const [key, setKey] = useState(0);
  const runId = sp.get('run');
  const focused = useApi<{ rows: any[] }>(runId ? `/api/v1/automations/runs/list?run=${runId}` : null, [key]);
  const current = open ?? (runId ? focused.data?.rows[0] : null);
  const close = () => { setOpen(null); if (runId) { const n = new URLSearchParams(sp); n.delete('run'); setSp(n, { replace: true }); } };
  const act = async (r: any, what: 'approve' | 'reject' | 'retry') => {
    let reason: string | undefined;
    if (what !== 'retry') {
      const c = await confirm({ title: what === 'approve' ? 'Approve and run these actions?' : 'Reject this run?', body: resultSummary(r), confirmLabel: what === 'approve' ? 'Approve & run' : 'Reject', danger: what === 'reject', reason: { label: what === 'approve' ? 'Note (optional)' : 'Reason', required: what === 'reject' } });
      if (!c.ok) return;
      reason = c.reason || undefined;
    }
    try {
      const res = await api.post<any>(`/api/v1/automations/runs/${r.id}/${what}`, { reason });
      toast.success(what === 'reject' ? 'Run rejected' : res.status === 'failed' ? 'Actions ran with errors — see details' : 'Actions executed');
      setOpen(res ? { ...r, ...res } : null); setKey(k => k + 1);
    } catch (e) { toast.error(e); }
  };
  const columns: Column<any>[] = [
    { key: 'created_at', label: 'When', sortable: true, render: r => <span title={dateTime(r.created_at)}>{relTime(r.created_at)}</span>, csv: r => r.created_at },
    { key: 'automation_name', label: 'Automation', mobile: 'title', sortable: true, render: r => <div><div className="bold">{r.automation_name}</div><div className="small muted">{triggerLabel(r, cat.data)}</div></div> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'subject', label: 'Trigger', render: r => <span className="small">{subjectOf(r)}</span>, csv: subjectOf },
    { key: 'result', label: 'Result', render: r => <span className={`small ${r.status === 'failed' ? 'down' : 'muted'}`} style={{ display: 'inline-block', maxWidth: 380, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{resultSummary(r)}</span>, csv: resultSummary },
    { key: 'approved_by_name', label: 'By', mobile: 'hidden' },
  ];
  return (
    <div>
      <PageHeader title="Run log" sub="Every automation run with its trigger, conditions and action results. Approve or reject runs that need a human." back="/automation"
        actions={<Button variant="primary" icon={<Zap size={16} />} onClick={() => nav('/automation')}>Workflows</Button>} />
      {sp.get('status') === 'pending_approval' && <Banner>Showing runs waiting for approval. Approving executes the planned actions immediately.</Banner>}
      <DataTable endpoint="/api/v1/automations/runs/list" columns={columns} reloadKey={key} exportName="automation-runs" exportResource="automation"
        filters={[{ key: 'status', label: 'Status', options: opts(STATUSES) }, { key: 'automation_id', label: 'Automation', options: (autos.data?.rows ?? []).map(a => ({ value: a.id, label: a.name })) }]}
        onRowClick={r => setOpen(r)} emptyTitle="No runs yet" emptyText="Runs appear here as soon as an automation fires."
        rowActions={r => [
          { label: 'Approve & run', icon: <Check size={15} />, onClick: () => act(r, 'approve'), hidden: r.status !== 'pending_approval' || !can('automation', 'approve') },
          { label: 'Reject', icon: <X size={15} />, danger: true, onClick: () => act(r, 'reject'), hidden: r.status !== 'pending_approval' || !can('automation', 'approve') },
          { label: 'Retry', icon: <RotateCcw size={15} />, onClick: () => act(r, 'retry'), hidden: r.status !== 'failed' || !can('automation', 'edit') },
          { label: 'View details', onClick: () => setOpen(r) },
        ]} />
      {current && (
        <Drawer open onClose={close} title={current.automation_name} footer={<>
          {current.status === 'pending_approval' && can('automation', 'approve') && <><Button variant="danger" icon={<X size={15} />} onClick={() => act(current, 'reject')}>Reject</Button><Button variant="primary" icon={<Check size={15} />} onClick={() => act(current, 'approve')}>Approve & run</Button></>}
          {current.status === 'failed' && can('automation', 'edit') && <Button variant="primary" icon={<RotateCcw size={15} />} onClick={() => act(current, 'retry')}>Retry</Button>}
          <Button onClick={close}>Close</Button>
        </>}>
          <KV items={[['Status', <StatusPill key="s" status={current.status} />], ['When', dateTime(current.created_at)], ['Trigger', triggerLabel(current, cat.data)], ['Subject', subjectOf(current)], ['Decided by', current.approved_by_name ?? '—'], ...(current.result?.rejected_reason ? [['Rejection reason', current.result.rejected_reason] as [string, string]] : [])]} />
          {Array.isArray(current.result?.conditions) && current.result.conditions.length > 0 && <><div className="ins-step mt-3">Conditions</div>{current.result.conditions.map((c: any, i: number) => <div key={i} className="small">{c.pass ? '✅' : '❌'} {humanize(c.field)} {c.op} {String(c.value)} <span className="muted">(actual: {c.actual === null ? 'empty' : String(c.actual)})</span></div>)}</>}
          {Array.isArray(current.result?.planned) && <><div className="ins-step mt-3">Planned actions</div>{current.result.planned.map((p: any, i: number) => <div key={i} className="small">• {p.summary}</div>)}</>}
          {Array.isArray(current.result?.actions) && <><div className="ins-step mt-3">Action results</div>{current.result.actions.map((a: any, i: number) => <div key={i} className="small" style={{ marginBottom: 4 }}>{a.ok ? '✅' : '❌'} <b>{humanize(a.type)}</b> — {a.detail}</div>)}</>}
          {current.result?.error && <div className="errorbox mt-2"><div><b>Error</b><div className="small">{current.result.error}</div></div></div>}
          <div className="ins-step mt-3">Trigger payload</div>
          <pre className="ins-pre">{JSON.stringify(Object.fromEntries(Object.entries(current.trigger_payload ?? {}).filter(([k]) => !k.endsWith('_id') && k !== 'dedupe_key')), null, 2)}</pre>
        </Drawer>
      )}
    </div>
  );
}
