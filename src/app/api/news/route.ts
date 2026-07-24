import { NextResponse } from 'next/server';
import { isDbConfigured, query } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

interface EventRow {
  id: string;
  headline: string;
  classification: string;
  fantasy_impact: string;
  impact_score: string | null;
  confidence: string;
  summary: string | null;
  first_reported_at: string | null;
  sources: Array<{ name: string; url: string | null; publishedAt: string | null }> | null;
}

/**
 * Recent fantasy-relevant news events.
 *
 * Every failure mode returns an explicit `degraded` message rather than an
 * empty list, because an empty list reads as "nothing happened" — which would
 * be the system lying by omission (§45).
 */
export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json({
      events: [],
      fetchedAt: null,
      degraded:
        'No database configured, so no news is being collected. Draft mode is unaffected.',
    });
  }

  try {
    const rows = await query<EventRow>(
      `SELECT
         e.id,
         e.headline,
         e.classification,
         e.fantasy_impact,
         e.impact_score,
         e.confidence,
         e.summary,
         e.first_reported_at,
         COALESCE(
           json_agg(
             json_build_object('name', s.name, 'url', i.url, 'publishedAt', i.published_at)
             ORDER BY i.published_at
           ) FILTER (WHERE s.name IS NOT NULL),
           '[]'
         ) AS sources
       FROM news_events e
       LEFT JOIN news_event_items ei ON ei.event_id = e.id
       LEFT JOIN news_items i        ON i.id = ei.news_item_id
       LEFT JOIN news_sources s      ON s.id = i.source_id
       WHERE e.classification <> 'NOISE'
       GROUP BY e.id
       ORDER BY e.impact_score DESC NULLS LAST, e.first_reported_at DESC
       LIMIT 50`,
    );

    const lastIngest = await query<{ latest: string | null }>(
      `SELECT max(fetched_at)::text AS latest FROM news_items`,
    );

    return NextResponse.json({
      events: rows.map((row) => ({
        id: row.id,
        headline: row.headline,
        classification: row.classification,
        fantasyImpact: row.fantasy_impact,
        impactScore: Number(row.impact_score ?? 0),
        confidence: Number(row.confidence),
        summary: row.summary ?? undefined,
        firstReportedAt: row.first_reported_at ?? undefined,
        sources: row.sources ?? [],
      })),
      fetchedAt: lastIngest[0]?.latest ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        events: [],
        fetchedAt: null,
        degraded: `News could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }. This is a system fault, not an absence of news.`,
      },
      { status: 200 },
    );
  }
}
