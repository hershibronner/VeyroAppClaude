import { Receipt } from 'lucide-react';
import type { QuickCreateDef } from '../components/QuickCreate';
import { Drawer } from '../components/ui';
import { InvoiceGenerator } from '../modules/finance/InvoiceNew';

export const quickCreate: QuickCreateDef[] = [
  { key: 'invoice', label: 'Invoice', icon: <Receipt size={16} />, perm: ['invoices', 'create'], order: 80, render: close => <Drawer open onClose={close} title="New invoice" wide><InvoiceGenerator compact onDone={close} /></Drawer> },
];
