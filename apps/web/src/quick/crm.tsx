// Quick Create (+) entries for CRM: real create drawers; after save we open the new record.
import { useNavigate } from 'react-router-dom';
import { Target, Building2, UserRound, CircleDollarSign, ListTodo } from 'lucide-react';
import type { QuickCreateDef } from '../components/QuickCreate';
import { LeadForm, ClientForm, ContactForm, OpportunityForm, TaskForm } from '../modules/crm/forms';

function QLead({ close }: { close: () => void }) { const nav = useNavigate(); return <LeadForm open onClose={close} onSaved={r => nav(`/crm/leads/${r.id}`)} />; }
function QClient({ close }: { close: () => void }) { const nav = useNavigate(); return <ClientForm open onClose={close} onSaved={r => nav(`/crm/clients/${r.id}`)} />; }
function QContact({ close }: { close: () => void }) { const nav = useNavigate(); return <ContactForm open onClose={close} onSaved={r => nav(`/crm/contacts/${r.id}`)} />; }
function QOpp({ close }: { close: () => void }) { const nav = useNavigate(); return <OpportunityForm open onClose={close} onSaved={r => nav(`/crm/opportunities/${r.id}`)} />; }
function QTask({ close }: { close: () => void }) { const nav = useNavigate(); return <TaskForm open onClose={close} onSaved={r => nav(`/crm/tasks?view=team&task=${r.id}`)} />; }

export const quickCreate: QuickCreateDef[] = [
  { key: 'lead', label: 'Lead', icon: <Target size={16} />, perm: ['leads', 'create'], order: 10, render: close => <QLead close={close} /> },
  { key: 'client', label: 'Client', icon: <Building2 size={16} />, perm: ['clients', 'create'], order: 11, render: close => <QClient close={close} /> },
  { key: 'contact', label: 'Contact', icon: <UserRound size={16} />, perm: ['contacts', 'create'], order: 12, render: close => <QContact close={close} /> },
  { key: 'opportunity', label: 'Opportunity', icon: <CircleDollarSign size={16} />, perm: ['opportunities', 'create'], order: 13, render: close => <QOpp close={close} /> },
  { key: 'task', label: 'Task', icon: <ListTodo size={16} />, perm: ['tasks', 'create'], order: 40, render: close => <QTask close={close} /> },
];
