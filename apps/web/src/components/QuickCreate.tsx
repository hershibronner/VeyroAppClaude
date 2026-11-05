import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Menu } from './ui';

export interface QuickCreateDef { key: string; label: string; icon?: ReactNode; perm?: [string, ('create' | 'edit')?]; order?: number; render: (close: () => void) => ReactNode }
// Each area contributes creators in src/quick/<area>.tsx (export const quickCreate: QuickCreateDef[]).
const mods = import.meta.glob<{ quickCreate?: QuickCreateDef[] }>('../quick/*.tsx', { eager: true });
export const QUICK_CREATE: QuickCreateDef[] = Object.values(mods).flatMap(m => m.quickCreate ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

export function useQuickCreate() {
  const { can } = useAuth();
  const [active, setActive] = useState<QuickCreateDef | null>(null);
  const items = QUICK_CREATE.filter(q => !q.perm || can(q.perm[0], q.perm[1] ?? 'create'));
  return { items, open: (key: string) => setActive(items.find(i => i.key === key) ?? null), element: active ? active.render(() => setActive(null)) : null };
}

/** The (+) button in the top bar: opens the real create form drawer for each entity. */
export function QuickCreateButton() {
  const qc = useQuickCreate();
  if (!qc.items.length) return null;
  return (
    <>
      <Menu label="Quick create" trigger={<button className="icon-btn brand" aria-label="Quick create" title="Quick create"><Plus size={18} /></button>} items={qc.items.map(i => ({ label: `New ${i.label}`, icon: i.icon, onClick: () => qc.open(i.key) }))} />
      {qc.element}
    </>
  );
}
