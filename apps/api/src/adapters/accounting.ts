// AccountingAdapter (simulated QuickBooks Online). Pushes invoices/payments/credit notes to a local
// accounting_sync_log with mock external ids. A configurable share of first attempts fails with a
// realistic error (integrations.config.failure_rate, default 0.15) so failures can be retried.
import crypto from 'node:crypto';
import { one, q, type Db, pool } from '../core/db';

const ERRORS = [
  'Customer not found in QuickBooks (mapping missing)',
  'QuickBooks rate limit reached (429) — try again shortly',
  'Income account "Staffing Revenue" is inactive in QuickBooks',
];
export type SyncEntity = 'invoice' | 'payment' | 'credit_note';

export async function syncEntity(orgId: string, type: SyncEntity, id: string, db: Db = pool) {
  const integ = await one<any>(`SELECT status, config FROM integrations WHERE organization_id=$1 AND key='accounting'`, [orgId], db);
  const prev = await one<any>(`SELECT * FROM accounting_sync_log WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY created_at DESC LIMIT 1`, [orgId, type, id], db);
  const attempts = (prev?.attempts ?? 0) + 1;
  if (prev?.status === 'synced') return { log: prev, already: true };
  let status: 'synced' | 'failed'; let error: string | null = null; let externalId: string | null = null;
  if (integ && integ.status !== 'connected') { status = 'failed'; error = 'Accounting integration is disconnected — reconnect it in Settings → Integrations'; }
  else {
    const rate = Number(integ?.config?.failure_rate ?? 0.15);
    const fail = Math.random() < (attempts > 1 ? rate / 3 : rate);
    if (fail) { status = 'failed'; error = ERRORS[Math.floor(Math.random() * ERRORS.length)]; }
    else { status = 'synced'; externalId = `QBO-${type === 'invoice' ? '' : type === 'payment' ? 'PMT-' : 'CM-'}${10000 + (parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 6), 16) % 89999)}`; }
  }
  const log = (await q<any>(`INSERT INTO accounting_sync_log (organization_id, entity_type, entity_id, status, external_id, error, attempts) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [orgId, type, id, status, externalId, error, attempts], db))[0];
  if (status === 'synced' && type === 'invoice') await q(`UPDATE invoices SET accounting_external_id=$2 WHERE id=$1 AND organization_id=$3`, [id, externalId, orgId], db);
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'accounting',$2,$3,$4)`, [orgId, status === 'synced' ? 'info' : 'error', status === 'synced' ? `Synced ${type.replace('_', ' ')} → ${externalId}` : `Sync failed for ${type.replace('_', ' ')}: ${error}`, JSON.stringify({ entity_type: type, entity_id: id, attempts })], db);
  await q(`UPDATE integrations SET last_sync_at=now(), last_error=$2, updated_at=now() WHERE organization_id=$1 AND key='accounting'`, [orgId, status === 'failed' ? error : null], db);
  return { log, already: false };
}
