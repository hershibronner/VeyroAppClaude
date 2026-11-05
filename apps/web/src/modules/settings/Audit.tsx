import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileClock, KeyRound, ShieldAlert, UserCog } from 'lucide-react';
import { qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { dateTime, humanize } from '../../lib/format';
import { Button, Drawer, KpiRow, KV, LoadingBlock, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { toast } from '../../lib/toast';
import { Gate } from './common';

export default function AuditLog() {
  return <Gate resource="audit">{() => <Inner />}</Gate>;
}

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Inner() {
  const [sp, setSp] = useSearchParams();
  const facets = useApi<any>('/api/v1/audit/facets');
  const [open, setOpen] = useState<string | null>(null);
  const confirm = useConfirm();
  const f = facets.data;
  const filterKeys = ['actor', 'action', 'entity', 'from', 'to', 'impersonated', 'search'];
  const exportCsv = async () => {
    const r = await confirm({ title: 'Export audit log?', body: 'The export is itself recorded in the audit log and Owners/Admins are notified.', confirmLabel: 'Export CSV' });
    if (!r.ok) return;
    const params = Object.fromEntries(filterKeys.map(k => [k, sp.get(k) ?? '']));
    const a = document.createElement('a'); a.href = `/api/v1/audit/export.csv${qs(params)}`; a.download = ''; a.click();
    toast.success('Export started'); setTimeout(() => facets.reload(), 1500);
  };
  return (
    <div className="stack">
      <PageHeader title="Audit Log" sub="Append-only record of sensitive actions: who did what, when, from where, and what changed. Entries cannot be edited or deleted."
        actions={f?.can_export && <Button variant="primary" icon={<Download size={16} />} onClick={exportCsv}>Export CSV</Button>} />
      {f && <KpiRow items={[
        { label: 'Events recorded', value: f.stats.total.toLocaleString(), icon: <FileClock size={16} />, deltaText: `${f.stats.last_24h} in the last 24 hours`, suffix: '', onClick: () => setSp({}) },
        { label: 'Access changes', value: f.stats.access_changes, icon: <UserCog size={16} />, deltaText: 'roles, members, permissions', suffix: '', onClick: () => setSp({ action: 'role.' }) },
        { label: 'Exports', value: f.stats.exports, icon: <KeyRound size={16} />, deltaText: 'lists & audit exports', suffix: '', onClick: () => setSp({ action: 'export' }) },
        { label: 'Support-mode actions', value: f.stats.impersonated, icon: <ShieldAlert size={16} />, deltaText: 'done by VeyroApp support', suffix: '', onClick: () => setSp({ impersonated: 'true' }) },
      ]} />}
      <DataTable<any> title="Events" endpoint="/api/v1/audit" exportName="audit-log" exportResource="audit" onRowClick={r => setOpen(r.id)} searchPlaceholder="Search action, record, person"
        filters={[
          { key: 'actor', label: 'Actor', options: (f?.actors ?? []).map((a: any) => ({ value: a.id, label: `${a.name} (${a.n})` })) },
          { key: 'action', label: 'Action', options: (f?.actions ?? []).map((a: any) => ({ value: `${a.prefix}.`, label: `${humanize(a.prefix)} (${a.n})` })) },
          { key: 'entity', label: 'Record type', options: (f?.entities ?? []).map((e: any) => ({ value: e.entity_type, label: `${humanize(e.entity_type)} (${e.n})` })) },
          { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' },
          { key: 'impersonated', label: 'Support mode', type: 'boolean' },
        ]}
        columns={[
          { key: 'created_at', label: 'When', sortable: true, mobile: 'subtitle', render: r => dateTime(r.created_at), csv: r => r.created_at },
          { key: 'actor_label', label: 'Actor', sortable: true, render: r => <span>{r.actor_label ?? 'System'}{r.impersonator_name && <div className="tiny" style={{ color: 'var(--warning)' }}>via support: {r.impersonator_name}</div>}</span> },
          { key: 'action', label: 'Action', sortable: true, mobile: 'title', render: r => <span className="mono small">{r.action}</span> },
          { key: 'entity_label', label: 'Record', render: r => r.entity_label || r.entity_type ? <span>{r.entity_label ?? '—'}<div className="tiny muted">{humanize(r.entity_type)}</div></span> : '—' },
          { key: 'reason', label: 'Reason', render: r => r.reason ? <span className="small">{r.reason}</span> : '—' },
          { key: 'has_diff', label: 'Changes', render: r => r.has_diff ? <StatusPill status="open" label="View diff" /> : '—' },
          { key: 'ip', label: 'IP', mobile: 'hidden' },
        ]} />
      <DiffDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function DiffDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const st = useApi<any>(id ? `/api/v1/audit/${id}` : null, [id]);
  const a = st.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={a ? a.action : 'Audit event'} wide>
      {!a ? <LoadingBlock /> : (
        <div className="stack" style={{ gap: 16 }}>
          <KV items={[['When', dateTime(a.created_at)], ['Actor', `${a.actor_label ?? 'System'}${a.actor_email ? ` (${a.actor_email})` : ''}`], ...(a.impersonator_name ? [['Support mode', `Performed by ${a.impersonator_name} (VeyroApp support) while impersonating`] as [string, string]] : []), ['Record', `${a.entity_label ?? '—'} · ${humanize(a.entity_type)}`], ['Reason', a.reason ?? '—'], ['IP address', a.ip ?? '—'], ['Event ID', `#${a.id}`]]} />
          {a.diff.length > 0 ? (
            <table className="st-diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
              {a.diff.map((d: any) => <tr key={d.key}><td className="mono">{d.key}</td><td className={d.changed ? 'before' : 'same'}>{fmt(d.before)}</td><td className={d.changed ? 'after' : 'same'}>{fmt(d.after)}</td></tr>)}
            </tbody></table>
          ) : (a.before || a.after) ? <pre className="st-code">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre> : <div className="small muted">This event has no before/after data.</div>}
        </div>
      )}
    </Drawer>
  );
}
