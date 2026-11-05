import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/** Loads JSON from `url` (null = skip). Keeps previous data while reloading. */
export function useApi<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) { setLoading(false); return; }
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api.get<T>(url);
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally { if (my === seq.current) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Runs an async action with a busy flag; returns [run, busy]. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>): [(...a: A) => Promise<R | undefined>, boolean] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (...a: A) => {
    setBusy(true);
    try { return await fn(...a); } finally { setBusy(false); }
  }, [fn]);
  return [run, busy];
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { if (ms === null) return; const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [ms]);
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const h = () => setM(mq.matches); mq.addEventListener('change', h); return () => mq.removeEventListener('change', h); }, [q]);
  return m;
}
