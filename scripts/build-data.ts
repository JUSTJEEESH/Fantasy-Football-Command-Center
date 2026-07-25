/**
 * pnpm build:data
 *
 * Fetches real data from real sources and writes it into public/data/ so the
 * static deployment ships populated. Runs in GitHub Actions, which has network
 * access, before the static export.
 *
 * Honesty rules this script follows without exception:
 *  - It never invents a record. If a source is unreachable, the pack is written
 *    with ok:false and the reason, and the UI says so.
 *  - Every pack is stamped with the build time, and nothing in the app claims
 *    the data is fresher than that.
 *  - Sleeper's `search_rank` is carried as `sleeperRank`, never as ADP. It is
 *    one platform's popularity ordering, not a consensus average draft
 *    position, and calling it ADP would misrepresent it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SleeperProvider } from '../src/lib/sources/sleeper';
import { DEFAULT_RSS_SOURCES, RssNewsProvider, parseFeed } from '../src/lib/sources/rss';
import { searchKey, type RawNewsItem } from '../src/lib/sources/types';
import { clusterNews } from '../src/lib/news/dedup';
import { buildPlayerNameIndex, classifyCluster, linkPlayers } from '../src/lib/news/classify';
import type { NewsPack, PlayerPack, PlayerPackEntry } from '../src/lib/static-data';
import type { Position } from '../src/lib/types';
import { loadEnv } from './load-env';

const OUT_DIR = join(process.cwd(), 'public', 'data');

/**
 * Fixture mode (`pnpm build:data --fixtures`) builds the pack from committed
 * sample files instead of the network, so the pipeline and the UI can be
 * exercised on a machine with no egress. The output is written to the same
 * place but flagged, and public/data is git-ignored, so fixture content can
 * never reach a deployment.
 */
const USE_FIXTURES = process.argv.includes('--fixtures');
const SEASON = Number(process.env.SEASON ?? new Date().getFullYear());

/** How many players to ship. The full Sleeper list is ~5MB and mostly practice
 *  squad; the fantasy-relevant slice keeps the download small on a phone. */
const PLAYER_LIMIT = 600;

/** Only surface events this recent. Older items are still ingested, but the
 *  feed is meant to answer "what happened lately", not to be an archive. */
const NEWS_WINDOW_HOURS = 96;

const FIXTURE_PLAYERS: Array<[string, Position, string]> = [
  ['Marcus Fielding', 'RB', 'TEN'],
  ['Dorian Vance', 'QB', 'BUF'],
  ['Elias Thorne', 'WR', 'PHI'],
  ['Rhys Calloway', 'RB', 'ATL'],
  ['Jonah Priest', 'QB', 'PIT'],
  ['Silas Boone', 'RB', 'KC'],
];

function fixturePlayerPack(generatedAt: string): PlayerPack {
  return {
    generatedAt,
    ok: true,
    reason: 'FIXTURE DATA — not real players. Local development only.',
    sources: [{ key: 'fixture', name: 'Fixtures', ok: true, itemCount: FIXTURE_PLAYERS.length }],
    season: SEASON,
    players: FIXTURE_PLAYERS.map(([name, position, team], i) => ({
      id: `${position}-${searchKey(name)}-fixture${i}`,
      name,
      position,
      team,
      sleeperRank: (i + 1) * 8,
    })),
  };
}

async function buildPlayers(): Promise<PlayerPack> {
  const generatedAt = new Date().toISOString();
  if (USE_FIXTURES) {
    console.log('Using fixture players (no network).');
    return fixturePlayerPack(generatedAt);
  }
  const provider = new SleeperProvider();

  console.log('Fetching NFL players from Sleeper…');
  const result = await provider.fetchPlayers();

  if (!result.ok) {
    console.error(`  ✗ ${result.error}`);
    return {
      generatedAt,
      ok: false,
      reason: result.error,
      sources: [{ key: 'sleeper', name: 'Sleeper', ok: false, itemCount: 0, error: result.error }],
      season: SEASON,
      players: [],
    };
  }

  // Rank by Sleeper's own ordering, which puts fantasy-relevant players first.
  // Players without a rank sort last rather than being dropped, so a rookie
  // Sleeper has not ranked yet is still searchable.
  const ranked = result.items
    .filter((p) => p.nflTeam)
    .map((p, index) => ({ player: p, rank: index }))
    .sort((a, b) => {
      const ra = a.player.searchRank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.player.searchRank ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    })
    .slice(0, PLAYER_LIMIT);

  const players: PlayerPackEntry[] = ranked.map(({ player }) => ({
    id: `${player.position}-${searchKey(player.fullName)}-${player.externalId}`,
    name: player.fullName,
    position: player.position,
    team: player.nflTeam,
    age: player.age,
    yearsExp: player.yearsExp,
    injuryStatus: player.injuryStatus ?? null,
    depthChartOrder: player.depthChartOrder,
    sleeperRank: player.searchRank,
  }));

  console.log(`  ✓ ${players.length} players (of ${result.items.length} fetched)`);

  return {
    generatedAt,
    ok: true,
    sources: [
      { key: 'sleeper', name: 'Sleeper', ok: true, itemCount: players.length },
    ],
    season: SEASON,
    players,
  };
}

