import type { Position } from '@/lib/types';

// ============================================================================
// The static data pack.
//
// GitHub Pages serves files, not a server — but the build runs in GitHub
// Actions, which does have network access. So the data is fetched at BUILD time
// from real sources, processed by the same engine the server path uses, and
// written into the export as JSON.
//
// This is why the deployed site has real content without a backend. The
// tradeoff is stated wherever it shows: the data is as fresh as the last build,
// never fresher, and every view says so in words.
// ============================================================================

/** Where the pack lives, relative to the deployment's base path. */
export const DATA_PATH = 'data';

export interface PackMeta {
  /** ISO timestamp of the build that produced this data. */
  generatedAt: string;
  /** False when the source could not be reached during the build. */
  ok: boolean;
  /** Why it failed, when it did. Shown to the user rather than swallowed. */
  reason?: string;
  /** Per-source outcome, so partial failure is visible rather than silent. */
  sources: Array<{
    key: string;
    name: string;
    ok: boolean;
    itemCount: number;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export interface NewsSourceRef {
  name: string;
  url?: string;
  publishedAt?: string;
}

export interface NewsEventView {
  id: string;
  headline: string;
  summary?: string;
  eventType: string;
  classification: string;
  fantasyImpact: string;
  impactScore: number;
  confidence: number;
  playerDirection: string;
  positions: Position[];
  /** Players this event was confidently linked to. */
  players: Array<{ name: string; position?: Position; team?: string | null }>;
  firstReportedAt?: string;
  lastReportedAt?: string;
  sources: NewsSourceRef[];
  /** Which keyword signals fired — makes the classification explicable. */
  signals: string[];
}

export interface NewsPack extends PackMeta {
  events: NewsEventView[];
  /** Items seen before deduplication, so the dedup ratio is visible. */
  rawItemCount: number;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerPackEntry {
  id: string;
  name: string;
  position: Position;
  team: string | null;
  age?: number;
  yearsExp?: number;
  injuryStatus?: string | null;
  depthChartOrder?: number;
  /**
   * Sleeper's own popularity ordering. This is NOT consensus ADP — it is a
   * single platform's ranking, and it is labelled that way everywhere it
   * appears. Importing an ADP CSV replaces it.
   */
  sleeperRank?: number;
}

export interface PlayerPack extends PackMeta {
  season: number;
  players: PlayerPackEntry[];
}

// ---------------------------------------------------------------------------
// Loading (client side)
// ---------------------------------------------------------------------------

function dataUrl(file: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return `${base}/${DATA_PATH}/${file}`;
}

export async function loadNewsPack(): Promise<NewsPack | null> {
  try {
    const res = await fetch(dataUrl('news.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as NewsPack;
  } catch {
    return null;
  }
}

export async function loadPlayerPack(): Promise<PlayerPack | null> {
  try {
    const res = await fetch(dataUrl('players.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as PlayerPack;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers, shared by the news feed and the home briefing
// ---------------------------------------------------------------------------

export const IMPACT_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;

/** Human label for an event type. */
export function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    injury: 'Injury',
    practice: 'Practice report',
    depth_chart: 'Depth chart',
    usage: 'Usage',
    trade: 'Trade',
    signing: 'Transaction',
    suspension: 'Suspension',
    holdout: 'Holdout',
    coaching: 'Coaching',
    return: 'Return',
    other: 'Other',
  };
  return labels[type] ?? 'Other';
}

/**
 * A short, plain statement of what an event means for the player — the
 * "so what" the product exists to provide. Deliberately generated from the
 * classification rather than written by a model, so it can never overstate.
 */
export function impactSentence(event: NewsEventView): string {
  const who = event.players[0]?.name;
  const subject = who ?? 'This player';

  switch (event.playerDirection) {
    case 'STRONG_NEGATIVE':
      return event.eventType === 'injury'
        ? `${subject}'s value drops sharply if this is confirmed — plan for a replacement.`
        : `${subject} loses significant value here.`;
    case 'NEGATIVE':
      return event.eventType === 'practice'
        ? `Worth monitoring — a missed practice is a signal, not a verdict.`
        : `${subject} takes a hit, but it is not necessarily season-changing.`;
    case 'STRONG_POSITIVE':
      return `${subject} gains real value — worth moving up your board.`;
    case 'POSITIVE':
      return `${subject} trends up modestly.`;
    default:
      // Neutral direction does not mean unimportant. A trade or a signing
      // changes a player's situation enormously; what it does not do is point
      // reliably up or down until the new depth chart is known. Saying "no
      // impact" here would be actively misleading.
      if (event.eventType === 'trade' || event.eventType === 'signing') {
        return `${subject}'s situation changes materially — re-evaluate once the new depth chart and target share are clear.`;
      }
      if (event.eventType === 'coaching') {
        return 'A scheme or play-caller change can move a whole offence. Watch how usage settles.';
      }
      return 'Relevant context, but no clear directional move in value yet.';
  }
}

export function relativeTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return 'time unknown';
  const ms = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'time unknown';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Freshness of the whole pack, phrased so it never implies live data. */
export function packFreshness(
  meta: PackMeta | null,
  now = new Date(),
): { label: string; level: 'fresh' | 'aging' | 'stale' } | null {
  if (!meta) return null;
  const hours = (now.getTime() - new Date(meta.generatedAt).getTime()) / 3_600_000;
  if (Number.isNaN(hours)) return { label: 'Build time unknown', level: 'stale' };
  if (hours < 6) return { label: `Updated ${relativeTime(meta.generatedAt, now)}`, level: 'fresh' };
  if (hours < 30) return { label: `Last built ${relativeTime(meta.generatedAt, now)}`, level: 'aging' };
  return {
    label: `STALE — last built ${relativeTime(meta.generatedAt, now)}`,
    level: 'stale',
  };
}
