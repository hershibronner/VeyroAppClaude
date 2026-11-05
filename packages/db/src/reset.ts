import fs from 'node:fs';
import path from 'node:path';
import { createPool, STORAGE_DIR } from './index';
const pool = createPool(1);
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await pool.end();
for (const d of ['uploads', 'screenshots', 'pdf', 'mock']) fs.rmSync(path.join(STORAGE_DIR, d), { recursive: true, force: true });
console.log('database reset');
