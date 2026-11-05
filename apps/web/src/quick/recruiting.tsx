// Quick Create (+) entries for Recruiting: the real create drawers; after save we open the new record.
import { useNavigate } from 'react-router-dom';
import { UserPlus, Briefcase } from 'lucide-react';
import type { QuickCreateDef } from '../components/QuickCreate';
import { CandidateForm, PositionForm } from '../modules/recruiting/shared';

function QCandidate({ close }: { close: () => void }) { const nav = useNavigate(); return <CandidateForm open onClose={close} onSaved={c => nav(`/recruiting/candidates/${c.id}`)} />; }
function QPosition({ close }: { close: () => void }) { const nav = useNavigate(); return <PositionForm open onClose={close} onSaved={p => nav(`/recruiting/positions/${p.id}`)} />; }

export const quickCreate: QuickCreateDef[] = [
  { key: 'candidate', label: 'Candidate', icon: <UserPlus size={16} />, perm: ['candidates', 'create'], order: 20, render: close => <QCandidate close={close} /> },
  { key: 'position', label: 'Position', icon: <Briefcase size={16} />, perm: ['positions', 'create'], order: 21, render: close => <QPosition close={close} /> },
];
