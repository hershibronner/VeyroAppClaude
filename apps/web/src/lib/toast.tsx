import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { ApiError } from './api';

type T = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const Ctx = createContext<{ push: (k: T['kind'], text: string) => void }>({ push: () => {} });
let externalPush: ((k: T['kind'], text: string) => void) | null = null;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((kind: T['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems(i => [...i.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems(i => i.filter(x => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  externalPush = push;
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'success' ? <CheckCircle2 size={18} /> : t.kind === 'error' ? <AlertCircle size={18} /> : <Info size={18} />}
            <div style={{ flex: 1 }}>{t.text}</div>
            <button className="icon-btn" style={{ width: 22, height: 22, color: '#fff' }} aria-label="Dismiss" onClick={() => setItems(i => i.filter(x => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export function useToast() { return useContext(Ctx); }
/** Global toast helpers usable outside React components. */
export const toast = {
  success: (t: string) => externalPush?.('success', t),
  info: (t: string) => externalPush?.('info', t),
  error: (e: unknown) => externalPush?.('error', e instanceof ApiError || e instanceof Error ? e.message : String(e)),
};
