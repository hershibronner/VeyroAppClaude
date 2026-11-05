import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Star } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { relTime } from '../../lib/format';
import { Button, PageHeader, Person, useConfirm } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ContactForm } from './forms';
import { companyLink } from './common';

export default function Contacts() {
  const { can, scope, me } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [rk, setRk] = useState(0);
  const columns: Column<any>[] = [
    { key: 'name', label: 'Name', sortable: true, mobile: 'title', render: r => <Person name={r.name} sub={r.title ?? undefined} size={30} />, csv: r => r.name },
    { key: 'company_name', label: 'Company', sortable: true, mobile: 'subtitle', render: r => r.company_id ? <Link to={companyLink({ id: r.company_id, stage: r.company_stage })} onClick={e => e.stopPropagation()}>{r.company_name}</Link> : <span className="muted">No company</span> },
    { key: 'is_primary', label: 'Primary', render: r => r.is_primary ? <span className="pill pill-blue"><Star size={11} /> Primary</span> : <span className="muted">—</span>, csv: r => (r.is_primary ? 'Yes' : 'No') },
    { key: 'email', label: 'Email', render: r => r.email ? <a href={`mailto:${r.email}`} onClick={e => e.stopPropagation()}>{r.email}</a> : <span className="muted">—</span> },
    { key: 'phone', label: 'Phone' },
    { key: 'methods_count', label: 'Methods', align: 'center', mobile: 'hidden' },
    { key: 'last_activity_at', label: 'Last activity', sortable: true, mobile: 'hidden', render: r => <span className="muted small">{relTime(r.last_activity_at)}</span> },
  ];
  return (
    <div>
      <PageHeader title="Contacts" sub="People at leads and clients. Each contact can have several emails and phone numbers."
        actions={can('contacts', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New Contact</Button>} />
      <DataTable title="All contacts" endpoint="/api/v1/contacts" columns={columns} reloadKey={rk} rowLink={r => `/crm/contacts/${r.id}`} exportName="contacts" exportResource="contacts" defaultSort="name" defaultDir="asc"
        searchPlaceholder="Search name, email, phone, company"
        filters={[
          { key: 'stage', label: 'Company type', options: [{ value: 'lead', label: 'Leads' }, { value: 'client', label: 'Clients' }] },
          { key: 'has_company', label: 'Has company', type: 'boolean' }, { key: 'primary', label: 'Primary contact', type: 'boolean' },
          { key: 'portal', label: 'Has portal access', type: 'boolean' },
        ]}
        rowActions={(r, reload) => [
          { label: 'Open', onClick: () => nav(`/crm/contacts/${r.id}`) },
          { label: 'Archive', danger: true, hidden: !(scope('contacts', 'delete') === 'all' || (scope('contacts', 'delete') === 'own')), onClick: async () => {
            const c = await confirm({ title: `Archive ${r.name}?`, body: scope('contacts', 'delete') === 'own' && me ? 'You can archive contacts you created.' : undefined, danger: true, confirmLabel: 'Archive' });
            if (!c.ok) return; try { await api.del(`/api/v1/contacts/${r.id}`); toast.success('Contact archived'); reload(); } catch (e) { toast.error(e); }
          } },
        ]}
        emptyTitle="No contacts yet" />
      <ContactForm open={creating} onClose={() => setCreating(false)} onSaved={r => { setRk(k => k + 1); nav(`/crm/contacts/${r.id}`); }} />
    </div>
  );
}
