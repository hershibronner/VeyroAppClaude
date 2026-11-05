import type { FastifyRequest } from 'fastify';
import { q, type Db, pool } from './db';

export interface ListParams { page: number; pageSize: number; search: string; sort: string | null; dir: 'asc' | 'desc'; filters: Record<string, string> }
export function listParams(req: FastifyRequest): ListParams {
  const qs = (req.query ?? {}) as Record<string, string>;
  const { page, pageSize, search, sort, dir, ...filters } = qs;
  return { page: Math.max(1, Number(page) || 1), pageSize: Math.min(5000, Math.max(1, Number(pageSize) || 25)), search: (search ?? '').trim(), sort: sort || null, dir: dir === 'asc' ? 'asc' : 'desc', filters };
}

/**
 * Paginated list. `from` is the FROM/JOIN clause; `where` items are SQL with $n placeholders relative
 * to `params`. `sortMap` whitelists sortable keys → SQL expressions (never interpolate user input).
 */
export async function paged<T = any>(opts: { select: string; from: string; where: string[]; params: unknown[]; lp: ListParams; searchCols?: string[]; sortMap: Record<string, string>; defaultSort: string; groupBy?: string; db?: Db }) {
  const params = [...opts.params];
  const where = [...opts.where];
  if (opts.lp.search && opts.searchCols?.length) {
    params.push(`%${opts.lp.search}%`);
    where.push('(' + opts.searchCols.map(c => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sortExpr = (opts.lp.sort && opts.sortMap[opts.lp.sort]) ? `${opts.sortMap[opts.lp.sort]} ${opts.lp.dir} NULLS LAST` : opts.defaultSort;
  const gb = opts.groupBy ? `GROUP BY ${opts.groupBy}` : '';
  const db = opts.db ?? pool;
  const total = Number((await q<any>(`SELECT count(*)::int n FROM (SELECT 1 FROM ${opts.from} ${w} ${gb}) x`, params, db))[0].n);
  params.push(opts.lp.pageSize, (opts.lp.page - 1) * opts.lp.pageSize);
  const rows = await q<T>(`SELECT ${opts.select} FROM ${opts.from} ${w} ${gb} ORDER BY ${sortExpr} LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return { rows, total, page: opts.lp.page, pageSize: opts.lp.pageSize };
}

/** Converts rows to CSV (used by every list's Export). */
export function toCsv(rows: Record<string, unknown>[], columns?: { key: string; label: string }[]): string {
  const cols = columns ?? Object.keys(rows[0] ?? {}).map(k => ({ key: k, label: k }));
  const esc = (v: unknown) => { if (v === null || v === undefined) return ''; const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(r[c.key])).join(','))].join('\n');
}
