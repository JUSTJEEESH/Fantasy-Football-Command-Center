/**
 * pnpm ingest [players|news|all]
 *
 * Fetches from every configured source and persists to Postgres. Safe to run
 * repeatedly: player upserts are idempotent, news items are deduplicated by
 * fingerprint, and a failing source is recorded and skipped rather than
 * aborting the run.
 *
 * Intended to be run on a schedule (news every ~15 min, players daily).
 */
import { closePool, isDbConfigured } from '../src/lib/db/client';
import {
  ingestNews,
  ingestPlayers,
  mergeDuplicateEvents,
  seedNewsSources,
  type IngestResult,
} from '../src/lib/ingest/pipeline';
import { loadEnv } from './load-env';

function report(result: IngestResult) {
  const icon = { ok: '✓', partial: '!', error: '✗' }[result.status];
  console.log(
    `  ${icon} ${result.source.padEnd(24)} fetched ${String(result.fetched).padStart(5)} · ` +
      `new ${String(result.written).padStart(5)} · dup ${String(result.deduped).padStart(5)} · ` +
      `${result.durationMs}ms`,
  );
  if (result.error) console.log(`      error: ${result.error}`);
  for (const warning of result.warnings.slice(0, 3)) {
    console.log(`      note:  ${warning}`);
  }
}

async function main() {
  loadEnv();

  if (!isDbConfigured()) {
    console.error(
      'DATABASE_URL is not set. Ingestion writes to Postgres — configure it in .env first.',
    );
    process.exit(1);
  }

  if (process.env.INGEST_NETWORK_ENABLED === '0') {
    console.error(
      'INGEST_NETWORK_ENABLED=0, so no source can fetch. Set it to 1 to ingest.\n' +
        'This is a configuration state, not an absence of data.',
    );
    process.exit(1);
  }

  const target = process.argv[2] ?? 'all';
  const results: IngestResult[] = [];

  console.log(`FANTASY COACH — ingest (${target})`);
  console.log('='.repeat(70));

  if (target === 'players' || target === 'all') {
    console.log('\nPLAYERS');
    results.push(await ingestPlayers());
    report(results[results.length - 1]!);
  }

  if (target === 'news' || target === 'all') {
    console.log('\nNEWS');
    await seedNewsSources();
    const newsResults = await ingestNews();
    for (const result of newsResults) {
      results.push(result);
      report(result);
    }
    const merged = await mergeDuplicateEvents();
    if (merged > 0) console.log(`  · merged ${merged} duplicate event(s) from earlier runs`);
  }

  const failures = results.filter((r) => r.status === 'error');
  console.log('\n' + '='.repeat(70));
  console.log(
    `${results.length - failures.length}/${results.length} sources succeeded, ` +
      `${results.reduce((sum, r) => sum + r.written, 0)} new records.`,
  );

  if (failures.length > 0) {
    console.log('\nFailed sources (the rest still ingested):');
    for (const failure of failures) console.log(`  ✗ ${failure.source}: ${failure.error}`);
  }

  await closePool();
  // A partial run is still a useful run — only fail the process if nothing worked.
  process.exit(failures.length === results.length && results.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Ingest crashed:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