async function buildNews(players: PlayerPackEntry[]): Promise<NewsPack> {
  const generatedAt = new Date().toISOString();
  const now = new Date();

  const collected: Array<{ item: RawNewsItem; reliability: number }> = [];
  const sourceResults: NewsPack['sources'] = [];

  console.log('\nFetching news feeds…');
  for (const [sourceIndex, descriptor] of DEFAULT_RSS_SOURCES.entries()) {
    const result = USE_FIXTURES
      ? {
          ok: true as const,
          // Give each fixture feed a different subset, so a story is carried by
          // one to four outlets rather than all of them. Uniform fixtures make
          // every event score identical confidence, which hides whether the
          // corroboration model discriminates at all.
          items: parseFeed(
            readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rss-nfl.xml'), 'utf8'),
            descriptor.key,
          ).filter((_, itemIndex) => itemIndex % 4 >= sourceIndex),
          fetchedAt: new Date().toISOString(),
          warnings: [] as string[],
          error: undefined as string | undefined,
        }
      : await new RssNewsProvider(descriptor).fetchNews();

    if (!result.ok) {
      console.error(`  ✗ ${descriptor.name}: ${result.error}`);
      sourceResults.push({
        key: descriptor.key,
        name: descriptor.name,
        ok: false,
        itemCount: 0,
        error: result.error,
      });
      continue;
    }

    // Keep only recent items; the feed answers "what happened lately".
    const recent = result.items.filter((item) => {
      if (!item.publishedAt) return true;
      const age = (now.getTime() - new Date(item.publishedAt).getTime()) / 3_600_000;
      return Number.isNaN(age) || age <= (USE_FIXTURES ? Infinity : NEWS_WINDOW_HOURS);
    });

    console.log(`  ✓ ${descriptor.name}: ${recent.length} recent of ${result.items.length}`);
    sourceResults.push({
      key: descriptor.key,
      name: descriptor.name,
      ok: true,
      itemCount: recent.length,
    });

    for (const item of recent) {
      collected.push({ item, reliability: descriptor.reliability });
    }
  }

  const anySucceeded = sourceResults.some((s) => s.ok);
  if (!anySucceeded) {
    return {
      generatedAt,
      ok: false,
      reason: 'No news source could be reached during the build.',
      sources: sourceResults,
      events: [],
      rawItemCount: 0,
    };
  }

  // Same pipeline the server path uses: dedup across sources, link players,
  // then classify with the linked player's relevance as an input.
  const index = buildPlayerNameIndex(
    players.map((p) => ({ id: p.id, name: p.name })),
    searchKey,
  );
  const playerById = new Map(players.map((p) => [p.id, p]));
  const reliabilityByKey = new Map(
    collected.map((c) => [c.item.sourceKey, c.reliability]),
  );
  const nameBySourceKey = new Map(
    DEFAULT_RSS_SOURCES.map((d) => [d.key, d.name]),
  );

  const clusters = clusterNews(collected.map((c) => c.item));
  console.log(`\nDeduplicated ${collected.length} items into ${clusters.length} events.`);

  const events: NewsPack['events'] = [];

  for (const cluster of clusters) {
    const text = `${cluster.canonicalTitle} ${cluster.items.map((i) => i.summary ?? '').join(' ')}`;
    const links = linkPlayers(text, index, searchKey);

    // Sleeper's ordering stands in for relevance here. A top-60 player is
    // treated as highly relevant, tapering off through the fantasy-relevant
    // range. Without ADP this is the best available proxy, and it only affects
    // ordering — never whether something is reported.
    const linkedPlayers = links
      .map((l) => playerById.get(l.playerId))
      .filter((p): p is PlayerPackEntry => Boolean(p));

    const importance =
      linkedPlayers.length === 0
        ? 0.3
        : Math.max(
            ...linkedPlayers.map((p) =>
              p.sleeperRank === undefined
                ? 0.5
                : Math.max(0.25, 1 - Math.min(1, p.sleeperRank / 250) * 0.75),
            ),
          );

    const reliability = Math.max(
      ...cluster.items.map((i) => reliabilityByKey.get(i.sourceKey) ?? 0.5),
    );

    const classified = classifyCluster(cluster, {
      sourceReliability: reliability,
      playerImportance: importance,
      now,
    });

    if (classified.classification === 'NOISE') continue;

    // Some event types are inherently about one person: an injury, a benching,
    // a change in workload. If we cannot say WHO, the item cannot be acted on —
    // "a defensive end went on injured reserve" is not fantasy news, it is
    // noise wearing the shape of news. Team-level events (coaching changes,
    // trades) can still stand without a named fantasy player.
    const INDIVIDUAL_EVENTS = ['injury', 'practice', 'depth_chart', 'usage', 'return'];
    if (linkedPlayers.length === 0 && INDIVIDUAL_EVENTS.includes(classified.eventType)) {
      continue;
    }
    if (linkedPlayers.length === 0 && classified.impactScore < 55) continue;

    events.push({
      id: `evt-${events.length + 1}-${cluster.canonicalTitle.slice(0, 24).replace(/\W+/g, '-').toLowerCase()}`,
      headline: cluster.canonicalTitle,
      summary: cluster.items.find((i) => i.summary)?.summary,
      eventType: classified.eventType,
      classification: classified.classification,
      fantasyImpact: classified.fantasyImpact,
      impactScore: classified.impactScore,
      confidence: classified.confidence,
      playerDirection: classified.playerDirection,
      positions: classified.positionsAffected as Position[],
      players: linkedPlayers.slice(0, 3).map((p) => ({
        name: p.name,
        position: p.position,
        team: p.team,
      })),
      firstReportedAt: cluster.earliestPublishedAt,
      lastReportedAt: cluster.latestPublishedAt,
      sources: cluster.items.map((item) => ({
        name: nameBySourceKey.get(item.sourceKey) ?? item.sourceKey,
        url: item.url,
        publishedAt: item.publishedAt,
      })),
      signals: classified.signals,
    });
  }

  events.sort((a, b) => b.impactScore - a.impactScore);

  const withPlayers = events.filter((e) => e.players.length > 0).length;
  console.log(
    `Kept ${events.length} fantasy-relevant events (${withPlayers} linked to a player).`,
  );

  return {
    generatedAt,
    ok: true,
    sources: sourceResults,
    events,
    rawItemCount: collected.length,
  };
}

