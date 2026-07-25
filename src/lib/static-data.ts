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

  // --- ESPN, where available ------------------------------------------------
  /**
   * Average draft position in ESPN leagues. This is real ADP: an average of
   * where the player actually went. It is ESPN-only, not a cross-platform
   * consensus, and `adpSource` says so.
   */
  adp?: number;
  adpSource?: string;
  /** ESPN's own PPR draft rank. */
  espnRank?: number;
  /**
   * ESPN's player id. This is what makes live draft sync exact: picks arrive
   * from ESPN as ids, not names, and an id match cannot confuse two Franklins.
   */
  espnId?: number;
  /** Percent of ESPN leagues rostering the player. */
  percentOwned?: number;
  /**
   * ESPN's season projection as a raw stat line. Shipped as STATS, not as
   * points, so it can be scored under this league's rules rather than ESPN's.
   * Absent whenever the build could not verify ESPN's stat-id mapping.
   */
  projectedStats?: Record<string, number>;
  /**
   * The team's bye week. Absent — never zero — when the schedule has not been
   * published or the team is unknown, because a zero would read as a real week.
   */
  byeWeek?: number;
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
/**
 * A lead story plus the rest of the coverage of the same player.
 */
export interface EventGroup {
  /** Highest-impact event for this player, shown in full. */
  lead: NewsEventView;
  /** Everything else about the same player, shown compactly. */
  more: NewsEventView[];
  /** The player the group is about, or null for ungrouped items. */
  player: string | null;
}

/**
 * Collapse repeated coverage of one player into a single group.
 *
 * When something big happens, every outlet writes it up from a different
 * angle — Patrick Mahomes being cleared for camp produced seven distinct
 * events in one build: the announcement, a quote piece, a rehab retrospective,
 * an opinion column. Deduplication is right to keep them apart, because they
 * genuinely are different articles. But seven cards about one player is the
 * feed being noisy about a single fact.
 *
 * So this does not merge or discard anything. The strongest item leads, the
 * rest stay one tap away, and the count is stated. A feed that reads "Mahomes
 * — 6 more updates" says the same thing as six cards in a tenth of the space,
 * and does not bury the next player underneath it.
 *
 * Order is preserved: groups appear where their lead event appeared.
 */
export function groupByPlayer(events: NewsEventView[]): EventGroup[] {
  const groups: EventGroup[] = [];
  const byPlayer = new Map<string, EventGroup>();

  for (const event of events) {
    // The first linked player is the one the linker was most confident about.
    const player = event.players[0]?.name ?? null;

    // Unlinked items are about no one in particular; grouping them by
    // "nobody" would lump unrelated stories together.
    if (!player) {
      groups.push({ lead: event, more: [], player: null });
      continue;
    }

    const existing = byPlayer.get(player);
    if (existing) {
      existing.more.push(event);
      continue;
    }

    const group: EventGroup = { lead: event, more: [], player };
    byPlayer.set(player, group);
    groups.push(group);
  }

  return groups;
}

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
