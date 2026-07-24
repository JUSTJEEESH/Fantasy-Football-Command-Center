/**
 * Migration runner. Applies every .sql file in db/migrations in filename order,
 * exactly once, inside a transaction, recording applied names in _migrations.
 *
 *   pnpm db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool, closePool } from '../src/lib/db/client';
import { loadEnv } from './load-env';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

async function main() {
  loadEnv();
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓     ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗     ${file}\n${(err as Error).message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count ? `\n${count} migration(s) applied.` : '\nUp to date.');
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
