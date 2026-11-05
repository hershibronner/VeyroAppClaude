// Fetch wrapper: same-origin cookies, CSRF header on mutations, typed errors.
export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>, public details?: any) { super(message); }
}
let csrf = '';
export function setCsrf(t: string) { csrf = t; }
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function request<T>(method: string, url: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !url.includes('/auth/')) onUnauthorized();
    const d = (typeof data === 'object' ? data : {}) as any;
    throw new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.fields, d.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T = any>(url: string, body?: unknown) => request<T>('DELETE', url, body),
  upload: <T = any>(url: string, form: FormData) => request<T>('POST', url, form, true),
};

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