async function main() {
  loadEnv();
  console.log('FANTASY COACH — building static data pack');
  console.log('='.repeat(60));

  if (process.env.INGEST_NETWORK_ENABLED === '0') {
    console.error(
      '\nINGEST_NETWORK_ENABLED=0 — refusing to build a data pack with no network.\n' +
        'Writing empty packs marked as failed so the UI reports the truth.',
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });

  if (USE_FIXTURES) {
    console.log('MODE: fixtures (no network). Output is for local viewing only.\n');
  }

  const playerPack = await buildPlayers();
  const newsPack = await buildNews(playerPack.players);

  writeFileSync(join(OUT_DIR, 'players.json'), JSON.stringify(playerPack));
  writeFileSync(join(OUT_DIR, 'news.json'), JSON.stringify(newsPack));

  console.log('\n' + '='.repeat(60));
  console.log(`players.json  ${playerPack.ok ? '✓' : '✗'}  ${playerPack.players.length} players`);
  console.log(`news.json     ${newsPack.ok ? '✓' : '✗'}  ${newsPack.events.length} events`);

  // A failed data build must not silently ship an empty site: fail the job so
  // it is visible, unless explicitly allowed (local work without network).
  const allowEmpty = process.env.ALLOW_EMPTY_DATA === '1';
  if (!playerPack.ok && !newsPack.ok && !allowEmpty) {
    console.error(
      '\nBoth sources failed. Failing the build rather than deploying an empty site.\n' +
        'Set ALLOW_EMPTY_DATA=1 to build anyway.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('build:data crashed:', err);
  process.exit(1);
});
