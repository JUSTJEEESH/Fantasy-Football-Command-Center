/**
 * pnpm doctor — live connectivity and configuration check.
 *
 * This exists because the development sandbox blocks egress to every fantasy
 * data host, so adapters CANNOT be verified against live endpoints there. This
 * script performs the real requests on a machine with open network access and
 * reports, per source, whether the parser still matches reality.
 *
 * Run it:
 *   - after cloning, to see what is actually working
 *   - before draft day, as the go/no-go check
 *   - whenever a source starts behaving oddly
 */
import { SleeperProvider } from '../src/lib/sources/sleeper';
import { DEFAULT_RSS_SOURCES, RssNewsProvider } from '../src/lib/sources/rss';
import { isDbConfigured, closePool, query } from '../src/lib/db/client';
import { loadEnv } from './load-env';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

const results: Array<{ name: string; status: Status; detail: string }> = [];

function record(name: string, status: Status, detail: string) {
  results.push({ name, status, detail });
  const icon = { ok: '✓', warn: '!', fail: '✗', skip: '-' }[status];
  console.log(`  ${icon} ${name.padEnd(28)} ${detail}`);
}

async function checkEnvironment() {
  console.log('\nENVIRONMENT');
  record('Node', 'ok', process.version);
  record(
    'Network ingestion',
    process.env.INGEST_NETWORK_ENABLED === '0' ? 'warn' : 'ok',
    process.env.INGEST_NETWORK_ENABLED === '0'
      ? 'DISABLED (INGEST_NETWORK_ENABLED=0) — no source can fetch'
      : 'enabled',
  );
  record(
    'ANTHROPIC_API_KEY',
    process.env.ANTHROPIC_API_KEY ? 'ok' : 'warn',
    process.env.ANTHROPIC_API_KEY
      ? 'set — conversational Coach available'
      : 'not set — Coach falls back to template prose (advice still works)',
  );
}

async function checkDatabase() {
  console.log('\nDATABASE');
  if (!isDbConfigured()) {
    record('DATABASE_URL', 'warn', 'not set — persistence off, Draft Mode still works offline');
    return;
  }
  try {
    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public'`,
    );
    record('Connection', 'ok', `connected, ${rows[0]?.count ?? '?'} tables`);

    const migrations = await query<{ name: string }>(
      `SELECT name FROM _migrations ORDER BY name`,
    ).catch(() => []);
    record(
      'Migrations',
      migrations.length > 0 ? 'ok' : 'fail',
      migrations.length > 0
        ? `${migrations.length} applied (latest: ${migrations[migrations.length - 1]?.name})`
        : 'none applied — run: pnpm db:migrate',
    );

    const players = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM players`,
    ).catch(() => []);
    const count = Number(players[0]?.count ?? 0);
    record(
      'Player data',
      count > 100 ? 'ok' : 'warn',
      count > 0 ? `${count} players` : 'empty — run: pnpm ingest',
    );

    const adp = await query<{ count: string; latest: string | null }>(
      `SELECT count(*)::text AS count, max(fetched_at)::text AS latest FROM player_adp`,
    ).catch(() => []);
    const adpCount = Number(adp[0]?.count ?? 0);
    record(
      'ADP data',
      adpCount > 50 ? 'ok' : 'fail',
      adpCount > 0
        ? `${adpCount} rows, last fetched ${adp[0]?.latest}`
        : 'EMPTY — Draft Mode needs ADP. Import a CSV before draft day.',
    );
  } catch (err) {
    record('Connection', 'fail', (err as Error).message);
  }
}

async function checkSleeper() {
  console.log('\nSLEEPER API');
  const provider = new SleeperProvider();
  const started = Date.now();
  const result = await provider.fetchPlayers();
  const elapsed = Date.now() - started;

  if (!result.ok) {
    record('Player list', 'fail', result.error ?? 'unknown error');
    return;
  }
  record('Player list', 'ok', `${result.items.length} players in ${elapsed}ms`);
  for (const warning of result.warnings) record('  warning', 'warn', warning);

  // Sanity-check the shape rather than merely that a request succeeded: a
  // silently-changed schema is the failure mode this script exists to catch.
  const positions = new Set(result.items.map((p) => p.position));
  const missingPositions = ['QB', 'RB', 'WR', 'TE'].filter((p) => !positions.has(p as never));
  record(
    'Parser sanity',
    missingPositions.length === 0 ? 'ok' : 'fail',
    missingPositions.length === 0
      ? `positions present: ${[...positions].sort().join(', ')}`
      : `MISSING positions ${missingPositions.join(', ')} — the parser no longer matches the API`,
  );

  const withTeams = result.items.filter((p) => p.nflTeam).length;
  record(
    'Team assignment',
    withTeams > result.items.length * 0.2 ? 'ok' : 'warn',
    `${withTeams} players have an NFL team`,
  );

  const leagueId = process.env.SLEEPER_LEAGUE_ID;
  if (!leagueId) {
    record('League sync', 'skip', 'SLEEPER_LEAGUE_ID not set');
  } else {
    const league = await provider.getLeague(leagueId);
    record(
      'League sync',
      league.ok ? 'ok' : 'fail',
      league.ok
        ? `${league.items[0]?.name} (${league.items[0]?.teamCount} teams)`
        : (league.error ?? 'failed'),
    );
  }

  const draftId = process.env.SLEEPER_DRAFT_ID;
  if (!draftId) {
    record('Draft sync', 'skip', 'SLEEPER_DRAFT_ID not set (manual entry still works)');
  } else {
    const picks = await provider.getDraftPicks(draftId);
    record(
      'Draft sync',
      picks.ok ? 'ok' : 'fail',
      picks.ok ? `${picks.items.length} picks visible` : (picks.error ?? 'failed'),
    );
  }
}

async function checkNewsFeeds() {
  console.log('\nNEWS FEEDS');
  for (const descriptor of DEFAULT_RSS_SOURCES) {
    const provider = new RssNewsProvider(descriptor);
    const result = await provider.fetchNews();
    if (!result.ok) {
      record(descriptor.name, 'fail', result.error ?? 'unknown error');
      continue;
    }
    const withDates = result.items.filter((i) => i.publishedAt).length;
    record(
      descriptor.name,
      result.items.length > 0 ? 'ok' : 'warn',
      `${result.items.length} items, ${withDates} with timestamps`,
    );
  }
}

async function main() {
  loadEnv();
  console.log('FANTASY COACH — system check');
  console.log('='.repeat(60));

  await checkEnvironment();
  await checkDatabase();
  await checkSleeper();
  await checkNewsFeeds();

  console.log('\n' + '='.repeat(60));
  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  console.log(
    `${results.filter((r) => r.status === 'ok').length} ok, ` +
      `${warnings.length} warnings, ${failures.length} failures`,
  );

  if (failures.length > 0) {
    console.log('\nFAILURES — these must be fixed before relying on the system:');
    for (const f of failures) console.log(`  ✗ ${f.name}: ${f.detail}`);
  }

  // Draft-day go/no-go. The engine works offline, but only if it has data.
  const adpCheck = results.find((r) => r.name === 'ADP data');
  console.log('\nDRAFT READINESS');
  if (adpCheck?.status === 'ok') {
    console.log('  ✓ ADP present — Draft Mode has what it needs.');
  } else {
    console.log(
      '  ✗ No ADP data. Draft Mode will run, but recommendations will lean on\n' +
        '    projections alone and availability estimates will be unreliable.\n' +
        '    Import a CSV (Settings -> Import) before August 30.',
    );
  }

  await closePool().catch(() => {});
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nDoctor crashed:', err);
  process.exit(1);
});
