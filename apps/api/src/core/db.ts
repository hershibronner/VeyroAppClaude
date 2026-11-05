import { createPool, type PoolClient } from '@veyro/db';

export const pool = createPool(20);
export type Db = Pick<PoolClient, 'query'>;

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query(sql, params as any[])).rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const r = await q<T>(sql, params, db);
  return r[0] ?? null;
}
/** Runs fn inside a transaction. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
/** Builds "INSERT ... RETURNING *" from an object. Undefined values are skipped. */
export async function insertRow<T = any>(table: string, row: Record<string, unknown>, db: Db = pool): Promise<T> {
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`;
  return (await db.query(sql, cols.map(k => row[k]) as any[])).rows[0] as T;
}
/** UPDATE by id + organization_id. Undefined values are skipped. Returns the updated row or null. */
export async function updateRow<T = any>(table: string, orgId: string, id: string, patch: Record<string, unknown>, db: Db = pool): Promise<T | null> {
  const cols = Object.keys(patch).filter(k => patch[k] !== undefined);
  if (!cols.length) return one<T>(`SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2`, [id, orgId], db);
  const hasUpdatedAt = ['companies', 'contacts', 'opportunities', 'tasks', 'positions', 'candidates', 'candidate_submissions', 'interviews', 'offers', 'workers', 'placements', 'timesheets', 'invoices', 'payroll_runs', 'templates', 'document_templates', 'automations', 'report_definitions', 'support_tickets'].includes(table);
  const sets = cols.map((k, i) => `${k}=$${i + 3}`).concat(hasUpdatedAt && !cols.includes('updated_at') ? ['updated_at=now()'] : []);
  return one<T>(`UPDATE ${table} SET ${sets.join(',')} WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, orgId, ...cols.map(k => patch[k])], db);
}
