import { Link, useNavigate } from 'react-router-dom';
import { Phone, Mail, Users, StickyNote, MessageSquare, RefreshCw, Zap, AtSign } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { dateTime, relTime } from '../../lib/format';
import { Boundary, ErrorState, KpiRow, PageHeader, Person, Button } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { relatedLink, RELATED_LABEL } from './common';

const KIND_ICON: Record<string, any> = { call: Phone, email: Mail, meeting: Users, note: StickyNote, message: MessageSquare, status_change: RefreshCw, system: Zap };
const KINDS = [{ value: 'call', label: 'Calls' }, { value: 'email', label: 'Emails' }, { value: 'meeting', label: 'Meetings' }, { value: 'note', label: 'Notes' }, { value: 'message', label: 'Messages' }, { value: 'status_change', label: 'Status changes' }, { value: 'system', label: 'System events' }];

export default function Activities() {
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/activities/stats');
  const s = st.data;
  const touchDelta = s && s.touches_prev_7d ? ((s.touches_7d - s.touches_prev_7d) / s.touches_prev_7d) * 100 : null;
  const columns: Column<any>[] = [
    { key: 'kind', label: 'Type', width: 130, render: r => { const Ic = KIND_ICON[r.kind] ?? Zap; return <span className="row" style={{ gap: 6 }}><span className="tl-ic" style={{ width: 26, height: 26 }}><Ic size={13} /></span><span className="small">{KINDS.find(k => k.value === r.kind)?.label.replace(/s$/, '') ?? r.kind}</span></span>; }, csv: r => r.kind },
    { key: 'title', label: 'Activity', mobile: 'title', render: r => <div style={{ maxWidth: 520 }}><div className="bold">{r.title}{r.mention_count > 0 && <span className="muted small"> <AtSign size={12} />{r.mention_count}</span>}</div>{r.body && <div className="muted small truncate">{r.body}</div>}</div>, csv: r => `${r.title}${r.body ? ' — ' + r.body : ''}` },
    { key: 'entity_label', label: 'Record', mobile: 'subtitle', render: r => { const l = relatedLink(r.entity_type, r.entity_id, r.entity_stage); return <span><span className="muted small">{RELATED_LABEL[r.entity_type] ?? r.entity_type}: </span>{l && r.entity_label ? <Link to={l} onClick={e => e.stopPropagation()}>{r.entity_label}</Link> : r.entity_label ?? <span className="muted">deleted record</span>}</span>; }, csv: r => r.entity_label },
    { key: 'actor_name', label: 'By', sortable: true, render: r => r.actor_name ? <Person name={r.actor_name} color={r.actor_color} size={24} /> : <span className="muted">System</span> },
    { key: 'created_at', label: 'When', sortable: true, render: r => <span title={dateTime(r.created_at)} className="small">{relTime(r.created_at)}</span>, csv: r => r.created_at },
  ];
  return (
    <div>
      <PageHeader title="Activities" sub="Every call, meeting, note, message, status change and system event across your records."
        actions={<Button onClick={() => nav('/crm/activities?mentions=me')}><AtSign size={15} /> Mentions of me</Button>} />
      <Boundary label="Activity KPIs">
        {st.error ? <ErrorState error={st.error} retry={st.reload} /> : (
          <KpiRow items={[
            { label: 'Calls (7 days)', icon: <Phone size={16} />, value: s?.calls_7d ?? '…', delta: touchDelta, suffix: 'touches vs prior week', to: s ? `/crm/activities?kind=call&from=${s.from_7d}` : undefined },
            { label: 'Emails (7 days)', icon: <Mail size={16} />, value: s?.emails_7d ?? '…', deltaText: <span className="muted">sent or logged</span>, suffix: '', to: s ? `/crm/activities?kind=email&from=${s.from_7d}` : undefined },
            { label: 'Meetings (7 days)', icon: <Users size={16} />, value: s?.meetings_7d ?? '…', deltaText: <span className="muted">logged</span>, suffix: '', to: s ? `/crm/activities?kind=meeting&from=${s.from_7d}` : undefined },
            { label: 'Notes (7 days)', icon: <StickyNote size={16} />, value: s?.notes_7d ?? '…', deltaText: <span className="muted">incl. @mentions</span>, suffix: '', to: s ? `/crm/activities?kind=note&from=${s.from_7d}` : undefined },
          ]} />
        )}
      </Boundary>
      <DataTable title="Activity feed" endpoint="/api/v1/activities" columns={columns} exportName="activities" exportResource="activities" defaultSort="created_at"
        rowLink={r => relatedLink(r.entity_type, r.entity_id, r.entity_stage)} searchPlaceholder="Search activity"
        filters={[
          { key: 'kind', label: 'Type', options: KINDS },
          { key: 'entity_type', label: 'Record type', options: Object.entries(RELATED_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'actor', label: 'By', type: 'member' },
          { key: 'crm', label: 'CRM records only', type: 'boolean' },
          { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' },
          { key: 'mentions', label: 'Mentions', options: [{ value: 'me', label: 'Mentioning me' }] },
        ]}
        emptyTitle="No activity yet" />
    </div>
  );
}
