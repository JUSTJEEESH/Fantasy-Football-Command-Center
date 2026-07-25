import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/lib/db/client';
import { SleeperProvider } from '@/lib/sources/sleeper';
import { DEFAULT_RSS_SOURCES, RssNewsProvider } from '@/lib/sources/rss';
import { searchKey, type RawNewsItem } from '@/lib/sources/types';
import { clusterNews, fingerprint } from '@/lib/news/dedup';
import { buildPlayerNameIndex, classifyCluster, linkPlayers } from '@/lib/news/classify';

// ============================================================================
// Ingestion pipeline.
//
// Reliability contract (§33): every source runs inside its own error boundary
// and records its outcome to `ingest_runs`. One dead source degrades coverage;
// it never aborts the run or corrupts what other sources produced.
// ============================================================================

export interface IngestResult {
  source: string;
  status: 'ok' | 'partial' | 'error';
  fetched: number;
  written: number;
  deduped: number;
  durationMs: number;
  error?: string;
  warnings: string[];
}

async function recordRun(result: IngestResult): Promise<void> {
  await query(
    `INSERT INTO ingest_runs
       (source_key, status, items_fetched, items_new, items_deduped, duration_ms, error, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [
      result.source,
      result.status,
      result.fetched,
      result.written,
      result.deduped,
      result.durationMs,
      result.error ?? null,
    ],
  ).catch(() => {
    // Logging a run must never be the thing that fails an ingestion.
  });
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * Upsert the NFL player master list from Sleeper.
 *
 * Identity is keyed on the Sleeper id inside `external_ids`, so re-running is
 * idempotent and a player changing teams updates in place rather than
 * duplicating.
 */
export async function ingestPlayers(): Promise<IngestResult> {
  const started = Date.now();
  const result: IngestResult = {
    source: 'sleeper:players',
    status: 'ok',
    fetched: 0,
    written: 0,
    deduped: 0,
    durationMs: 0,
    warnings: [],
  };

  try {
    const provider = new SleeperProvider();
    const fetched = await provider.fetchPlayers();

    if (!fetched.ok) {
      result.status = 'error';
      result.error = fetched.error;
      result.durationMs = Date.now() - started;
      await recordRun(result);
      return result;
    }

    result.fetched = fetched.items.length;
    result.warnings = fetched.warnings;

    await withTransaction(async (client) => {
      for (const player of fetched.items) {
        await client.query(
          `INSERT INTO players (
             external_ids, full_name, first_name, last_name, search_key, position,
             nfl_team, jersey_number, age, birth_date, height_inches, weight_lbs,
             college, years_exp, status, source_timestamp, fetched_at
           ) VALUES (
             jsonb_build_object('sleeper', $1::text), $2,$3,$4,$5,$6,$7,$8,$9,
             $10::date,$11,$12,$13,$14,$15,$16,$17
           )
           ON CONFLICT DO NOTHING`,
          [
            player.externalId,
            player.fullName,
            player.firstName ?? null,
            player.lastName ?? null,
            searchKey(player.fullName),
            player.position,
            player.nflTeam,
            player.jerseyNumber ?? null,
            player.age ?? null,
            player.birthDate ?? null,
            player.heightInches ?? null,
            player.weightLbs ?? null,
            player.college ?? null,
            player.yearsExp ?? null,
            player.status ?? 'active',
            player.sourceTimestamp ?? null,
            fetched.fetchedAt,
          ],
        );

        // Update the existing row when the player is already known. Split from
        // the insert because the natural key lives inside JSONB, which makes a
        // single ON CONFLICT clause impractical without a functional index.
        const updated = await client.query(
          `UPDATE players
              SET nfl_team = $2, status = $3, fetched_at = $4, updated_at = now(),
                  age = COALESCE($5, age), years_exp = COALESCE($6, years_exp)
            WHERE external_ids->>'sleeper' = $1`,
          [
            player.externalId,
            player.nflTeam,
            player.status ?? 'active',
            fetched.fetchedAt,
            player.age ?? null,
            player.yearsExp ?? null,
          ],
        );
        if ((updated.rowCount ?? 0) > 0) result.written++;

        // Current injury status, as a fact with its own provenance.
        if (player.injuryStatus) {
          await client.query(
            `INSERT INTO player_injuries
               (player_id, status, source, source_timestamp, fetched_at, is_current)
             SELECT id, $2, 'sleeper', $3, $4, true
               FROM players WHERE external_ids->>'sleeper' = $1`,
            [player.externalId, player.injuryStatus, player.sourceTimestamp ?? null, fetched.fetchedAt],
          );
        }
      }
    });
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - started;
  await recordRun(result);
  return result;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/** Ensure the RSS registry rows exist so sources can be toggled from the DB. */
export async function seedNewsSources(): Promise<void> {
  for (const descriptor of DEFAULT_RSS_SOURCES) {
    await query(
      `INSERT INTO news_sources (key, name, type, url, parser, reliability, update_frequency_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (key) DO UPDATE
         SET name = EXCLUDED.name, url = EXCLUDED.url,
             reliability = EXCLUDED.reliability, updated_at = now()`,
      [
        descriptor.key,
        descriptor.name,
        descriptor.type,
        descriptor.url,
        'rss',
        descriptor.reliability,
        descriptor.updateFrequencyMin,
      ],
    );
  }
}

/**
 * Fetch every enabled news source, deduplicate across all of them, classify,
 * and link to players.
 *
 * Deduplication runs across sources rather than per-source on purpose: the
 * entire point is that four outlets reporting one hamstring becomes one event.
 */
export async function ingestNews(): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const allItems: Array<{ item: RawNewsItem; sourceId: string; reliability: number }> = [];

  const sources = await query<{
    id: string;
    key: string;
    name: string;
    url: string;
    reliability: string;
  }>(`SELECT id, key, name, url, reliability FROM news_sources WHERE enabled AND type = 'rss'`);

  for (const source of sources) {
    const started = Date.now();
    const result: IngestResult = {
      source: source.key,
      status: 'ok',
      fetched: 0,
      written: 0,
      deduped: 0,
      durationMs: 0,
      warnings: [],
    };

    try {
      const descriptor = DEFAULT_RSS_SOURCES.find((d) => d.key === source.key);
      const provider = new RssNewsProvider({
        ...(descriptor ?? DEFAULT_RSS_SOURCES[0]!),
        key: source.key,
        name: source.name,
        url: source.url,
        reliability: Number(source.reliability),
      });

      const fetched = await provider.fetchNews();
      if (!fetched.ok) {
        result.status = 'error';
        result.error = fetched.error;
        await query(
          `UPDATE news_sources
              SET last_error_at = now(), last_error = $2,
                  consecutive_failures = consecutive_failures + 1
            WHERE id = $1`,
          [source.id, fetched.error ?? 'unknown'],
        );
      } else {
        result.fetched = fetched.items.length;
        result.warnings = fetched.warnings;

        for (const item of fetched.items) {
          const inserted = await query<{ id: string }>(
            `INSERT INTO news_items
               (source_id, external_id, url, title, summary, author, fingerprint,
                published_at, source_timestamp, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (source_id, fingerprint) DO NOTHING
             RETURNING id`,
            [
              source.id,
              item.externalId ?? null,
              item.url ?? null,
              item.title,
              item.summary ?? null,
              item.author ?? null,
              fingerprint(item),
              item.publishedAt ?? null,
              item.sourceTimestamp ?? null,
              fetched.fetchedAt,
            ],
          );
          if (inserted.length > 0) result.written++;
          else result.deduped++;

          allItems.push({
            item,
            sourceId: source.id,
            reliability: Number(source.reliability),
          });
        }

        await query(
          `UPDATE news_sources
              SET last_success_at = now(), consecutive_failures = 0, last_error = NULL
            WHERE id = $1`,
          [source.id],
        );
      }
    } catch (err) {
      result.status = 'error';
      result.error = err instanceof Error ? err.message : String(err);
    }

    result.durationMs = Date.now() - started;
    await recordRun(result);
    results.push(result);
  }

  if (allItems.length > 0) {
    await buildEvents(allItems);
  }

  return results;
}

/**
 * Cluster raw items into canonical events, classify each, and link players.
 *
 * Every raw item that contributed to an event is recorded in
 * `news_event_items`, so the UI can always show who reported what — dedup must
 * never cost attribution (§5).
 */
export async function buildEvents(
  entries: Array<{ item: RawNewsItem; sourceId: string; reliability: number }>,
): Promise<void> {
  // Pull the latest ADP alongside each player so the impact score can weigh how
  // much the news matters — an ACL tear to the RB1 is not the same event as one
  // to a fourth-string back, and §7 requires player importance in the formula.
  const players = await query<{
    id: string;
    full_name: string;
    position: string;
    adp: string | null;
  }>(
    `SELECT p.id, p.full_name, p.position, a.adp
       FROM players p
       LEFT JOIN LATERAL (
         SELECT adp FROM player_adp
          WHERE player_id = p.id
          ORDER BY fetched_at DESC LIMIT 1
       ) a ON true
      WHERE p.position IN ('QB','RB','WR','TE','K','DST')`,
  );

  const importanceByPlayer = new Map(
    players.map((p) => [p.id, adpToImportance(p.adp === null ? null : Number(p.adp))]),
  );

  const index = buildPlayerNameIndex(
    players.map((p) => ({ id: p.id, name: p.full_name, position: p.position })),
    searchKey,
  );

  const clusters = clusterNews(entries.map((e) => e.item));
  const reliabilityByKey = new Map(entries.map((e) => [e.item.sourceKey, e.reliability]));

  for (const cluster of clusters) {
    const reliability = Math.max(
      ...cluster.items.map((i) => reliabilityByKey.get(i.sourceKey) ?? 0.5),
    );

    // Link before classifying: who the news is about is an input to how much it
    // matters, so the order is not arbitrary.
    const text = `${cluster.canonicalTitle} ${cluster.items.map((i) => i.summary ?? '').join(' ')}`;
    const links = linkPlayers(text, index, searchKey);

    const playerImportance =
      links.length > 0
        ? Math.max(...links.map((l) => importanceByPlayer.get(l.playerId) ?? 0.5))
        : // Nobody recognizable was named, so this is probably not about a
          // fantasy-relevant player. Score it down rather than assuming.
          0.3;

    const classified = classifyCluster(cluster, {
      sourceReliability: reliability,
      playerImportance,
    });
    if (classified.classification === 'NOISE') continue;

    await withTransaction(async (client: PoolClient) => {
      const event = await client.query<{ id: string }>(
        `INSERT INTO news_events
           (headline, event_type, classification, fantasy_impact, impact_score,
            team_impact, positions_affected, confidence, summary,
            first_reported_at, last_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          cluster.canonicalTitle,
          classified.eventType,
          classified.classification,
          classified.fantasyImpact,
          classified.impactScore,
          classified.teamDirection,
          classified.positionsAffected,
          classified.confidence,
          cluster.items[0]?.summary ?? null,
          cluster.earliestPublishedAt ?? null,
          cluster.latestPublishedAt ?? null,
        ],
      );
      const eventId = event.rows[0]!.id;

      for (const [i, item] of cluster.items.entries()) {
        await client.query(
          `INSERT INTO news_event_items (event_id, news_item_id, similarity)
           SELECT $1, id, $3 FROM news_items WHERE fingerprint = $2
           ON CONFLICT DO NOTHING`,
          [eventId, fingerprint(item), cluster.similarities[i] ?? null],
        );
      }

      for (const link of links) {
        await client.query(
          `INSERT INTO news_player_links (event_id, player_id, player_impact, confidence, is_primary)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [
            eventId,
            link.playerId,
            classified.playerDirection,
            Math.min(link.confidence, classified.confidence),
            link.matchType === 'full',
          ],
        );
      }
    });
  }
}

/**
 * Map a player's ADP onto a 0..1 fantasy-relevance weight.
 *
 * Roughly: an early-round pick is maximally relevant, relevance decays through
 * the draftable range, and an undrafted player still gets a small floor because
 * "undrafted player named starter" is exactly the news worth surfacing.
 * A player with no ADP at all gets a neutral 0.5 rather than being scored as
 * unimportant — absence of data is not evidence.
 */
export function adpToImportance(adp: number | null): number {
  if (adp === null || !Number.isFinite(adp)) return 0.5;
  if (adp <= 12) return 1;
  if (adp >= 220) return 0.25;
  return Math.round((1 - ((adp - 12) / 208) * 0.75) * 100) / 100;
}

/**
 * Deduplicate the *event* table across runs.
 *
 * Each run creates events from that run's items, so a story still circulating
 * tomorrow would otherwise produce a second event. Rather than complicate the
 * write path, near-identical recent events are merged afterwards, keeping the
 * one with the most sources attached.
 */
export async function mergeDuplicateEvents(windowHours = 48): Promise<number> {
  const removed = await query<{ id: string }>(
    `WITH ranked AS (
       SELECT e.id,
              row_number() OVER (
                PARTITION BY lower(regexp_replace(e.headline, '[^a-zA-Z0-9 ]', '', 'g'))
                ORDER BY (SELECT count(*) FROM news_event_items ei WHERE ei.event_id = e.id) DESC,
                         e.created_at ASC
              ) AS rn
         FROM news_events e
        WHERE e.first_reported_at > now() - ($1 || ' hours')::interval
     )
     DELETE FROM news_events WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
     RETURNING id`,
    [String(windowHours)],
  );
  return removed.length;
}
