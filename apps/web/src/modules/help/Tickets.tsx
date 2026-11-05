import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, CheckCircle2, Clock, Inbox, MessageSquarePlus, RotateCcw, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { dateTime, humanize, relTime } from '../../lib/format';
import { Button, Drawer, KpiRow, LoadingBlock, PageHeader, StatusPill, ErrorState } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { FormDrawer } from '../../components/FormDrawer';
import '../settings/settings.css';

const CATS = ['general', 'how_to', 'bug', 'billing', 'data_import', 'feature_request', 'security'];

export default function SupportTickets() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const summary = useApi<any>('/api/v1/support/summary');
  const [rk, setRk] = useState(0);
  const ticketId = sp.get('ticket');
  const creating = sp.get('new') === '1';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const reload = () => { setRk(k => k + 1); summary.reload(); };
  const s = summary.data;
  return (
    <div className="stack">
      <PageHeader title="Support Tickets" sub="Conversations with the VeyroApp support team. Owners and Admins see every ticket from your agency."
        actions={<><Button icon={<BookOpen size={16} />} onClick={() => nav('/help')}>Help articles</Button><Button variant="primary" icon={<MessageSquarePlus size={16} />} onClick={() => set({ new: '1' })}>New ticket</Button></>} />
      {s && <KpiRow items={[
        { label: 'Open', value: s.open, icon: <Inbox size={16} />, deltaText: 'waiting on support', suffix: '', onClick: () => set({ status: 'open' }) },
        { label: 'Awaiting your reply', value: s.pending, icon: <Clock size={16} />, deltaText: 'support has answered', suffix: '', onClick: () => set({ status: 'pending' }) },
        { label: 'Resolved', value: s.resolved, icon: <CheckCircle2 size={16} />, deltaText: `${s.total} tickets in total`, suffix: '', onClick: () => set({ status: 'resolved' }) },
        { label: 'First response', value: s.avg_first_response_hours !== null && s.avg_first_response_hours !== undefined ? `${s.avg_first_response_hours}h` : '—', icon: <Send size={16} />, deltaText: 'average', suffix: '' },
      ]} />}
      <DataTable<any> title="Tickets" endpoint="/api/v1/support/tickets" reloadKey={rk} exportName="support-tickets" onRowClick={r => set({ ticket: r.id })} defaultSort="updated_at"
        filters={[{ key: 'status', label: 'Status', options: opts(['open', 'pending', 'resolved'], { pending: 'Awaiting your reply' }) }, { key: 'category', label: 'Category', options: opts(CATS) }, { key: 'mine', label: 'Opened by me', type: 'boolean' }]}
        emptyTitle="No tickets" emptyText="Need a hand? Open a ticket and the VeyroApp team will reply here." emptyAction={<Button size="sm" variant="primary" onClick={() => set({ new: '1' })}>New ticket</Button>}
        columns={[
          { key: 'subject', label: 'Subject', mobile: 'title', render: r => <span className="bold">{r.subject}</span> },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} label={r.status === 'pending' ? 'Awaiting your reply' : undefined} /> },
          { key: 'priority', label: 'Priority', sortable: true, render: r => <StatusPill status={r.priority} /> },
          { key: 'category', label: 'Category', render: r => humanize(r.category) },
          { key: 'created_by_name', label: 'Opened by', mobile: 'subtitle' },
          { key: 'replies', label: 'Replies', align: 'right' },
          { key: 'updated_at', label: 'Last update', sortable: true, render: r => relTime(r.updated_at) },
        ]} />
      <FormDrawer open={creating} onClose={() => set({ new: null, subject: null })} title="Contact VeyroApp support" submitLabel="Send ticket" initial={{ subject: sp.get('subject') ?? '', priority: 'normal', category: 'general' }}
        fields={[
          { name: 'subject', label: 'Subject', required: true, full: true, placeholder: 'Short summary of the problem' },
          { name: 'category', label: 'Category', type: 'select', required: true, options: opts(CATS, { how_to: 'How do I…', data_import: 'Data import' }) },
          { name: 'priority', label: 'Priority', type: 'select', required: true, options: [{ value: 'low', label: 'Low — question' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High — blocking work' }, { value: 'urgent', label: 'Urgent — payroll/billing down' }] },
          { name: 'body', label: 'Details', type: 'textarea', required: true, full: true, placeholder: 'What happened, what you expected, and which records are affected.' },
        ]}
        onSubmit={async v => { const t = await api.post('/api/v1/support/tickets', v); toast.success('Ticket sent — the VeyroApp team has been notified'); reload(); set({ new: null, subject: null, ticket: t.id }); }} />
      <TicketDrawer id={ticketId} onClose={() => set({ ticket: null })} onChange={reload} />
    </div>
  );
}

function TicketDrawer({ id, onClose, onChange }: { id: string | null; onClose: () => void; onChange: () => void }) {
  const st = useApi<any>(id ? `/api/v1/support/tickets/${id}` : null, [id]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState('');
  const t = st.data;
  const reply = async () => { setBusy('r'); try { await api.post(`/api/v1/support/tickets/${id}/replies`, { body }); setBody(''); st.reload(); onChange(); toast.success('Reply sent'); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  const act = async (a: 'resolve' | 'reopen') => { setBusy(a); try { await api.post(`/api/v1/support/tickets/${id}/${a}`); st.reload(); onChange(); toast.success(a === 'resolve' ? 'Ticket resolved' : 'Ticket reopened'); } catch (e) { toast.error(e); } finally { setBusy(''); } };
  return (
    <Drawer open={!!id} onClose={onClose} title={t?.subject ?? 'Ticket'} wide footer={t && (t.status === 'resolved' ? <Button icon={<RotateCcw size={16} />} loading={busy === 'reopen'} onClick={() => act('reopen')}>Reopen ticket</Button> : <><Button loading={busy === 'resolve'} icon={<CheckCircle2 size={16} />} onClick={() => act('resolve')}>Mark resolved</Button><Button variant="primary" icon={<Send size={16} />} disabled={!body.trim()} loading={busy === 'r'} onClick={reply}>Send reply</Button></>)}>
      {st.error && !t ? <ErrorState error={st.error} retry={st.reload} /> : !t ? <LoadingBlock /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 8 }}><StatusPill status={t.status} label={t.status === 'pending' ? 'Awaiting your reply' : undefined} /><StatusPill status={t.priority} /><span className="small muted">{humanize(t.category)} · opened by {t.created_by_name ?? '—'} {relTime(t.created_at)}</span></div>
          <div className="st-thread">
            <div className="st-msg"><div className="small bold">{t.created_by_name ?? 'You'} <span className="muted" style={{ fontWeight: 400 }}>· {dateTime(t.created_at)}</span></div><div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{t.body}</div></div>
            {t.replies.map((r: any) => <div key={r.id} className={`st-msg ${r.is_staff ? 'staff' : ''}`}><div className="small bold">{r.author_name ?? '—'} <span className="muted" style={{ fontWeight: 400 }}>· {dateTime(r.created_at)}</span></div><div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.body}</div></div>)}
          </div>
          {t.status !== 'resolved' && <div className="field"><label htmlFor="tk-reply">Reply</label><textarea id="tk-reply" className="textarea" value={body} onChange={e => setBody(e.target.value)} placeholder="Add details or answer the support team" /></div>}
        </div>
      )}
    </Drawer>
  );
}
