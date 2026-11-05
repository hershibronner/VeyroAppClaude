// RECRUITING area seed (idempotent, works for any org).
// - Clears dangling intro-video pointers when the referenced file is not present in ./storage, so
//   "has video" filters and players never point at a missing file.
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { STORAGE_DIR } from '../../src/index';

export default async function (c: PoolClient) {
  const rows = (await c.query(`SELECT DISTINCT video_file FROM candidates WHERE video_file IS NOT NULL`)).rows as { video_file: string }[];
  for (const r of rows) {
    if (!fs.existsSync(path.join(STORAGE_DIR, r.video_file))) await c.query(`UPDATE candidates SET video_file=NULL WHERE video_file=$1`, [r.video_file]);
  }
}
