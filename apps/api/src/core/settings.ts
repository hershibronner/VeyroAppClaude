import { DEFAULT_SETTINGS } from '@veyro/db';
import { one, q } from './db';

export async function getSetting<T = any>(orgId: string, key: string): Promise<T> {
  const r = await one<{ value: T }>(`SELECT value FROM org_settings WHERE organization_id=$1 AND key=$2`, [orgId, key]);
  return { ...(DEFAULT_SETTINGS[key] as object ?? {}), ...(r?.value as object ?? {}) } as T;
}
export async function setSetting(orgId: string, key: string, value: unknown) {
  await q(`INSERT INTO org_settings (organization_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (organization_id, key) DO UPDATE SET value=$3, updated_at=now()`, [orgId, key, JSON.stringify(value)]);
}
// In production (Railway) the API also serves the web app, so both live on the one public domain.
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
export const WEB_URL = process.env.WEB_URL ?? PUBLIC_URL ?? 'http://localhost:3100';
export const API_URL = process.env.API_URL ?? PUBLIC_URL ?? 'http://localhost:4100';
