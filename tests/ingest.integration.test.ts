import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, isDbConfigured, query } from '@/lib/db/client';
import { buildEvents, seedNewsSources } from '@/lib/ingest/pipeline';
import { fingerprint } from '@/lib/news/dedup';
import type { RawNewsItem } from '@/lib/sources/types';

// ============================================================================
// Integration tests against a real Postgres.
//
// These exercise the SQL itself, which unit tests cannot: a typo in a column
// name or a bad ON CONFLICT clause only shows up against a live database.
// Skipped automatically when DATABASE_URL is not configured.
// ============================================================================

const dbAvailable = isDbConfigured();
const suite = dbAvailable ? describe : describe.skip;

suite('ingestion pipeline against Postgres', () => {
  let sourceId: string;

  beforeAll(async () => {
    await seedNewsSources();

    const sources = await query<{ id: string }>(
      `SELECT id FROM news_sources WHERE key = 'espn_nfl'`,
    );
    sourceId = sources[0]!.id;

    // Two players, one of whom shares a last name with nobody so linking is
    // unambiguous.
    await query(
      `INSERT INTO players (external_ids, full_name, search_key, position, nfl_team)
       VALUES ('{"test":"1"}'::jsonb, 'Testcase Runningback', 'testcaserunningback', 'RB', 'TEN'),
              ('{"test":"2"}'::jsonb, 'Testcase Wideout',     'testcasewideout',     'WR', 'PHI')
       ON CONFLICT DO NOTHING`,
    );

    // Give the running back an early-round ADP. News impact is supposed to
    // scale with how much the player matters, so the test needs a player who
    // actually matters.
    await query(
      `INSERT INTO player_adp (player_id, season, format, adp, source)
       SELECT id, 2026, 'ppr', 4.5, 'test' FROM players WHERE full_name = 'Testcase Runningback'`,
    );
    await query(
      `INSERT INTO player_adp (player_id, season, format, adp, source)
       SELECT id, 2026, 'ppr', 240, 'test' FROM players WHERE full_name = 'Testcase Wideout'`,
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM player_adp WHERE source = 'test'`);
    await query(`DELETE FROM news_events WHERE headline LIKE 'Testcase%'`);
    await query(`DELETE FROM news_items WHERE title LIKE 'Testcase%'`);
    await query(`DELETE FROM players WHERE full_name LIKE 'Testcase%'`);
    await closePool();
  });

  async function insertItem(item: RawNewsItem): Promise<void> {
    await query(
      `INSERT INTO news_items
         (source_id, url, title, summary, fingerprint, published_at, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (source_id, fingerprint) DO NOTHING`,
      [
        sourceId,
        item.url ?? null,
        item.title,
        item.summary ?? null,
        fingerprint(item),
        item.publishedAt ?? null,
      ],
    );
  }

  it('seeds the source registry idempotently', async () => {
    await seedNewsSources();
    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM news_sources WHERE key = 'espn_nfl'`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('writes a canonical event from several reports and keeps every source', async () => {
    const published = new Date().toISOString();
    const items: RawNewsItem[] = [
      {
        sourceKey: 'espn_nfl',
        title: 'Testcase Runningback suffers a torn ACL, out for the season',
        summary: 'The running back was carted off during Wednesday practice.',
        url: 'https://example.com/1',
        publishedAt: published,
      },
      {
        sourceKey: 'espn_nfl',
        title: 'Testcase Runningback tears ACL and is out for the season',
        summary: 'A season-ending knee injury for the running back.',
        url: 'https://example.com/2',
        publishedAt: published,
      },
    ];

    for (const item of items) await insertItem(item);
    await buildEvents(items.map((item) => ({ item, sourceId, reliability: 0.9 })));

    const events = await query<{
      id: string;
      headline: string;
      event_type: string;
      fantasy_impact: string;
      impact_score: string;
    }>(`SELECT id, headline, event_type, fantasy_impact, impact_score
          FROM news_events WHERE headline LIKE 'Testcase%'`);

    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('injury');
    expect(events[0]!.fantasy_impact).toBe('CRITICAL');
    expect(Number(events[0]!.impact_score)).toBeGreaterThan(70);

    // Both original reports remain attached — dedup must not cost attribution.
    const attached = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM news_event_items WHERE event_id = $1`,
      [events[0]!.id],
    );
    expect(Number(attached[0]!.count)).toBe(2);
  });

  it('scales impact with how relevant the injured player is', async () => {
    // The same injury to a player nobody drafts must not score as a crisis.
    const published = new Date().toISOString();
    const item: RawNewsItem = {
      sourceKey: 'espn_nfl',
      title: 'Testcase Wideout suffers a torn ACL, out for the season',
      publishedAt: published,
    };
    await insertItem(item);
    await buildEvents([{ item, sourceId, reliability: 0.9 }]);

    const [star] = await query<{ impact_score: string }>(
      `SELECT impact_score FROM news_events WHERE headline LIKE 'Testcase Runningback%'`,
    );
    const [scrub] = await query<{ impact_score: string }>(
      `SELECT impact_score FROM news_events WHERE headline LIKE 'Testcase Wideout suffers%'`,
    );

    expect(Number(star!.impact_score)).toBeGreaterThan(Number(scrub!.impact_score));
  });

  it('links the event to the right player', async () => {
    const links = await query<{ full_name: string; player_impact: string }>(
      `SELECT p.full_name, l.player_impact
         FROM news_player_links l
         JOIN players p ON p.id = l.player_id
         JOIN news_events e ON e.id = l.event_id
        WHERE e.headline LIKE 'Testcase%'`,
    );
    expect(links.map((l) => l.full_name)).toContain('Testcase Runningback');
    expect(links[0]!.player_impact).toBe('STRONG_NEGATIVE');
  });

  it('drops noise rather than storing it', async () => {
    const item: RawNewsItem = {
      sourceKey: 'espn_nfl',
      title: 'Testcase power rankings: where every team stands',
      publishedAt: new Date().toISOString(),
    };
    await insertItem(item);
    await buildEvents([{ item, sourceId, reliability: 0.9 }]);

    const events = await query<{ headline: string }>(
      `SELECT headline FROM news_events WHERE headline LIKE 'Testcase power rankings%'`,
    );
    expect(events).toHaveLength(0);
  });

  it('does not double-store an item seen twice', async () => {
    const item: RawNewsItem = {
      sourceKey: 'espn_nfl',
      title: 'Testcase Wideout named the starting receiver',
      publishedAt: new Date().toISOString(),
    };
    await insertItem(item);
    await insertItem(item);

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM news_items WHERE title = $1`,
      [item.title],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('the news API query shape is valid SQL', async () => {
    // Mirrors src/app/api/news/route.ts — catches a broken join before a user does.
    const rows = await query(
      `SELECT e.id, e.headline,
              COALESCE(json_agg(json_build_object('name', s.name, 'url', i.url))
                       FILTER (WHERE s.name IS NOT NULL), '[]') AS sources
         FROM news_events e
         LEFT JOIN news_event_items ei ON ei.event_id = e.id
         LEFT JOIN news_items i        ON i.id = ei.news_item_id
         LEFT JOIN news_sources s      ON s.id = i.source_id
        WHERE e.classification <> 'NOISE'
        GROUP BY e.id
        LIMIT 5`,
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});
